const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'rigofm.sqlite');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS guests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    youtube_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    thumbnail TEXT,
    duration INTEGER,
    added_by_guest_id TEXT NOT NULL,
    added_by_name TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    played_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (added_by_guest_id) REFERENCES guests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    guest_id TEXT NOT NULL,
    value INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(track_id, guest_id),
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
    FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_tracks_session_status ON tracks(session_id, status);
  CREATE INDEX IF NOT EXISTS idx_votes_track ON votes(track_id);
  CREATE INDEX IF NOT EXISTS idx_votes_guest ON votes(guest_id);
`);

// Add manual_order column for admin drag&drop (idempotent)
try {
  db.exec('ALTER TABLE tracks ADD COLUMN manual_order INTEGER');
  console.log('   → added manual_order column');
} catch (e) {
  // Column already exists, ignore
}

// Add device_id and emoji columns to guests (idempotent)
try {
  db.exec('ALTER TABLE guests ADD COLUMN device_id TEXT');
  console.log('   → added device_id column to guests');
} catch (e) { /* column exists */ }

try {
  db.exec('ALTER TABLE guests ADD COLUMN emoji TEXT');
  console.log('   → added emoji column to guests');
} catch (e) { /* column exists */ }

// Index for fast device-id lookup
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_guests_device ON guests(session_id, device_id)');
} catch (e) {}

// Settings table for runtime config (filler playlist, etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL
  );
`);

// Seed defaults if not present
const defaultSettings = [
  { key: 'filler_playlist_id', value: process.env.FILLER_PLAYLIST_ID || 'PLOzDu-MXXLliO9fBNZOQTBDddoA3FzZUo' },
  { key: 'max_track_length', value: '480' },        // 8 Min in Sekunden
  { key: 'min_track_length', value: '60' },         // 1 Min in Sekunden
  { key: 'music_only', value: 'true' },             // YouTube-Kategorie 10 erzwingen
  { key: 'blocked_video_ids', value: '[]' }         // JSON-Array von blockierten videoIds
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
defaultSettings.forEach(s => insertSetting.run(s.key, s.value, Date.now()));

// Backfill: assign emojis to legacy guests without one (use crypto for true randomness)
try {
  const crypto = require('crypto');
  const PARTY_EMOJIS = ['🎉','🎊','🥳','🍻','🍾','🎶','🎵','🎸','🎤','🎷','🎺','🥁','🎹','💃','🕺','🪩','🔥','⚡','✨','🌟','💥','🚀','🎮','🎲','🎯','🎪','🦄','🐉','🦖','🐙','🦊','🦁','🐯','🐺','🦋','🦩','🌈','🍕','🌮','🌶️','🍔','🍩','🍪','🧁','🍦','🌵','🌴','🍒','🍑'];
  const missing = db.prepare("SELECT id FROM guests WHERE emoji IS NULL OR emoji = ''").all();
  if (missing.length > 0) {
    const update = db.prepare('UPDATE guests SET emoji = ? WHERE id = ?');
    missing.forEach(row => {
      const buf = crypto.randomBytes(2);
      const idx = buf.readUInt16BE(0) % PARTY_EMOJIS.length;
      update.run(PARTY_EMOJIS[idx], row.id);
    });
    console.log(`   → backfilled ${missing.length} guests with party emojis`);
  }
} catch (e) { console.error('Emoji backfill failed:', e.message); }

console.log('📀 Database ready:', dbPath);

module.exports = db;
