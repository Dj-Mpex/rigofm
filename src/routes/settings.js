const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET /api/settings/filler - public, used by TV
router.get('/filler', (req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('filler_playlist_id');
  res.json({ playlistId: row ? row.value : '' });
});

// PUT /api/settings/filler - admin only
router.put('/filler', (req, res) => {
  const { adminPassword, playlistId } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const value = String(playlistId || '').trim();

  // Light validation: YouTube playlist IDs start with "PL", "OL", "UU", "FL", "RD" etc.
  // We allow empty (= disable filler) or any plausible string up to 100 chars
  if (value.length > 100) {
    return res.status(400).json({ error: 'Playlist ID too long' });
  }
  if (value && !/^[A-Za-z0-9_-]+$/.test(value)) {
    return res.status(400).json({ error: 'Invalid playlist ID format' });
  }

  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run('filler_playlist_id', value, Date.now());

  // Notify all clients (TV) about config change
  if (req.app.locals.sockets && req.app.locals.sockets.broadcastConfigChange) {
    req.app.locals.sockets.broadcastConfigChange();
  }

  res.json({ ok: true, playlistId: value });
});

module.exports = router;
