const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

// Inisialisasi Express & Prisma
const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());

// Izinkan server membaca file HTML statis di folder saat ini (Untuk Vercel)
app.use(express.static(__dirname));

// ==========================================
// KONFIGURASI GOOGLE DRIVE API (VERCEL READY)
// Menggunakan Environment Variables, bukan file JSON fisik
// ==========================================
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        // Replace digunakan untuk memperbaiki format enter (\n) yang sering rusak di string ENV Vercel
        private_key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});

const drive = google.drive({ version: 'v3', auth });

// Fungsi utilitas untuk mengekstrak ID Folder dari URL Google Drive
function extractFolderId(link) {
    const match = link.match(/folders\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    
    // Fallback jika format link menggunakan ?id=
    try {
        const url = new URL(link);
        return url.searchParams.get('id');
    } catch (e) {
        return null;
    }
}

// ==========================================
// ROUTE FRONTEND (Menampilkan Halaman Web)
// ==========================================
// Menjadi lebih kuat seperti ini:
// Route Utama untuk Halaman Klien
app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'client.html'));
});

// Route untuk Halaman Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'admin.html'));
});

// ==========================================
// ROUTE API BACKEND (Logika Bisnis)
// ==========================================

// 1. Mengambil semua proyek (Untuk halaman Admin)
app.get('/api/projects', async (req, res) => {
    try {
        const projects = await prisma.project.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json(projects);
    } catch (error) {
        console.error("Error fetching projects:", error);
        res.status(500).json({ error: "Gagal mengambil data proyek dari database." });
    }
});

// 2. Membuat proyek baru (Untuk halaman Admin)
app.post('/api/projects', async (req, res) => {
    try {
        const { name, driveLink, pin, maxPhotos } = req.body;
        const newProject = await prisma.project.create({
            data: { name, driveLink, pin, maxPhotos: parseInt(maxPhotos) }
        });
        res.json(newProject);
    } catch (error) {
        console.error("Error creating project:", error);
        if (error.code === 'P2002') {
            res.status(400).json({ error: "PIN tersebut sudah digunakan. Silakan gunakan PIN lain." });
        } else {
            res.status(500).json({ error: "Gagal menyimpan proyek ke database." });
        }
    }
});

// 3. Menghapus proyek (Untuk halaman Admin)
app.delete('/api/projects/:id', async (req, res) => {
    try {
        await prisma.project.delete({
            where: { id: req.params.id }
        });
        res.json({ message: "Proyek berhasil dihapus." });
    } catch (error) {
        console.error("Error deleting project:", error);
        res.status(500).json({ error: "Gagal menghapus proyek." });
    }
});

// 4. KLIEN: Memvalidasi PIN dan Mengambil Foto dari Google Drive
app.get('/api/projects/:pin/photos', async (req, res) => {
    try {
        // Cari proyek berdasarkan PIN di Supabase
        const project = await prisma.project.findUnique({
            where: { pin: req.params.pin }
        });

        if (!project) {
            return res.status(404).json({ error: "PIN tidak ditemukan atau salah." });
        }

        // Ekstrak ID Folder dari link yang tersimpan
        const folderId = extractFolderId(project.driveLink);
        if (!folderId) {
            return res.status(400).json({ error: "Format link Google Drive tidak valid." });
        }

        // Tarik data foto dari Google Drive API
        const response = await drive.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name, thumbnailLink)',
            pageSize: 1000  // Katup kuota maksimal Google Drive API
        });

        res.json({
            project: {
                name: project.name,
                maxPhotos: project.maxPhotos
            },
            photos: response.data.files
        });

    } catch (error) {
        console.error("Error API Drive:", error);
        res.status(500).json({ error: "Gagal mengakses folder Google Drive. Pastikan folder sudah dibagikan ke email Service Account." });
    }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`[SERVER] Dhi Memories API Active on port ${PORT}`);
});

// Wajib diekspor agar Vercel Serverless Functions bisa membaca mesin Express ini
module.exports = app;