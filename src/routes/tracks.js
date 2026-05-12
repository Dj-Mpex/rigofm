const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');

const router = express.Router();

const MAX_QUEUED_PER_GUEST = 10;

// Helper: Get active session or 404
function getActiveSession(res) {
  const session = db.prepare('SELECT * FROM sessions WHERE active = 1 LIMIT 1').get();
  if (!session) {
    res.status(404).json({ error: 'No active session' });
    return null;
  }
  return session;
}

// Helper: Validate guest belongs to session
function getGuest(sessionId, guestId, res) {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ? AND session_id = ?')
    .get(guestId, sessionId);
  if (!guest) {
    res.status(401).json({ error: 'Guest not found in this session' });
    return null;
  }
  return guest;
}

// Helper: Compute score for a track
function getTrackScore(trackId) {
  const row = db.prepare('SELECT COALESCE(SUM(value), 0) as score FROM votes WHERE track_id = ?')
    .get(trackId);
  return row.score;
}

// Helper: Get full queue with scores and vote info for a specific guest
function buildQueue(sessionId, guestId = null) {
  const tracks = db.prepare(`
    SELECT t.*,
      COALESCE(g.emoji, t.added_by_emoji) as added_by_emoji,
      COALESCE((SELECT SUM(value) FROM votes WHERE track_id = t.id), 0) as score
    FROM tracks t
    LEFT JOIN guests g ON g.id = t.added_by_guest_id
    WHERE t.session_id = ? AND t.status IN ('queued', 'playing')
    ORDER BY
      CASE WHEN t.status = 'playing' THEN 0 ELSE 1 END,
      CASE WHEN t.manual_order IS NULL THEN 1 ELSE 0 END,
      t.manual_order ASC,
      score DESC,
      t.created_at ASC
  `).all(sessionId);

  if (guestId) {
    const voteStmt = db.prepare('SELECT value FROM votes WHERE track_id = ? AND guest_id = ?');
    return tracks.map(t => {
      const v = voteStmt.get(t.id, guestId);
      return { ...t, myVote: v ? v.value : 0 };
    });
  }
  return tracks;
}

// GET /api/tracks/queue?guestId=...
router.get('/queue', (req, res) => {
  const session = getActiveSession(res);
  if (!session) return;

  const guestId = req.query.guestId || null;
  const queue = buildQueue(session.id, guestId);

  res.json({ queue });
});

