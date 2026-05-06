const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Parse Google credentials dari satu env var
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

// Rekursif: ambil semua foto dari folder + subfolder
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

// Root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// GET semua proyek
app.get('/api/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
        res.json(projects);
    } catch (e) {
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Database tidak terjangkau' });
    }
});

// GET foto berdasarkan PIN
app.get('/api/projects/:pin/photos', async (req, res) => {
    try {
        const project = await prisma.project.findUnique({ where: { pin: req.params.pin } });
        if (!project) return res.status(404).json({ error: 'PIN salah atau proyek tidak ditemukan' });

        const match = project.driveLink.match(/folders\/([a-zA-Z0-9_-]+)/);
        if (!match) return res.status(400).json({ error: 'Link Google Drive tidak valid' });

        const photos = await getAllPhotos(match[1]);
        res.json({ project, photos });
    } catch (error) {
        console.error('[DRIVE]', error.message);
        res.status(500).json({ error: 'Gagal mengambil foto dari Google Drive' });
    }
});

// POST login admin
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin') {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Username atau password salah' });
    }
});

// POST buat proyek
app.post('/api/projects', async (req, res) => {
    try {
        const { name, driveLink, pin, maxPhotos, waNumber } = req.body;
        if (!name || !driveLink || !pin) {
            return res.status(400).json({ error: 'Nama, link Drive, dan PIN wajib diisi' });
        }
        const project = await prisma.project.create({
            data: {
                name,
                driveLink,
                pin,
                maxPhotos: Number(maxPhotos) || 20,
                waNumber: waNumber || ''
            }
        });
        res.json(project);
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ error: 'PIN sudah digunakan' });
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Gagal menyimpan proyek' });
    }
});

// DELETE proyek
app.delete('/api/projects/:id', async (req, res) => {
    try {
        await prisma.project.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        console.error('[DB]', e.message);
        res.status(500).json({ error: 'Gagal menghapus proyek' });
    }
});

module.exports = app;