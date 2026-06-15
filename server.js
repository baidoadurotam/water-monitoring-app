const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ strict: false, limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/login.html'));

// ================= TELEGRAM =================
const TELEGRAM_TOKEN = '8566066747:AAGEqMBRazpCQ46vF61eSBch9ZOFiE-QmUY';
const TELEGRAM_CHAT_ID = '1070417853';

// Variabel global untuk mengaktifkan/mematikan notifikasi
let telegramNotifEnabled = true; // default: nyala

async function sendTelegramNotification(message) {
    if (!telegramNotifEnabled) {
        console.log("🔕 Notifikasi Telegram dimatikan oleh admin.");
        return false;
    }
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("❌ Token atau Chat ID Telegram tidak dikonfigurasi!");
        return false;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const response = await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        if (response.data && response.data.ok) {
            console.log("👉 Notifikasi Telegram berhasil dikirim!");
            return true;
        } else {
            console.log("⚠️ Notifikasi Telegram gagal: response tidak ok", response.data);
            return false;
        }
    } catch (error) {
        console.error("❌ Gagal mengirim notifikasi Telegram:", error.response?.data || error.message);
        return false;
    }
}

// Endpoint untuk mendapatkan status notifikasi (GET)
app.get('/api/telegram/status', (req, res) => {
    res.json({ enabled: telegramNotifEnabled });
});

// Endpoint untuk toggle notifikasi (POST) – hanya admin
app.post('/api/telegram/toggle', (req, res) => {
    const { enabled, role } = req.body;
    if (role !== 'admin') {
        return res.status(403).json({ success: false, message: "Hanya admin yang bisa mengubah setting notifikasi" });
    }
    if (typeof enabled === 'boolean') {
        telegramNotifEnabled = enabled;
        console.log(`🔔 Notifikasi Telegram diatur menjadi: ${telegramNotifEnabled ? 'ON' : 'OFF'}`);
        res.json({ success: true, enabled: telegramNotifEnabled });
    } else {
        res.status(400).json({ success: false, message: "Nilai 'enabled' harus boolean" });
    }
});

// ================= DATABASE =================
const db = new sqlite3.Database('./monitoring_air_aquarium.db', (err) => {
    if (err) console.error("❌ Gagal memuat database:", err.message);
    else console.log("💾 Terhubung ke database SQLite!");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suhu REAL,
        kekeruhan INTEGER,
        status TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'viewer'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS thresholds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suhu_min REAL DEFAULT 24.0,
        suhu_max REAL DEFAULT 29.0,
        ntu_max INTEGER DEFAULT 25,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS calibration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slope_m REAL,
        intercept_c REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Migrasi kolom created_at (tanpa default)
    db.all("PRAGMA table_info(users)", (err, columns) => {
        if (!err && columns && Array.isArray(columns)) {
            const hasCreatedAt = columns.some(col => col.name === 'created_at');
            if (!hasCreatedAt) {
                db.run("ALTER TABLE users ADD COLUMN created_at DATETIME", (err2) => {
                    if (!err2) console.log("✅ Kolom created_at berhasil ditambahkan ke tabel users");
                    else console.error("❌ Gagal menambah kolom created_at:", err2.message);
                });
            }
        }
    });

    // User admin default
    db.get(`SELECT * FROM users WHERE role = 'admin' LIMIT 1`, (err, row) => {
        if (!row) {
            const hashed = crypto.createHash('sha256').update('admin123').digest('hex');
            db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, ['admin', hashed, 'admin']);
            console.log("✅ User admin default dibuat (admin/admin123)");
        }
    });

    // Thresholds default
    db.get(`SELECT * FROM thresholds LIMIT 1`, (err, row) => {
        if (!row) db.run(`INSERT INTO thresholds (suhu_min, suhu_max, ntu_max) VALUES (24.0, 29.0, 25)`);
    });
});