// POST /api/tracks - Add track to queue
router.post('/', (req, res) => {
  const { guestId, youtube_id, title, artist, thumbnail, duration } = req.body;

  if (!guestId || !youtube_id || !title) {
    return res.status(400).json({ error: 'guestId, youtube_id and title are required' });
  }

  const session = getActiveSession(res);
  if (!session) return;

  const guest = getGuest(session.id, guestId, res);
  if (!guest) return;

  // Check: max queued tracks per guest
  const guestQueuedCount = db.prepare(`
    SELECT COUNT(*) as count FROM tracks
    WHERE session_id = ? AND added_by_guest_id = ? AND status IN ('queued', 'playing')
  `).get(session.id, guest.id).count;

  if (guestQueuedCount >= MAX_QUEUED_PER_GUEST) {
    return res.status(429).json({
      error: `Du hast bereits ${MAX_QUEUED_PER_GUEST} Songs in der Queue. Warte bis welche gespielt wurden.`
    });
  }

  // Check: no duplicate in current queue (queued or playing) - played is ok
  const duplicate = db.prepare(`
    SELECT id FROM tracks
    WHERE session_id = ? AND youtube_id = ? AND status IN ('queued', 'playing')
  `).get(session.id, youtube_id);

  if (duplicate) {
    return res.status(409).json({ error: 'Dieser Song ist bereits in der Queue.' });
  }

  // Apply filter rules from settings
  const dbSettings = db.prepare("SELECT key, value FROM settings WHERE key IN ('max_track_length','min_track_length','music_only','blocked_video_ids')").all();
  const settings = Object.fromEntries(dbSettings.map(r => [r.key, r.value]));
  const maxLen = parseInt(settings.max_track_length || '480', 10);
  const minLen = parseInt(settings.min_track_length || '60', 10);
  let blocked = [];
  try { blocked = JSON.parse(settings.blocked_video_ids || '[]'); } catch {}

  if (blocked.includes(youtube_id)) {
    return res.status(400).json({ error: 'Dieser Track ist blockiert.' });
  }
  if (duration && duration < minLen) {
    return res.status(400).json({ error: `Track zu kurz (min. ${Math.floor(minLen/60)} Min).` });
  }
  if (duration && duration > maxLen) {
    return res.status(400).json({ error: `Track zu lang (max. ${Math.floor(maxLen/60)} Min).` });
  }

  // Cooldown: same videoId can't be re-added within X minutes of last play
  const cooldownMin = parseInt(
    db.prepare("SELECT value FROM settings WHERE key = 'track_cooldown_minutes'").get()?.value || '60',
    10
  );
  if (cooldownMin > 0) {
    const cutoffMs = Date.now() - (cooldownMin * 60 * 1000);
    const recent = db.prepare(`
      SELECT id FROM tracks
      WHERE session_id = ?
        AND youtube_id = ?
        AND status IN ('played','playing')
        AND played_at IS NOT NULL
        AND played_at > ?
      LIMIT 1
    `).get(session.id, youtube_id, cutoffMs);
    if (recent) {
      return res.status(400).json({
        error: `Dieser Track wurde gerade erst gespielt (Cooldown: ${cooldownMin} Min). Bitte später erneut wünschen.`
      });
    }
  }

  // Also block if same videoId is already in active queue (queued/playing)
  const inQueue = db.prepare(`
    SELECT id FROM tracks
    WHERE session_id = ? AND youtube_id = ? AND status IN ('queued','playing')
    LIMIT 1
  `).get(session.id, youtube_id);
  if (inQueue) {
    return res.status(400).json({
      error: 'Dieser Track ist bereits in der Queue.'
    });
  }

  // Determine status based on session mode
  const sessionRow = db.prepare("SELECT mode FROM sessions WHERE id = ?").get(session.id);
  const isLiveDj = sessionRow?.mode === 'live-dj';
  const initialStatus = isLiveDj ? 'pending' : 'queued';

  // Capture optional guest message (only used in live-dj mode)
  const guestMessage = isLiveDj && typeof req.body.guest_message === 'string'
    ? req.body.guest_message.trim().slice(0, 200)
    : null;

  const track = {
    id: crypto.randomUUID(),
    session_id: session.id,
    youtube_id,
    title,
    artist: artist || null,
    thumbnail: thumbnail || null,
    duration: duration || null,
    added_by_guest_id: guest.id,
    added_by_name: guest.name,
    added_by_emoji: guest.emoji || null,
    status: initialStatus,
    guest_message: guestMessage,
    played_at: null,
    created_at: Date.now()
  };

  db.prepare(`
    INSERT INTO tracks (id, session_id, youtube_id, title, artist, thumbnail, duration,
                        added_by_guest_id, added_by_name, added_by_emoji,
                        status, guest_message, played_at, created_at)
    VALUES (@id, @session_id, @youtube_id, @title, @artist, @thumbnail, @duration,
            @added_by_guest_id, @added_by_name, @added_by_emoji,
            @status, @guest_message, @played_at, @created_at)
  `).run(track);

  // Auto-vote: adder gives their own track an automatic upvote
  try {
    const voteId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO votes (id, track_id, guest_id, value, created_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(voteId, track.id, guest.id, Date.now());
  } catch (e) {
    console.error('Auto-vote failed:', e.message);
  }

  req.app.locals.sockets.broadcastQueue(session.code);

  // Notify DJ if track is pending (live-dj mode)
  if (initialStatus === 'pending') {
    const sockets = req.app.locals.sockets;
    if (sockets && sockets.broadcastPendingUpdate) sockets.broadcastPendingUpdate();
  }

  res.json({ track: { ...track, score: 1, myVote: 1 } });
});

// POST /api/tracks/:id/vote - Vote on a track (value: 1, -1, or 0 to clear)
router.post('/:id/vote', (req, res) => {
  const trackId = req.params.id;
  const { guestId, value } = req.body;

  if (!guestId) {
    return res.status(400).json({ error: 'guestId is required' });
  }

  if (![1, -1, 0].includes(value)) {
    return res.status(400).json({ error: 'value must be 1, -1 or 0' });
  }

  const session = getActiveSession(res);
  if (!session) return;

  const guest = getGuest(session.id, guestId, res);
  if (!guest) return;

  const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND session_id = ?')
    .get(trackId, session.id);

  if (!track) {
    return res.status(404).json({ error: 'Track not found' });
  }

  if (track.status === 'played') {
    return res.status(400).json({ error: 'Cannot vote on already played tracks' });
  }

  // Guests cannot vote on their own added track (avoid self-pushing)
  if (track.added_by_guest_id === guest.id) {
    return res.status(403).json({ error: 'Du kannst deine eigenen Songs nicht voten.' });
  }

  if (value === 0) {
    // Clear vote
    db.prepare('DELETE FROM votes WHERE track_id = ? AND guest_id = ?')
      .run(trackId, guest.id);
  } else {
    // Upsert vote
    db.prepare(`
      INSERT INTO votes (id, track_id, guest_id, value, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(track_id, guest_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at
    `).run(crypto.randomUUID(), trackId, guest.id, value, Date.now());
  }

  const score = getTrackScore(trackId);
  req.app.locals.sockets.broadcastQueue(session.code);
  res.json({ trackId, score, myVote: value });
});

// POST /api/tracks/:id/mark-playing - Mark track as currently playing (admin or TV)
router.post('/:id/mark-playing', (req, res) => {
  const trackId = req.params.id;

  const session = getActiveSession(res);
  if (!session) return;

  // Set all other 'playing' in this session to 'played'
  db.prepare(`
    UPDATE tracks SET status = 'played', played_at = ?
    WHERE session_id = ? AND status = 'playing'
  `).run(Date.now(), session.id);

  // Mark this one as playing
  const result = db.prepare(`
    UPDATE tracks SET status = 'playing'
    WHERE id = ? AND session_id = ? AND status = 'queued'
  `).run(trackId, session.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Track not found or already played' });
  }

  req.app.locals.sockets.broadcastQueue(session.code);
  req.app.locals.sockets.broadcastTrackEvent(session.code, 'track:playing', { trackId });
  res.json({ ok: true, trackId });
});

// POST /api/tracks/:id/mark-played - Mark track as played (admin or TV when song ends)
router.post('/:id/mark-played', (req, res) => {
  const trackId = req.params.id;

  const session = getActiveSession(res);
  if (!session) return;

  const track = db.prepare('SELECT * FROM tracks WHERE id = ? AND session_id = ?')
    .get(trackId, session.id);
  if (!track) {
    return res.status(404).json({ error: 'Track not found' });
  }

  db.prepare(`
    UPDATE tracks SET status = 'played', played_at = ?
    WHERE id = ? AND session_id = ?
  `).run(Date.now(), trackId, session.id);

  req.app.locals.sockets.broadcastQueue(session.code);
  req.app.locals.sockets.broadcastTrackEvent(session.code, 'track:played', { trackId });

  res.json({ ok: true, trackId });
});

// DELETE /api/tracks/:id - Admin removes track
router.delete('/:id', (req, res) => {
  const { adminPassword } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const session = getActiveSession(res);
  if (!session) return;

  const result = db.prepare('DELETE FROM tracks WHERE id = ? AND session_id = ?')
    .run(req.params.id, session.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Track not found' });
  }

  req.app.locals.sockets.broadcastQueue(session.code);
  res.json({ ok: true });
});

// GET /api/tracks/history - Last 100 played tracks (admin)
router.get('/history', (req, res) => {
  const session = getActiveSession(res);
  if (!session) return;

  const rows = db.prepare(`
    SELECT t.id, t.youtube_id, t.title, t.artist, t.thumbnail, t.duration, t.played_at,
      COALESCE(g.name, t.added_by_name) AS added_by_name,
      COALESCE(g.emoji, t.added_by_emoji) AS added_by_emoji,
      COALESCE((SELECT SUM(v.value) FROM votes v WHERE v.track_id = t.id), 0) AS score
    FROM tracks t
    LEFT JOIN guests g ON g.id = t.added_by_guest_id
    WHERE t.session_id = ? AND t.status = 'played'
    ORDER BY t.played_at DESC
    LIMIT 100
  `).all(session.id);

  res.json({ history: rows });
});

// POST /api/tracks/reorder - Admin sets manual order for tracks
router.post('/reorder', (req, res) => {
  const { adminPassword, orderedIds } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'orderedIds must be an array' });
  }

  const session = getActiveSession(res);
  if (!session) return;

  const update = db.prepare('UPDATE tracks SET manual_order = ? WHERE id = ? AND session_id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id, session.id));
  });
  tx(orderedIds);

  req.app.locals.sockets.broadcastQueue(session.code);
  res.json({ ok: true, count: orderedIds.length });
});

