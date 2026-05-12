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

// GET all filter settings at once
router.get('/filters', (req, res) => {
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('max_track_length','min_track_length','music_only','blocked_video_ids')").all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    let blocked = [];
    try { blocked = JSON.parse(settings.blocked_video_ids || '[]'); } catch {}
    res.json({
      max_track_length: parseInt(settings.max_track_length || '480', 10),
      min_track_length: parseInt(settings.min_track_length || '60', 10),
      music_only: settings.music_only === 'true',
      blocked_video_ids: blocked
    });
  } catch (err) {
    console.error('Get filters error:', err);
    res.status(500).json({ error: 'Konnte Filter nicht laden' });
  }
});

// PUT update filter settings
router.put('/filters', (req, res) => {
  try {
    const { max_track_length, min_track_length, music_only } = req.body;
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    if (typeof max_track_length === 'number' && max_track_length > 0) {
      update.run(String(max_track_length), 'max_track_length');
    }
    if (typeof min_track_length === 'number' && min_track_length >= 0) {
      update.run(String(min_track_length), 'min_track_length');
    }
    if (typeof music_only === 'boolean') {
      update.run(music_only ? 'true' : 'false', 'music_only');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Update filters error:', err);
    res.status(500).json({ error: 'Konnte Filter nicht speichern' });
  }
});

// POST add videoId to blocklist
router.post('/filters/block', (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId || typeof videoId !== 'string') {
      return res.status(400).json({ error: 'videoId fehlt' });
    }
    const row = db.prepare("SELECT value FROM settings WHERE key = 'blocked_video_ids'").get();
    let blocked = [];
    try { blocked = JSON.parse(row?.value || '[]'); } catch {}
    if (!blocked.includes(videoId)) blocked.push(videoId);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'blocked_video_ids'").run(JSON.stringify(blocked));
    res.json({ success: true, blocked_video_ids: blocked });
  } catch (err) {
    console.error('Block videoId error:', err);
    res.status(500).json({ error: 'Konnte nicht blockieren' });
  }
});

// DELETE remove videoId from blocklist
router.delete('/filters/block/:videoId', (req, res) => {
  try {
    const { videoId } = req.params;
    const row = db.prepare("SELECT value FROM settings WHERE key = 'blocked_video_ids'").get();
    let blocked = [];
    try { blocked = JSON.parse(row?.value || '[]'); } catch {}
    blocked = blocked.filter(v => v !== videoId);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'blocked_video_ids'").run(JSON.stringify(blocked));
    res.json({ success: true, blocked_video_ids: blocked });
  } catch (err) {
    console.error('Unblock videoId error:', err);
    res.status(500).json({ error: 'Konnte nicht entsperren' });
  }
});

module.exports = router;
