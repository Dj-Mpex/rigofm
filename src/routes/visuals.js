const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');

const router = express.Router();

// === Helper: parse YouTube input ===
// Returns { source_type: 'video' | 'playlist', source_id: '...' } or null
function parseYouTubeSource(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // Raw playlist ID (PL/UU/RD/FL/OL/LP prefix, at least 13 chars total)
  if (/^(PL|UU|RD|FL|OL|LP)[a-zA-Z0-9_-]{10,}$/.test(trimmed)) {
    return { source_type: 'playlist', source_id: trimmed };
  }
  // Raw 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return { source_type: 'video', source_id: trimmed };
  }

  try {
    const url = new URL(trimmed);
    const listParam = url.searchParams.get('list');
    const vParam = url.searchParams.get('v');

    // PRIORITY: if a list= param exists AND looks valid → it's a playlist
    if (listParam && /^[a-zA-Z0-9_-]{13,}$/.test(listParam)) {
      return { source_type: 'playlist', source_id: listParam };
    }

    // Otherwise: single video via v= param
    if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
      return { source_type: 'video', source_id: vParam };
    }

    // youtu.be/VIDEOID
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
        return { source_type: 'video', source_id: id };
      }
    }

    // youtube.com/embed/VIDEOID, /shorts/VIDEOID, /v/VIDEOID
    const pathMatch = url.pathname.match(/\/(embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (pathMatch) {
      return { source_type: 'video', source_id: pathMatch[2] };
    }

    // Fallback: list= param exists (even if not 13+ chars)
    if (listParam) {
      return { source_type: 'playlist', source_id: listParam };
    }
  } catch {}

  return null;
}

// === List all presets + active ===
router.get('/', (req, res) => {
  try {
    const presets = db.prepare("SELECT * FROM visuals_presets ORDER BY created_at DESC").all();
    const activeId = db.prepare("SELECT value FROM settings WHERE key = 'active_visuals_preset_id'").get()?.value || '';
    const tvSource = db.prepare("SELECT value FROM settings WHERE key = 'live_tv_source'").get()?.value || 'tracks';
    const tvMuted = db.prepare("SELECT value FROM settings WHERE key = 'live_tv_muted'").get()?.value === 'true';
    res.json({ presets, active_id: activeId, tv_source: tvSource, tv_muted: tvMuted });
  } catch (err) {
    console.error('List visuals:', err);
    res.status(500).json({ error: 'Konnte Visuals nicht laden' });
  }
});

// === Get active preset (used by TV) ===
router.get('/active', (req, res) => {
  try {
    const activeId = db.prepare("SELECT value FROM settings WHERE key = 'active_visuals_preset_id'").get()?.value || '';
    const tvSource = db.prepare("SELECT value FROM settings WHERE key = 'live_tv_source'").get()?.value || 'tracks';
    const tvMuted = db.prepare("SELECT value FROM settings WHERE key = 'live_tv_muted'").get()?.value === 'true';
    let preset = null;
    if (activeId) {
      preset = db.prepare("SELECT * FROM visuals_presets WHERE id = ?").get(activeId) || null;
    }
    res.json({ preset, tv_source: tvSource, tv_muted: tvMuted });
  } catch (err) {
    console.error('Get active visuals:', err);
    res.status(500).json({ error: 'Konnte aktives Preset nicht laden' });
  }
});

// === Set active preset ===
router.put('/active/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (id === 'none' || id === '') {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'active_visuals_preset_id'").run();
    } else {
      const exists = db.prepare("SELECT 1 FROM visuals_presets WHERE id = ?").get(id);
      if (!exists) return res.status(404).json({ error: 'Preset nicht gefunden' });
      db.prepare("UPDATE settings SET value = ? WHERE key = 'active_visuals_preset_id'").run(id);
    }
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastConfigChange) sockets.broadcastConfigChange();
    res.json({ success: true });
  } catch (err) {
    console.error('Set active visuals:', err);
    res.status(500).json({ error: 'Konnte aktives Preset nicht setzen' });
  }
});

