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

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// ✅ Fungsi rekursif: ambil semua foto dari folder + semua subfoldernya
async function getAllPhotos(folderId) {
    const allPhotos = [];

    const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name, thumbnailLink, mimeType)',
        pageSize: 1000,
    });

    for (const file of response.data.files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
            // Masuk ke subfolder secara rekursif
            const subPhotos = await getAllPhotos(file.id);
            allPhotos.push(...subPhotos);
        } else if (file.mimeType.includes('image/')) {
            allPhotos.push(file);
        }
    }

    return allPhotos;
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/api/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
        res.json(projects);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database tidak terjangkau' });
    }
});

app.get('/api/projects/:pin/photos', async (req, res) => {
    try {
        const project = await prisma.project.findUnique({ where: { pin: req.params.pin } });
        if (!project) return res.status(404).json({ error: 'PIN Salah atau Proyek tidak ditemukan' });

        const match = project.driveLink.match(/folders\/([a-zA-Z0-9_-]+)/);
        if (!match) return res.status(400).json({ error: 'Link Drive tidak valid' });

        const folderId = match[1];
        console.log('[DRIVE] Mengambil folder (+ subfolder):', folderId);

        const photos = await getAllPhotos(folderId);
        console.log('[DRIVE] Total foto ditemukan:', photos.length);

        res.json({ project, photos });
    } catch (error) {
        console.error('[DRIVE ERROR]', error.message);
        res.status(500).json({ error: 'Gagal mengambil data dari Google Drive', detail: error.message });
    }
});

app.post('/api/login', (req, res) => {
    if (req.body.username === 'admin' && req.body.password === 'admin') res.json({ success: true });
    else res.status(401).json({ error: 'Unauthorized' });
});

app.post('/api/projects', async (req, res) => {
    try {
        const { name, driveLink, pin, maxPhotos } = req.body;
        if (!name || !driveLink || !pin) return res.status(400).json({ error: 'Field wajib diisi' });
        const project = await prisma.project.create({
            data: { name, driveLink, pin, maxPhotos: Number(maxPhotos) || 20 }
        });
        res.json(project);
    } catch (e) {
        if (e.code === 'P2002') return res.status(400).json({ error: 'PIN sudah digunakan' });
        res.status(500).json({ error: 'Gagal menyimpan proyek' });
    }
});

app.delete('/api/projects/:id', async (req, res) => {
    try {
        await prisma.project.delete({ where: { id: req.params.id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Gagal menghapus proyek' });
    }
});

module.exports = app;