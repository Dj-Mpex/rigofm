const express = require('express');
const crypto = require('crypto');
const { nanoid, customAlphabet } = require('nanoid');
const db = require('../db/database');

const router = express.Router();

// Short, readable session code (uppercase, no ambiguous chars)
const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

// POST /api/sessions - Create new party session (admin)
router.post('/', (req, res) => {
  const { name, adminPassword } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  // Deactivate all existing active sessions
  db.prepare('UPDATE sessions SET active = 0, ended_at = ? WHERE active = 1')
    .run(Date.now());

  const session = {
    id: nanoid(),
    code: generateCode(),
    name: name || 'Rigo Party',
    active: 1,
    created_at: Date.now(),
    ended_at: null
  };

  db.prepare(`
    INSERT INTO sessions (id, code, name, active, created_at, ended_at)
    VALUES (@id, @code, @name, @active, @created_at, @ended_at)
  `).run(session);

  res.json({ session });
});

// GET /api/sessions/active - Get currently active session
router.get('/active', (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE active = 1 LIMIT 1').get();

  if (!session) {
    return res.status(404).json({ error: 'No active session' });
  }

  const guestCount = db.prepare('SELECT COUNT(*) as count FROM guests WHERE session_id = ?')
    .get(session.id).count;
  const trackCount = db.prepare('SELECT COUNT(*) as count FROM tracks WHERE session_id = ?')
    .get(session.id).count;

  res.json({
    session: { ...session, guestCount, trackCount }
  });
});

// GET /api/sessions/by-code/:code - Lookup session by code (for QR landing)
router.get('/by-code/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const session = db.prepare('SELECT id, code, name, active FROM sessions WHERE code = ? AND active = 1').get(code);

  if (!session) {
    return res.status(404).json({ error: 'Session not found or ended' });
  }

  res.json({ session });
});

// Party emoji pool — playful, party-themed
const PARTY_EMOJIS = [
  '🎉','🎊','🥳','🍻','🍾','🎶','🎵','🎸','🎤','🎷','🎺','🥁','🎹',
  '💃','🕺','🪩','🔥','⚡','✨','🌟','💥','🚀','🎮','🎲','🎯','🎪',
  '🦄','🐉','🦖','🐙','🦊','🦁','🐯','🐺','🦋','🦩','🌈','🍕','🌮',
  '🌶️','🍔','🍩','🍪','🧁','🍦','🌵','🌴','🍒'
];

function pickEmoji() {
  const buf = crypto.randomBytes(2);
  const idx = buf.readUInt16BE(0) % PARTY_EMOJIS.length;
  return PARTY_EMOJIS[idx];
}

// POST /api/sessions/:code/join - Guest joins with name + deviceId
router.post('/:code/join', (req, res) => {
  const code = req.params.code.toUpperCase();
  const name = (req.body.name || '').trim().slice(0, 30);
  const deviceId = (req.body.deviceId || '').trim().slice(0, 64);

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID is required' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE code = ? AND active = 1').get(code);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or ended' });
  }

  // Check 1: Has this device already joined this session?
  const existingByDevice = db.prepare(
    'SELECT * FROM guests WHERE session_id = ? AND device_id = ?'
  ).get(session.id, deviceId);

  if (existingByDevice) {
    // Same device returning -> use existing guest (allow name update if different)
    if (existingByDevice.name !== name) {
      // Allow rename only if new name isn't taken by another guest
      const nameClash = db.prepare(
        'SELECT id FROM guests WHERE session_id = ? AND LOWER(name) = LOWER(?) AND id != ?'
      ).get(session.id, name, existingByDevice.id);

      if (nameClash) {
        return res.status(409).json({ error: 'Dieser Name ist schon vergeben. Wähle einen anderen.' });
      }
      db.prepare('UPDATE guests SET name = ? WHERE id = ?').run(name, existingByDevice.id);
      existingByDevice.name = name;
    }
    return res.json({
      guest: existingByDevice,
      session: { id: session.id, code: session.code, name: session.name },
      reused: true
    });
  }

  // Check 2: Is the name already taken in this session (case-insensitive)?
  const nameClash = db.prepare(
    'SELECT id FROM guests WHERE session_id = ? AND LOWER(name) = LOWER(?)'
  ).get(session.id, name);

  if (nameClash) {
    return res.status(409).json({ error: 'Dieser Name ist schon vergeben. Wähle einen anderen.' });
  }

  // New guest
  const guest = {
    id: crypto.randomUUID(),
    session_id: session.id,
    name,
    device_id: deviceId,
    emoji: pickEmoji(),
    created_at: Date.now()
  };

  db.prepare(`
    INSERT INTO guests (id, session_id, name, device_id, emoji, created_at)
    VALUES (@id, @session_id, @name, @device_id, @emoji, @created_at)
  `).run(guest);

  res.json({
    guest,
    session: { id: session.id, code: session.code, name: session.name },
    reused: false
  });
});

// POST /api/sessions/end - End active session (admin)
router.post('/end', (req, res) => {
  const { adminPassword } = req.body;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const result = db.prepare('UPDATE sessions SET active = 0, ended_at = ? WHERE active = 1')
    .run(Date.now());

  res.json({ ended: result.changes });
});

// GET /api/sessions/active/guests - List guests of active session (admin)
router.get('/active/guests', (req, res) => {
  if (req.query.adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const session = db.prepare('SELECT * FROM sessions WHERE active = 1 LIMIT 1').get();
  if (!session) {
    return res.status(404).json({ error: 'No active session' });
  }

  const guests = db.prepare(`
    SELECT g.id, g.name, g.emoji, g.device_id, g.created_at,
      (SELECT COUNT(*) FROM tracks WHERE added_by_guest_id = g.id AND session_id = g.session_id) as track_count,
      (SELECT COUNT(*) FROM votes WHERE guest_id = g.id) as vote_count,
      (SELECT COUNT(*) FROM guests g2 WHERE g2.session_id = g.session_id AND g2.device_id = g.device_id AND g2.id != g.id) as dup_count
    FROM guests g
    WHERE g.session_id = ?
    ORDER BY g.created_at DESC
  `).all(session.id);

  res.json({ guests });
});

module.exports = router;
