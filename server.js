const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const prisma = new PrismaClient();

// KONFIGURASI PENTING: Mengizinkan akses dari browser
app.use(cors({
    origin: '*', // Mengizinkan semua akses selama tahap pengembangan
    methods: ['GET', 'POST', 'DELETE']
}));
app.use(express.json());

// Inisialisasi Google Drive dengan path yang benar
const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-credentials.json'), 
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

// --- ENDPOINT API ---

app.get('/api/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
        res.json(projects);
    } catch (e) {
        res.status(500).json({ error: "Database tidak terjangkau" });
    }
});

app.get('/api/projects/:pin/photos', async (req, res) => {
    try {
        const project = await prisma.project.findUnique({ where: { pin: req.params.pin } });
        if (!project) return res.status(404).json({ error: "PIN Salah atau Proyek tidak ditemukan" });

        const match = project.driveLink.match(/folders\/([a-zA-Z0-9_-]+)/);
        if (!match) return res.status(400).json({ error: "Link Drive tidak valid" });
        
        const folderId = match[1];
        const response = await drive.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name, thumbnailLink)',
            pageSize: 1000
        });

        res.json({ project, photos: response.data.files });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Gagal mengambil data dari Google Drive" });
    }
});

// Endpoint Admin lainnya (Login, Create, Delete) tetap sama...
app.post('/api/login', (req, res) => {
    if (req.body.username === 'admin' && req.body.password === 'admin') res.json({ success: true });
    else res.status(401).json({ error: 'Unauthorized' });
});

app.post('/api/projects', async (req, res) => {
    try {
        const { name, driveLink, pin, maxPhotos } = req.body;
        const project = await prisma.project.create({ data: { name, driveLink, pin, maxPhotos: Number(maxPhotos) } });
        res.json(project);
    } catch (e) { res.status(500).json({ error: 'Gagal simpan' }); }
});

const PORT = 5000;
app.listen(PORT, () => { 
    console.log(`=================================`);
    console.log(`[SERVER] Dhi Memories API Active`);
    console.log(`[URL] http://localhost:${PORT}`);
    console.log(`=================================`);
});