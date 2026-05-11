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
      COALESCE((SELECT SUM(value) FROM votes WHERE track_id = t.id), 0) as score
    FROM tracks t
    WHERE t.session_id = ? AND t.status IN ('queued', 'playing')
    ORDER BY
      CASE WHEN t.status = 'playing' THEN 0 ELSE 1 END,
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
    status: 'queued',
    played_at: null,
    created_at: Date.now()
  };

  db.prepare(`
    INSERT INTO tracks (id, session_id, youtube_id, title, artist, thumbnail, duration,
                        added_by_guest_id, added_by_name, status, played_at, created_at)
    VALUES (@id, @session_id, @youtube_id, @title, @artist, @thumbnail, @duration,
            @added_by_guest_id, @added_by_name, @status, @played_at, @created_at)
  `).run(track);

  res.json({ track: { ...track, score: 0, myVote: 0 } });
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

  res.json({ ok: true, trackId });
});

// POST /api/tracks/:id/mark-played - Mark track as played (admin or TV when song ends)
router.post('/:id/mark-played', (req, res) => {
  const trackId = req.params.id;

  const session = getActiveSession(res);
  if (!session) return;

  const result = db.prepare(`
    UPDATE tracks SET status = 'played', played_at = ?
    WHERE id = ? AND session_id = ?
  `).run(Date.now(), trackId, session.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Track not found' });
  }

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

  res.json({ ok: true });
});

module.exports = router;
