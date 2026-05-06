const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
const path = require('path');
const crypto = require('crypto');

const app = express();
const prisma = new PrismaClient();

// ============================================================
// 1. CORS — hanya izinkan domain sendiri
// ============================================================
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://dhi-memories-api.vercel.app'];

app.use(cors({
    origin: (origin, callback) => {
        // Izinkan jika tidak ada origin (Postman/server) atau origin ada di whitelist
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ============================================================
// 2. RATE LIMITER — manual (tanpa package tambahan)
// ============================================================
const rateLimitMap = new Map();

function rateLimit(maxRequests = 20, windowMs = 60 * 1000) {
    return (req, res, next) => {
        const key = req.headers['x-forwarded-for'] || req.ip || 'unknown';
        const now = Date.now();
        const record = rateLimitMap.get(key) || { count: 0, start: now };

        if (now - record.start > windowMs) {
            record.count = 1;
            record.start = now;
        } else {
            record.count++;
        }

        rateLimitMap.set(key, record);

        if (record.count > maxRequests) {
            return res.status(429).json({ error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
        }
        next();
    };
}

// Rate limit ketat untuk login (5x per menit)
const loginLimiter = rateLimit(5, 60 * 1000);
// Rate limit umum untuk API (60x per menit)
const apiLimiter = rateLimit(60, 60 * 1000);

app.use('/api', apiLimiter);

// ============================================================
// 3. GOOGLE DRIVE — via env variable (bukan file JSON)
// ============================================================
let credentials;
try {
    credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
} catch (e) {
    console.error('[STARTUP] GOOGLE_CREDENTIALS_JSON tidak valid:', e.message);
}

const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// ============================================================
// 4. HELPER — Hash PIN dengan SHA-256 + salt
// ============================================================
function hashPin(pin) {
    const salt = process.env.PIN_SALT || 'dhi-memories-salt-2026';
    return crypto.createHmac('sha256', salt).update(pin).digest('hex');
}

// ============================================================
// 5. MIDDLEWARE AUTENTIKASI ADMIN
// ============================================================
function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Akses ditolak. Token diperlukan.' });
    }

    const token = authHeader.split(' ')[1];
    const validToken = process.env.ADMIN_SECRET_TOKEN;

    if (!validToken || token !== validToken) {
        return res.status(403).json({ error: 'Token tidak valid.' });
    }

    next();
}

// ============================================================
// 6. INPUT SANITIZER
// ============================================================
function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[<>]/g, ''); // hapus karakter HTML berbahaya
}

function validateDriveLink(link) {
    return /^https:\/\/drive\.google\.com\/drive\/folders\/[a-zA-Z0-9_-]+/.test(link);
}

// ============================================================
// 7. AMBIL FOTO REKURSIF DARI GOOGLE DRIVE
// ============================================================
async function getAllPhotos(folderId) {
    const allPhotos = [];
    const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, thumbnailLink, mimeType)',
        pageSize: 1000,
    });
    for (const file of response.data.files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
            const subPhotos = await getAllPhotos(file.id);
            allPhotos.push(...subPhotos);
        } else if (file.mimeType.includes('image/')) {
            allPhotos.push(file);
        }
    }
    return allPhotos;
}

// ============================================================
// ROUTES
// ============================================================

// Root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// --- POST /api/login (Admin) ---
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;

    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD;

    if (!validPass) {
        return res.status(500).json({ error: 'Konfigurasi server tidak lengkap.' });
    }

    if (username === validUser && password === validPass) {
        // Kirim token ke client
        const token = process.env.ADMIN_SECRET_TOKEN;
        res.json({ success: true, token });
    } else {
        res.status(401).json({ error: 'Username atau password salah.' });
    }
});

// --- GET /api/projects (Admin only) ---
app.get('/api/projects', requireAdmin, async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            orderBy: { createdAt: 'desc' },
            select: {
                id: true, name: true, driveLink: true,
                pin: false, // jangan kembalikan hash PIN
                maxPhotos: true, waNumber: true, createdAt: true,
            }
        });
        res.json(projects);
    } catch (e) {
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Database tidak terjangkau.' });
    }
});

// --- GET /api/projects/:pin/photos (Klien) ---
app.get('/api/projects/:pin/photos', async (req, res) => {
    try {
        const pinInput = sanitize(req.params.pin);
        if (!pinInput || pinInput.length > 20) {
            return res.status(400).json({ error: 'PIN tidak valid.' });
        }

        const hashedPin = hashPin(pinInput);

        const project = await prisma.project.findUnique({
            where: { pin: hashedPin }
        });

        if (!project) {
            return res.status(404).json({ error: 'PIN salah atau proyek tidak ditemukan.' });
        }

        if (!validateDriveLink(project.driveLink)) {
            return res.status(400).json({ error: 'Link Google Drive tidak valid.' });
        }

        const match = project.driveLink.match(/folders\/([a-zA-Z0-9_-]+)/);
        const photos = await getAllPhotos(match[1]);

        // Jangan kirim driveLink & pin ke client
        res.json({
            project: {
                id: project.id,
                name: project.name,
                maxPhotos: project.maxPhotos,
                waNumber: project.waNumber,
            },
            photos
        });
    } catch (error) {
        console.error('[DRIVE]', error.message);
        res.status(500).json({ error: 'Gagal mengambil foto dari Google Drive.' });
    }
});

// --- POST /api/projects (Admin only) ---
app.post('/api/projects', requireAdmin, async (req, res) => {
    try {
        const name = sanitize(req.body.name);
        const driveLink = sanitize(req.body.driveLink);
        const pin = sanitize(req.body.pin);
        const waNumber = sanitize(req.body.waNumber || '');
        const maxPhotos = parseInt(req.body.maxPhotos) || 20;

        // Validasi wajib
        if (!name || !driveLink || !pin) {
            return res.status(400).json({ error: 'Nama, link Drive, dan PIN wajib diisi.' });
        }

        // Validasi panjang
        if (pin.length < 4 || pin.length > 20) {
            return res.status(400).json({ error: 'PIN harus 4-20 karakter.' });
        }

        // Validasi format Google Drive
        if (!validateDriveLink(driveLink)) {
            return res.status(400).json({ error: 'Format link Google Drive tidak valid.' });
        }

        // Validasi maxPhotos
        if (maxPhotos < 1 || maxPhotos > 1000) {
            return res.status(400).json({ error: 'Maksimal foto harus antara 1-1000.' });
        }

        // Hash PIN sebelum disimpan
        const hashedPin = hashPin(pin);

        const project = await prisma.project.create({
            data: { name, driveLink, pin: hashedPin, maxPhotos, waNumber }
        });

        // Jangan kembalikan hash PIN
        res.json({
            id: project.id, name: project.name,
            maxPhotos: project.maxPhotos, waNumber: project.waNumber,
            createdAt: project.createdAt
        });
    } catch (e) {
        if (e.code === 'P2002') {
            return res.status(400).json({ error: 'PIN sudah digunakan, pilih PIN lain.' });
        }
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Gagal menyimpan proyek.' });
    }
});

// --- DELETE /api/projects/:id (Admin only) ---
app.delete('/api/projects/:id', requireAdmin, async (req, res) => {
    try {
        const id = sanitize(req.params.id);
        await prisma.project.delete({ where: { id } });
        res.json({ success: true });
    } catch (e) {
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Gagal menghapus proyek.' });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint tidak ditemukan.' });
});

module.exports = app;