// GET pending tracks (only DJ sees these)
router.get('/pending', (req, res) => {
  try {
    const session = db.prepare("SELECT id FROM sessions WHERE active = 1 LIMIT 1").get();
    if (!session) return res.json({ pending: [] });

    const rows = db.prepare(`
      SELECT
        t.*,
        COALESCE(g.emoji, t.added_by_emoji) AS added_by_emoji
      FROM tracks t
      LEFT JOIN guests g ON g.id = t.added_by_guest_id
      WHERE t.session_id = ? AND t.status = 'pending'
      ORDER BY t.created_at ASC
    `).all(session.id);

    res.json({ pending: rows });
  } catch (err) {
    console.error('Pending error:', err);
    res.status(500).json({ error: 'Konnte Pending-Liste nicht laden' });
  }
});

// POST approve a pending track
router.post('/:id/approve', (req, res) => {
  try {
    const { id } = req.params;
    const session = db.prepare("SELECT id, code FROM sessions WHERE active = 1 LIMIT 1").get();
    if (!session) return res.status(404).json({ error: 'Keine aktive Session' });

    const track = db.prepare("SELECT id, status, added_by_guest_id FROM tracks WHERE id = ? AND session_id = ?").get(id, session.id);
    if (!track) return res.status(404).json({ error: 'Track nicht gefunden' });
    if (track.status !== 'pending') return res.status(400).json({ error: 'Track ist nicht pending' });

    db.prepare("UPDATE tracks SET status = 'queued' WHERE id = ?").run(id);

    const sockets = req.app.locals.sockets;
    sockets.broadcastQueue(session.code);
    if (sockets.broadcastTrackApproved) sockets.broadcastTrackApproved(track.id, track.added_by_guest_id);
    res.json({ success: true });
  } catch (err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Konnte nicht freigeben' });
  }
});