// === Toggle TV source (tracks vs visuals) ===
router.put('/tv-source', (req, res) => {
  try {
    const { source } = req.body;
    if (source !== 'tracks' && source !== 'visuals') {
      return res.status(400).json({ error: 'source muss "tracks" oder "visuals" sein' });
    }
    db.prepare("UPDATE settings SET value = ? WHERE key = 'live_tv_source'").run(source);
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastConfigChange) sockets.broadcastConfigChange();
    res.json({ success: true, source });
  } catch (err) {
    console.error('Set tv source:', err);
    res.status(500).json({ error: 'Konnte TV-Quelle nicht umschalten' });
  }
});

// === Toggle TV mute ===
router.put('/tv-mute', (req, res) => {
  try {
    const { muted } = req.body;
    const val = muted === true ? 'true' : 'false';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'live_tv_muted'").run(val);
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastConfigChange) sockets.broadcastConfigChange();
    res.json({ success: true, muted: val === 'true' });
  } catch (err) {
    console.error('Set tv mute:', err);
    res.status(500).json({ error: 'Konnte Mute nicht umschalten' });
  }
});

// === Create preset ===
router.post('/', (req, res) => {
  try {
    const { name, source } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name fehlt' });
    if (!source || !source.trim()) return res.status(400).json({ error: 'YouTube-Quelle fehlt' });

    const parsed = parseYouTubeSource(source);
    if (!parsed) return res.status(400).json({ error: 'Ungültige YouTube-URL oder ID' });

    const id = crypto.randomUUID();
    db.prepare("INSERT INTO visuals_presets (id, name, source_type, source_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name.trim().slice(0, 60), parsed.source_type, parsed.source_id, Date.now());
    const preset = db.prepare("SELECT * FROM visuals_presets WHERE id = ?").get(id);
    res.json({ preset });
  } catch (err) {
    console.error('Create visuals preset:', err);
    res.status(500).json({ error: err.message || 'Konnte Preset nicht anlegen' });
  }
});

// === Update preset ===
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const preset = db.prepare("SELECT * FROM visuals_presets WHERE id = ?").get(id);
    if (!preset) return res.status(404).json({ error: 'Preset nicht gefunden' });

    const name = (req.body.name || preset.name).trim().slice(0, 60);
    let source_type = preset.source_type;
    let source_id = preset.source_id;

    if (req.body.source && req.body.source.trim()) {
      const parsed = parseYouTubeSource(req.body.source);
      if (!parsed) return res.status(400).json({ error: 'Ungültige YouTube-URL oder ID' });
      source_type = parsed.source_type;
      source_id = parsed.source_id;
    }

    db.prepare("UPDATE visuals_presets SET name = ?, source_type = ?, source_id = ? WHERE id = ?")
      .run(name, source_type, source_id, id);
    const updated = db.prepare("SELECT * FROM visuals_presets WHERE id = ?").get(id);
    res.json({ preset: updated });
  } catch (err) {
    console.error('Update visuals preset:', err);
    res.status(500).json({ error: err.message || 'Konnte Preset nicht aktualisieren' });
  }
});

// === Delete preset ===
router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const preset = db.prepare("SELECT * FROM visuals_presets WHERE id = ?").get(id);
    if (!preset) return res.status(404).json({ error: 'Preset nicht gefunden' });
    db.prepare("DELETE FROM visuals_presets WHERE id = ?").run(id);

    // Clear active if it was this one
    const activeId = db.prepare("SELECT value FROM settings WHERE key = 'active_visuals_preset_id'").get()?.value;
    if (activeId === id) {
      db.prepare("UPDATE settings SET value = '' WHERE key = 'active_visuals_preset_id'").run();
      db.prepare("UPDATE settings SET value = 'tracks' WHERE key = 'live_tv_source'").run();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete visuals preset:', err);
    res.status(500).json({ error: 'Konnte Preset nicht löschen' });
  }
});

module.exports = router;
