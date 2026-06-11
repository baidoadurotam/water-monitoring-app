const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

// =========================================================================
// MIDDLEWARE YANG DIPERKUAT
// =========================================================================
app.use(cors());
app.use(express.json({ strict: false, limit: '1mb' })); // Mengizinkan JSON tidak ketat
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware debugging untuk melihat raw body (tidak mengubah fungsi)
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/login') {
        console.log('📨 Raw headers:', req.headers['content-type']);
    }
    next();
});

// =========================================================================
// REDIRECT ROOT KE LOGIN PAGE
// =========================================================================
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

// =========================================================================
// CONFIGURATION: TELEGRAM BOT
// =========================================================================
const TELEGRAM_TOKEN = '8566066747:AAGEqMBRazpCQ46vF61eSBch9ZOFiE-QmUY';
const TELEGRAM_CHAT_ID = '1070417853';

async function sendTelegramNotification(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log("👉 Notifikasi Telegram berhasil dikirim!");
    } catch (error) {
        console.error("❌ Gagal mengirim notifikasi Telegram:", error.message);
    }
}

// =========================================================================
// DATABASE: SQLITE CONFIGURATION
// =========================================================================
const db = new sqlite3.Database('./monitoring_air_aquarium.db', (err) => {
    if (err) {
        console.error("❌ Gagal memuat database SQLite:", err.message);
    } else {
        console.log("💾 Terhubung ke database SQLite (monitoring_air_aquarium.db)!");
    }
});

db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suhu REAL,
    kekeruhan INTEGER,
    status TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

let lastSensorData = {
    suhu: null,
    kekeruhan: null,
    timestamp: null
};

let statusSuhuSebelumnyaAman = true;
let statusKekeruhanSebelumnyaAman = true;

// =========================================================================
// ROUTES / API ENDPOINTS
// =========================================================================

/**
 * 1. ENDPOINT LOGIN (DIPERBAIKI)
 */
app.post('/api/login', (req, res) => {
    console.log("📥 Request login - Body:", req.body);
    console.log("📥 Request login - Query:", req.query);

    // Coba ambil data dari body atau query (untuk kompatibilitas)
    let username = req.body?.username;
    let password = req.body?.password;

    // Jika masih undefined, coba dari query string
    if (!username || !password) {
        username = req.query?.username;
        password = req.query?.password;
    }

    // Jika masih kosong, kirim error jelas
    if (!username || !password) {
        return res.status(400).json({
            success: false,
            message: "Data login tidak lengkap atau format salah. Harap kirim JSON dengan field username dan password."
        });
    }

    const validUsername = 'admin';
    const validPassword = 'admin123';

    if (username === validUsername && password === validPassword) {
        return res.json({ success: true, message: 'Login berhasil' });
    } else {
        return res.json({ success: false, message: 'Username atau password salah' });
    }
});

/**
 * 2. ENDPOINT POST: MENERIMA DATA DARI ESP32
 */
app.post('/api/sensors', (req, res) => {
    const suhu = req.body.suhu !== undefined ? req.body.suhu : req.query.suhu;
    const kekeruhan = req.body.kekeruhan !== undefined ? req.body.kekeruhan : req.query.kekeruhan;

    if (suhu === undefined || kekeruhan === undefined) {
        return res.status(400).json({
            success: false,
            message: "Gagal! Data suhu atau kekeruhan tidak terkirim."
        });
    }

    const valSuhu = parseFloat(suhu);
    const valTurbid = parseInt(kekeruhan);

    let suhuAman = valSuhu >= 24 && valSuhu <= 29;
    let airBersih = valTurbid <= 25;
    let statusLingkungan = "AMAN";

    if (!airBersih) {
        statusLingkungan = "KERUH";
    } else if (!suhuAman) {
        statusLingkungan = "BAHAYA";
    }

    const waktuSekarang = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    lastSensorData = {
        suhu: valSuhu,
        kekeruhan: valTurbid,
        timestamp: waktuSekarang
    };

    const queryInsert = `INSERT INTO sensor_logs (suhu, kekeruhan, status) VALUES (?, ?, ?)`;
    db.run(queryInsert, [valSuhu, valTurbid, statusLingkungan], function(err) {
        if (err) console.error("❌ Gagal menyimpan log ke database:", err.message);
    });

    if (!airBersih && statusKekeruhanSebelumnyaAman) {
        sendTelegramNotification(`🚨 *MONITORING AIR AQUARIUM* 🚨\n\n⚠️ Air Aquarium Mendeteksi Kekeruhan Tinggi!\n💧 Kekeruhan: *${valTurbid} NTU* (Batas aman < 25 NTU)\n📢 *Saran:* Periksa kondisi saringan filter fisik.`);
        statusKekeruhanSebelumnyaAman = false;
    } else if (airBersih) {
        statusKekeruhanSebelumnyaAman = true;
    }

    if (!suhuAman && statusSuhuSebelumnyaAman) {
        sendTelegramNotification(`🚨 *MONITORING AIR AQUARIUM* 🚨\n\n⚠️ Temperatur Air Diluar Batas Ideal!\n🌡️ Suhu: *${valSuhu} °C* (Ideal: 24°C - 29°C)\n📢 *Saran:* Periksa heater atau pendingin ruangan.`);
        statusSuhuSebelumnyaAman = false;
    } else if (suhuAman) {
        statusSuhuSebelumnyaAman = true;
    }

    console.log(`📥 Data Masuk Asli dari ESP32 -> Suhu: ${valSuhu}°C, Kekeruhan: ${valTurbid} NTU [${statusLingkungan}]`);

    return res.status(200).json({
        success: true,
        message: "Data ESP32 berhasil diterima oleh Server!"
    });
});

/**
 * 3. ENDPOINT GET: Data sensor terakhir
 */
app.get('/api/sensors', (req, res) => {
    if (lastSensorData.suhu === null) {
        return res.status(404).json({ message: "Belum ada data sensor dari alat asli." });
    }
    return res.json(lastSensorData);
});

/**
 * 4. ENDPOINT GET HISTORY
 */
app.get('/api/sensors/history', (req, res) => {
    const querySelect = `SELECT timestamp as "Waktu Record", suhu as "Suhu (C)", kekeruhan as "Kekeruhan (NTU)", status as "Status" FROM sensor_logs ORDER BY id DESC LIMIT 200`;
    db.all(querySelect, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        return res.json(rows);
    });
});

/**
 * 5. ENDPOINT DELETE HISTORY
 */
app.delete('/api/sensors/history', (req, res) => {
    db.run(`DELETE FROM sensor_logs`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        console.log("🗑️ Seluruh isi database sensor_logs telah dikosongkan!");
        return res.json({ message: "Database berhasil dibersihkan!" });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan mulus di http://localhost:${PORT}`);
});