// POST reject a pending track (optional dj_note)
router.post('/:id/reject', (req, res) => {
  try {
    const { id } = req.params;
    const { dj_note } = req.body;
    const session = db.prepare("SELECT id, code FROM sessions WHERE active = 1 LIMIT 1").get();
    if (!session) return res.status(404).json({ error: 'Keine aktive Session' });

    const track = db.prepare("SELECT id, status, added_by_guest_id FROM tracks WHERE id = ? AND session_id = ?").get(id, session.id);
    if (!track) return res.status(404).json({ error: 'Track nicht gefunden' });
    if (track.status !== 'pending') return res.status(400).json({ error: 'Track ist nicht pending' });

    const note = typeof dj_note === 'string' ? dj_note.trim().slice(0, 200) : null;
    db.prepare("UPDATE tracks SET status = 'rejected', dj_note = ? WHERE id = ?").run(note, id);

    const sockets = req.app.locals.sockets;
    sockets.broadcastQueue(session.code);
    if (sockets.broadcastTrackRejected) sockets.broadcastTrackRejected(track.id, track.added_by_guest_id);
    res.json({ success: true });
  } catch (err) {
    console.error('Reject error:', err);
    res.status(500).json({ error: 'Konnte nicht ablehnen' });
  }
});

// POST mark playing manually (DJ live mode)
router.post('/:id/mark-playing-manual', (req, res) => {
  try {
    const { id } = req.params;
    const session = db.prepare("SELECT id, code FROM sessions WHERE active = 1 LIMIT 1").get();
    if (!session) return res.status(404).json({ error: 'Keine aktive Session' });

    // Mark any currently-playing track as PLAYED (it's gone now, the DJ moved on)
    db.prepare("UPDATE tracks SET status = 'played', played_at = ? WHERE session_id = ? AND status = 'playing'").run(Date.now(), session.id);
    // Mark new track as playing
    db.prepare("UPDATE tracks SET status = 'playing', played_at = ? WHERE id = ?").run(Date.now(), id);

    req.app.locals.sockets.broadcastQueue(session.code);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark playing manual error:', err);
    res.status(500).json({ error: 'Konnte nicht markieren' });
  }
});

router.get('/history-public', (req, res) => {
  try {
    const session = db.prepare("SELECT * FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
    if (!session) return res.json({ history: [] });

    const history = db.prepare(`
      SELECT t.id, t.youtube_id, t.title, t.artist, t.thumbnail, t.added_by_name,
        COALESCE(g.emoji, t.added_by_emoji) AS added_by_emoji, t.played_at,
        COALESCE((SELECT SUM(v.value) FROM votes v WHERE v.track_id = t.id), 0) AS score
      FROM tracks t
      LEFT JOIN guests g ON g.id = t.added_by_guest_id
      WHERE t.session_id = ? AND t.status = 'played'
      ORDER BY t.played_at DESC
      LIMIT 50
    `).all(session.id);

    res.json({ history });
  } catch (err) {
    console.error('Public history:', err);
    res.status(500).json({ error: 'Verlauf konnte nicht geladen werden' });
  }
});

module.exports = router;