// ================= FUNGSI BANTU =================
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function getThresholds() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT suhu_min, suhu_max, ntu_max FROM thresholds ORDER BY id DESC LIMIT 1`, (err, row) => {
            if (err || !row) reject(err);
            else resolve(row);
        });
    });
}

// Variabel global untuk status perubahan dan prediksi
let lastStatus = null;
let previousSensorData = null;
global.lastSensorData = { suhu: null, kekeruhan: null, timestamp: null };

// ================= ENDPOINT LOGIN =================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Username dan password wajib diisi" });
    const hashed = hashPassword(password);
    db.get(`SELECT username, role FROM users WHERE username = ? AND password_hash = ?`, [username, hashed], (err, row) => {
        if (err || !row) return res.json({ success: false, message: "Username atau password salah" });
        res.json({ success: true, message: "Login berhasil", role: row.role, username: row.username });
    });
});

// ================= USER MANAGEMENT =================
app.get('/api/users', (req, res) => {
    const { role } = req.query;
    if (role !== 'admin') return res.status(403).json({ success: false, message: "Akses ditolak, hanya admin" });
    db.all(`SELECT id, username, role, COALESCE(created_at, '-') as created_at FROM users ORDER BY id ASC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/users', (req, res) => {
    const { username, password, role, adminRole } = req.body;
    if (adminRole !== 'admin') return res.status(403).json({ success: false, message: "Hanya admin yang bisa menambah user" });
    if (!username || !password) return res.status(400).json({ success: false, message: "Username dan password wajib diisi" });
    if (password.length < 4) return res.status(400).json({ success: false, message: "Password minimal 4 karakter" });
    const hashed = hashPassword(password);
    const userRole = (role === 'admin') ? 'admin' : 'viewer';
    db.run(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`, [username, hashed, userRole], function(err) {
        if (err) return res.status(409).json({ success: false, message: err.message.includes('UNIQUE') ? "Username sudah terdaftar" : err.message });
        res.json({ success: true, message: `User ${username} berhasil ditambahkan sebagai ${userRole}` });
    });
});

app.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { username, password, role, adminRole } = req.body;
    if (adminRole !== 'admin') return res.status(403).json({ success: false, message: "Hanya admin yang bisa mengedit user" });
    let updates = [], params = [];
    if (username) { updates.push("username = ?"); params.push(username); }
    if (password) {
        if (password.length < 4) return res.status(400).json({ success: false, message: "Password minimal 4 karakter" });
        updates.push("password_hash = ?"); params.push(hashPassword(password));
    }
    if (role && (role === 'admin' || role === 'viewer')) { updates.push("role = ?"); params.push(role); }
    if (updates.length === 0) return res.status(400).json({ success: false, message: "Tidak ada data yang diubah" });
    params.push(id);
    db.run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params, function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (this.changes === 0) return res.status(404).json({ success: false, message: "User tidak ditemukan" });
        res.json({ success: true, message: "User berhasil diperbarui" });
    });
});

app.delete('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { adminRole } = req.body;
    if (adminRole !== 'admin') return res.status(403).json({ success: false, message: "Hanya admin yang bisa menghapus user" });
    db.run(`DELETE FROM users WHERE id = ? AND role != 'admin'`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(400).json({ success: false, message: "User tidak ditemukan atau tidak boleh menghapus admin" });
        res.json({ success: true, message: "User berhasil dihapus" });
    });
});

// ================= THRESHOLDS =================
app.get('/api/thresholds', async (req, res) => {
    try { res.json(await getThresholds()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/thresholds', async (req, res) => {
    const { suhu_min, suhu_max, ntu_max, role } = req.body;
    if (role !== 'admin') return res.status(403).json({ success: false, message: "Hanya admin yang bisa mengubah ambang batas" });
    db.run(`INSERT INTO thresholds (suhu_min, suhu_max, ntu_max) VALUES (?, ?, ?)`, [suhu_min, suhu_max, ntu_max], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: "Ambang batas diperbarui" });
    });
});

// ================= KALIBRASI =================
app.post('/api/calibration', async (req, res) => {
    const { adc_clear, adc_turbid, ntu_turbid, esp32_ip, role } = req.body;
    if (role !== 'admin') return res.status(403).json({ success: false, message: "Hanya admin yang bisa kalibrasi" });
    if (!adc_clear || !adc_turbid || !ntu_turbid) return res.status(400).json({ success: false, message: "Data ADC dan NTU wajib diisi" });
    const m = ntu_turbid / (adc_turbid - adc_clear);
    const c = -m * adc_clear;
    db.run(`INSERT INTO calibration (slope_m, intercept_c) VALUES (?, ?)`, [m, c], async (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        let esp32Response = null;
        if (esp32_ip) {
            try {
                const response = await axios.post(`http://${esp32_ip}/api/calibration`, { slope_m: m, intercept_c: c }, { timeout: 5000 });
                esp32Response = response.data;
            } catch (error) { esp32Response = { error: "Tidak dapat mengirim ke ESP32" }; }
        }
        res.json({ success: true, slope_m: m, intercept_c: c, esp32_response: esp32Response });
    });
});

