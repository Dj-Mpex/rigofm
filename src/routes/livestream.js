const express = require('express');
const db = require('../db/database');
const livestream = require('../services/livestream');

const router = express.Router();

// GET /api/livestream/config — stream URL + current online status (for guests)
// No auth required beyond having an active session reachable
router.get('/config', (req, res) => {
  try {
    const { streamUrl, statusUrl } = livestream.getEffectiveUrls();
    const online = livestream.getLastOnline();
    res.json({ streamUrl, statusUrl, online });
  } catch (err) {
    console.error('Livestream config error:', err);
    res.status(500).json({ error: 'Konnte Livestream-Config nicht laden' });
  }
});

// GET /api/livestream/admin — raw override values + current status (admin)
router.get('/admin', (req, res) => {
  if (req.query.adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  try {
    const rows = db.prepare(
      "SELECT key, value FROM settings WHERE key IN ('livestream_url_override','livestream_status_url_override')"
    ).all();
    const overrides = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const online = livestream.getLastOnline();
    res.json({
      streamUrl: overrides.livestream_url_override || '',
      statusUrl: overrides.livestream_status_url_override || '',
      online
    });
  } catch (err) {
    console.error('Livestream admin error:', err);
    res.status(500).json({ error: 'Konnte Livestream-Admin nicht laden' });
  }
});

// PUT /api/livestream/admin — update override values (admin)
router.put('/admin', (req, res) => {
  const { adminPassword, streamUrl, statusUrl } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  try {
    const now = Date.now();
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'livestream_url_override'")
      .run(typeof streamUrl === 'string' ? streamUrl.trim() : '', now);
    db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'livestream_status_url_override'")
      .run(typeof statusUrl === 'string' ? statusUrl.trim() : '', now);

    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastConfigChange) sockets.broadcastConfigChange();

    res.json({ success: true });
  } catch (err) {
    console.error('Livestream admin PUT error:', err);
    res.status(500).json({ error: 'Konnte Livestream-Config nicht speichern' });
  }
});

module.exports = router;
