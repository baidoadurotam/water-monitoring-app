const express = require('express');
const mqtt = require('mqtt');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
// Mengizinkan Express membaca file statis (HTML, JS, CSS) dari folder 'public'
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. KONFIGURASI INFLUXDB (LAPTOP 1)
// ==========================================
const url = 'http://192.168.100.211:8086'; 
const token = 's0zCvnqqEjbw_1stSHAin7ZrpJeRrVUgEY31ajJqk2bzjNiuDVrSvfwEZ15y_RWqKJrQphxhUKVMJjEYWnHavQ==';
const org = 'water-monitoring';
const bucket = 'water-monitoring';

const influxDB = new InfluxDB({ url, token });
const writeApi = influxDB.getWriteApi(org, bucket, 's'); // 's' artinya menggunakan timestamp detik

// ==========================================
// 2. KONFIGURASI MQTT BROKER (LAPTOP 1)
// ==========================================
const mqttClient = mqtt.connect('mqtt://192.168.100.211:1883');

mqttClient.on('connect', () => {
    console.log('Subscribed & Terhubung ke MQTT Broker di Laptop 1');
    mqttClient.subscribe('monitoring/air');
});

// ==========================================
// 3. WEBSOCKET SERVER (UNTUK DASHBOARD REALTIME)
// ==========================================
const wss = new WebSocket.Server({ noServer: true });

// Logika ketika data masuk dari ESP32 via MQTT
mqttClient.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        console.log("Data Diterima dari ESP32:", data);

        // A. Simpan ke InfluxDB
        const point = new Point('kualitas_air')
            .tag('device_id', data.id)
            .floatField('suhu', parseFloat(data.suhu))
            .floatField('kekeruhan', parseFloat(data.kekeruhan))
            .timestamp(data.timestamp); // Menggunakan timestamp dari ESP32

        writeApi.writePoint(point);
        writeApi.flush();

        // B. Kirim Realtime ke Browser via WebSocket
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    } catch (err) {
        console.error("Gagal memproses data MQTT:", err);
    }
});

// ==========================================
// 4. API & ROUTING (LOGIN & HISTORY)
// ==========================================
// Endpoint Login Sederhana
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Username atau Password Salah!' });
    }
});

// Endpoint Ambil Riwayat Data dari InfluxDB
app.get('/api/history', async (req, res) => {
    const queryApi = influxDB.getQueryApi(org);
    // Query Flux untuk mengambil data 1 jam terakhir
    const fluxQuery = `from(bucket: "${bucket}") 
        |> range(start: -1h) 
        |> filter(fn: (r) => r["_measurement"] == "kualitas_air")`;
    
    let results = [];
    try {
        queryApi.queryRows(fluxQuery, {
            next(row, tableMeta) {
                const o = tableMeta.toObject(row);
                results.push({ waktu: o._time, objek: o._field, nilai: o._value });
            },
            error(error) {
                res.status(500).json({ error: error.message });
            },
            complete() {
                res.json(results);
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Jalankan HTTP Server di Port 3000
const server = app.listen(3000, () => console.log('Web App berjalan di port 3000'));

// Gabungkan HTTP Server dengan WebSocket
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});