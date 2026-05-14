const express = require('express');
const db = require('../db/database');

const router = express.Router();

// === Fuzzy match helpers ===
function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\(.*?\)/g, '')   // remove parenthesized extras
    .replace(/\[.*?\]/g, '')   // remove bracketed extras
    .replace(/feat\.?.*$/i, '') // remove feat. part
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fuzzyMatch(vdjArtist, vdjTitle, trackArtist, trackTitle) {
  const va = normalizeForMatch(vdjArtist);
  const vt = normalizeForMatch(vdjTitle);
  const ta = normalizeForMatch(trackArtist);
  const tt = normalizeForMatch(trackTitle);

  // We need at least one of artist or title from both sides
  if (!vt && !va) return false;
  if (!tt && !ta) return false;

  // Title match (required if both have titles)
  const titleMatch = vt && tt
    ? (vt.includes(tt) || tt.includes(vt))
    : true; // if one side lacks title, skip title check

  // Artist match (required if both have artists)
  const artistMatch = va && ta
    ? (va.includes(ta) || ta.includes(va))
    : true;

  return titleMatch && artistMatch;
}

// === Helper: get/set settings ===
function getSetting(key, fallback = '') {
  try {
    return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
  } catch { return fallback; }
}
function setSetting(key, value) {
  db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").run(String(value), Date.now(), key);
}

// === POST /api/livedj/now-playing — receives VDJ live track ===
// Auth via shared token (RIGO_VDJ_TOKEN env or admin-configured)
router.post('/now-playing', express.json({ limit: '4kb' }), (req, res) => {
  try {
    // Token check
    const expectedToken = process.env.RIGO_VDJ_TOKEN || getSetting('vdj_live_token', '');
    const provided = req.header('x-vdj-token') || req.query.token || req.body.token || '';
    if (expectedToken && provided !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { title = '', artist = '' } = req.body || {};
    if (typeof title !== 'string' || typeof artist !== 'string') {
      return res.status(400).json({ error: 'title and artist must be strings' });
    }
    const trimTitle = title.trim().slice(0, 200);
    const trimArtist = artist.trim().slice(0, 200);

    setSetting('vdj_live_title', trimTitle);
    setSetting('vdj_live_artist', trimArtist);
    setSetting('vdj_live_updated_at', String(Date.now()));

    // Broadcast via socket so TV/Admin update live
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastLiveDjTrack) {
      sockets.broadcastLiveDjTrack({ title: trimTitle, artist: trimArtist, updated_at: Date.now() });
    }

    // === Auto-Match: if session is in live-dj mode, find a matching queued track ===
    try {
      const session = db.prepare("SELECT id, code, mode FROM sessions WHERE active = 1 LIMIT 1").get();
      if (session && session.mode === 'live-dj' && (trimTitle || trimArtist)) {
        const queued = db.prepare(`
          SELECT id, title, artist FROM tracks
          WHERE session_id = ? AND status = 'queued'
          ORDER BY created_at ASC
        `).all(session.id);

        const matched = queued.find(t => fuzzyMatch(trimArtist, trimTitle, t.artist, t.title));
        if (matched) {
          db.prepare(`
            UPDATE tracks SET status = 'auto_played', played_at = ? WHERE id = ?
          `).run(Date.now(), matched.id);
          console.log(`[livedj] auto-match: "${matched.artist} - ${matched.title}" → auto_played`);
          if (sockets && sockets.broadcastQueue) {
            sockets.broadcastQueue(session.code);
          }
        }
      }
    } catch (autoErr) {
      console.error('[livedj] auto-match error:', autoErr.message);
    }

    console.log(`[livedj] now-playing: ${trimArtist} - ${trimTitle}`);
    res.json({ success: true, title: trimTitle, artist: trimArtist });
  } catch (err) {
    console.error('VDJ now-playing error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === GET /api/livedj/now-playing — read current VDJ live track ===
router.get('/now-playing', (req, res) => {
  const title = getSetting('vdj_live_title', '');
  const artist = getSetting('vdj_live_artist', '');
  const updated_at = parseInt(getSetting('vdj_live_updated_at', '0'), 10) || 0;
  const age_ms = Date.now() - updated_at;
  const stale = updated_at === 0 || age_ms > 5 * 60 * 1000; // older than 5 min = stale
  res.json({ title, artist, updated_at, stale });
});

// === Admin: get/set token ===
router.get('/admin/token', (req, res) => {
  const envToken = !!process.env.RIGO_VDJ_TOKEN;
  const dbToken = getSetting('vdj_live_token', '');
  res.json({
    env_token_set: envToken,
    db_token: dbToken,
    active: envToken ? '(from .env)' : (dbToken ? '(from DB)' : '(none)')
  });
});

router.put('/admin/token', express.json(), (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string') return res.status(400).json({ error: 'token must be a string' });
  setSetting('vdj_live_token', token.trim());
  res.json({ success: true });
});

// === Clear VDJ track (used when VDJ stops or DJ switches off live mode) ===
router.delete('/now-playing', (req, res) => {
  const expectedToken = process.env.RIGO_VDJ_TOKEN || getSetting('vdj_live_token', '');
  const provided = req.header('x-vdj-token') || req.query.token || '';
  if (expectedToken && provided !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  setSetting('vdj_live_title', '');
  setSetting('vdj_live_artist', '');
  setSetting('vdj_live_updated_at', '0');

  const sockets = req.app.locals.sockets;
  if (sockets && sockets.broadcastLiveDjTrack) {
    sockets.broadcastLiveDjTrack({ title: '', artist: '', updated_at: 0 });
  }
  res.json({ success: true });
});

module.exports = router;
