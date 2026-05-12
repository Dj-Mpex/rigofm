const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db/database');

const router = express.Router();

// Upload directory
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'dj-uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer config: PNG/JPG only, 5MB max
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${crypto.randomBytes(12).toString('hex')}${ext}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Nur PNG oder JPG erlaubt.'));
  }
});

// Serve uploaded images
router.get('/uploads/:filename', (req, res) => {
  const file = path.join(UPLOAD_DIR, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
});

// List all profiles
router.get('/', (req, res) => {
  try {
    const profiles = db.prepare("SELECT * FROM dj_profiles ORDER BY created_at DESC").all();
    const activeId = db.prepare("SELECT value FROM settings WHERE key = 'active_dj_profile_id'").get()?.value || '';
    res.json({ profiles, active_id: activeId });
  } catch (err) {
    console.error('List dj profiles:', err);
    res.status(500).json({ error: 'Konnte Profile nicht laden' });
  }
});

// Create profile
router.post('/', upload.single('logo'), (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Name fehlt' });
    }
    const id = crypto.randomUUID();
    const logoFilename = req.file ? req.file.filename : null;
    db.prepare("INSERT INTO dj_profiles (id, name, logo_filename, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name.trim().slice(0, 60), logoFilename, Date.now());
    const profile = db.prepare("SELECT * FROM dj_profiles WHERE id = ?").get(id);
    res.json({ profile });
  } catch (err) {
    console.error('Create dj profile:', err);
    res.status(500).json({ error: err.message || 'Konnte Profil nicht anlegen' });
  }
});

// Update profile (name / replace logo)
router.put('/:id', upload.single('logo'), (req, res) => {
  try {
    const { id } = req.params;
    const profile = db.prepare("SELECT * FROM dj_profiles WHERE id = ?").get(id);
    if (!profile) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Profil nicht gefunden' });
    }
    const name = (req.body.name || profile.name).trim().slice(0, 60);
    let logoFilename = profile.logo_filename;
    if (req.file) {
      // remove old logo
      if (profile.logo_filename) {
        const old = path.join(UPLOAD_DIR, profile.logo_filename);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
      logoFilename = req.file.filename;
    }
    db.prepare("UPDATE dj_profiles SET name = ?, logo_filename = ? WHERE id = ?").run(name, logoFilename, id);
    const updated = db.prepare("SELECT * FROM dj_profiles WHERE id = ?").get(id);
    res.json({ profile: updated });
  } catch (err) {
    console.error('Update dj profile:', err);
    res.status(500).json({ error: err.message || 'Konnte Profil nicht aktualisieren' });
  }
});

// Delete profile
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const profile = db.prepare("SELECT * FROM dj_profiles WHERE id = ?").get(id);
    if (!profile) return res.status(404).json({ error: 'Profil nicht gefunden' });
    if (profile.logo_filename) {
      const file = path.join(UPLOAD_DIR, profile.logo_filename);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    db.prepare("DELETE FROM dj_profiles WHERE id = ?").run(id);
    // If this was the active profile, clear it
    const active = db.prepare("SELECT value FROM settings WHERE key = 'active_dj_profile_id'").get()?.value;
    if (active === id) {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'active_dj_profile_id'").run();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete dj profile:', err);
    res.status(500).json({ error: 'Konnte Profil nicht löschen' });
  }
});

// Set active profile (the one shown on TV during live mode)
router.put('/active/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'none' || id === '') {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'active_dj_profile_id'").run();
    } else {
      const exists = db.prepare("SELECT 1 FROM dj_profiles WHERE id = ?").get(id);
      if (!exists) return res.status(404).json({ error: 'Profil nicht gefunden' });
      db.prepare("UPDATE settings SET value = ? WHERE key = 'active_dj_profile_id'").run(id);
    }
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastConfigChange) sockets.broadcastConfigChange();
    res.json({ success: true });
  } catch (err) {
    console.error('Set active dj profile:', err);
    res.status(500).json({ error: 'Konnte aktives Profil nicht setzen' });
  }
});

// Get currently active profile (used by TV)
router.get('/active', (req, res) => {
  try {
    const activeId = db.prepare("SELECT value FROM settings WHERE key = 'active_dj_profile_id'").get()?.value || '';
    if (!activeId) return res.json({ profile: null });
    const profile = db.prepare("SELECT * FROM dj_profiles WHERE id = ?").get(activeId);
    res.json({ profile: profile || null });
  } catch (err) {
    console.error('Get active dj profile:', err);
    res.status(500).json({ error: 'Konnte aktives Profil nicht laden' });
  }
});

module.exports = router;