// ================= SENSOR DATA =================
app.post('/api/sensors', async (req, res) => {
    const suhu = req.body.suhu !== undefined ? req.body.suhu : req.query.suhu;
    const kekeruhan = req.body.kekeruhan !== undefined ? req.body.kekeruhan : req.query.kekeruhan;
    if (suhu === undefined || kekeruhan === undefined) return res.status(400).json({ success: false, message: "Data tidak lengkap" });
    const valSuhu = parseFloat(suhu);
    const valNtu = parseInt(kekeruhan);
    const now = new Date();
    const timestampStr = now.toISOString();
    const timestampMs = now.getTime();
    const thresholds = await getThresholds();
    const suhuAman = (valSuhu >= thresholds.suhu_min && valSuhu <= thresholds.suhu_max);
    const airBersih = (valNtu <= thresholds.ntu_max);
    let statusLingkungan = "AMAN";
    if (!airBersih) statusLingkungan = "KERUH";
    else if (!suhuAman) statusLingkungan = "BAHAYA";

    db.run(`INSERT INTO sensor_logs (suhu, kekeruhan, status, timestamp) VALUES (?, ?, ?, ?)`, [valSuhu, valNtu, statusLingkungan, timestampStr]);
    global.lastSensorData = { suhu: valSuhu, kekeruhan: valNtu, timestamp: now.toLocaleTimeString() };

    // Notifikasi perubahan status
    if (lastStatus !== statusLingkungan) {
        console.log(`🔄 Status berubah: ${lastStatus} → ${statusLingkungan}`);
        let message = '';
        if (statusLingkungan === 'AMAN') message = `✅ *KONDISI NORMAL* ✅\nAir aquarium kembali dalam kondisi AMAN.\nSuhu: ${valSuhu}°C\nKekeruhan: ${valNtu} NTU`;
        else if (statusLingkungan === 'KERUH') message = `⚠️ *PERINGATAN KERUHAN* ⚠️\nAir aquarium terdeteksi KERUH!\nKekeruhan: ${valNtu} NTU (batas normal < ${thresholds.ntu_max})`;
        else message = `🚨 *BAHAYA* 🚨\nSuhu air di luar batas normal!\nSuhu: ${valSuhu}°C (ideal ${thresholds.suhu_min}-${thresholds.suhu_max})`;
        sendTelegramNotification(message);
        lastStatus = statusLingkungan;
    }

    // Prediksi rate of change
    if (previousSensorData) {
        const timeDiff = (timestampMs - previousSensorData.timestamp_ms) / 60000;
        if (timeDiff > 0 && timeDiff < 10) {
            const suhuRate = (valSuhu - previousSensorData.suhu) / timeDiff;
            const ntuRate = (valNtu - previousSensorData.ntu) / timeDiff;
            if (suhuRate > 0.5) sendTelegramNotification(`🚨 *PREDIKSI DINI* 🚨\n⚠️ Kenaikan suhu cepat: ${suhuRate.toFixed(2)}°C/menit (melebihi 0.5°C/menit)`);
            else if (suhuRate < -0.5) sendTelegramNotification(`🚨 *PREDIKSI DINI* 🚨\n⚠️ Penurunan suhu cepat: ${Math.abs(suhuRate).toFixed(2)}°C/menit`);
            if (ntuRate > 5) sendTelegramNotification(`🚨 *PREDIKSI DINI* 🚨\n⚠️ Kekeruhan naik drastis: ${ntuRate.toFixed(2)} NTU/menit (potensi bloom bakteri)`);
        }
    }
    previousSensorData = { suhu: valSuhu, ntu: valNtu, timestamp_ms: timestampMs };
    console.log(`📥 Data dari ESP32 -> Suhu: ${valSuhu}°C, Kekeruhan: ${valNtu} NTU [${statusLingkungan}]`);
    res.json({ success: true, message: "Data diterima" });
});

// ================= GET SENSOR =================
app.get('/api/sensors', (req, res) => {
    if (global.lastSensorData && global.lastSensorData.suhu !== null) res.json(global.lastSensorData);
    else res.status(404).json({ message: "Belum ada data sensor" });
});

// ================= HISTORY =================
app.get('/api/sensors/history', (req, res) => {
    db.all(`SELECT timestamp as "Waktu Record", suhu as "Suhu (C)", kekeruhan as "Kekeruhan (NTU)", status as "Status" FROM sensor_logs ORDER BY id DESC LIMIT 200`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.delete('/api/sensors/history', (req, res) => {
    db.run(`DELETE FROM sensor_logs`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Riwayat berhasil dihapus" });
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    lastStatus = null;
    previousSensorData = null;
});
