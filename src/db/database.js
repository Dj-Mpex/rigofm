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
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','playing','played','pending','rejected')),
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

// Migration: add mode column to sessions if not exists
try {
  const cols = db.prepare("PRAGMA table_info(sessions)").all();
  const hasMode = cols.some(c => c.name === 'mode');
  if (!hasMode) {
    db.prepare("ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto'").run();
    console.log('   → migrated: sessions.mode column added');
  }
} catch (e) { console.error('Migration sessions.mode failed:', e.message); }

// Migration: add guest_message and dj_note columns to tracks if not exist
try {
  const cols = db.prepare("PRAGMA table_info(tracks)").all();
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('guest_message')) {
    db.prepare("ALTER TABLE tracks ADD COLUMN guest_message TEXT").run();
    console.log('   → migrated: tracks.guest_message column added');
  }
  if (!colNames.includes('dj_note')) {
    db.prepare("ALTER TABLE tracks ADD COLUMN dj_note TEXT").run();
    console.log('   → migrated: tracks.dj_note column added');
  }
} catch (e) { console.error('Migration tracks columns failed:', e.message); }

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
  { key: 'blocked_video_ids', value: '[]' },        // JSON-Array von blockierten videoIds
  { key: 'track_cooldown_minutes', value: '60' }
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

// DJ Profiles
db.prepare(`
  CREATE TABLE IF NOT EXISTS dj_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo_filename TEXT,
    created_at INTEGER NOT NULL
  )
`).run();

// Migration: add active_dj_profile_id to settings (default: none)
try {
  const exists = db.prepare("SELECT 1 FROM settings WHERE key = 'active_dj_profile_id'").get();
  if (!exists) {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run('active_dj_profile_id', '', Date.now());
    console.log('   → migrated: active_dj_profile_id setting added');
  }
} catch (e) { console.error('Migration active_dj_profile_id failed:', e.message); }

// Visuals Presets
db.prepare(`
  CREATE TABLE IF NOT EXISTS visuals_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`).run();

// Migration: settings for visuals/source toggle in live mode
try {
  const keys = [
    { key: 'active_visuals_preset_id', value: '' },
    { key: 'live_tv_source', value: 'tracks' },
    { key: 'live_tv_muted', value: 'false' }
  ];
  for (const k of keys) {
    const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k.key);
    if (!exists) {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(k.key, k.value, Date.now());
      console.log(`   → migrated: ${k.key} setting added`);
    }
  }
} catch (e) { console.error('Migration visuals settings failed:', e.message); }

try {
  const exists = db.prepare("SELECT 1 FROM settings WHERE key = 'tv_charts_overlay_enabled'").get();
  if (!exists) {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run('tv_charts_overlay_enabled', 'true', Date.now());
    console.log('   → migrated: tv_charts_overlay_enabled setting added');
  }
} catch (e) { console.error('Migration tv_charts_overlay_enabled failed:', e.message); }

// Migration: livestream URL overrides (admin can override .env values via settings)
try {
  const livestreamKeys = [
    { key: 'livestream_url_override', value: '' },
    { key: 'livestream_status_url_override', value: '' }
  ];
  for (const k of livestreamKeys) {
    const exists = db.prepare("SELECT 1 FROM settings WHERE key = ?").get(k.key);
    if (!exists) {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(k.key, k.value, Date.now());
      console.log(`   → migrated: ${k.key} setting added`);
    }
  }
} catch (e) { console.error('Migration livestream settings failed:', e.message); }

// Migration: make tracks.added_by_guest_id nullable + add denormalized added_by_emoji column.
// SQLite cannot ALTER column constraints, so we recreate the table.
// Guard: if added_by_emoji column already exists the migration already ran.
try {
  const trackColNames = db.prepare("PRAGMA table_info(tracks)").all().map(c => c.name);
  if (!trackColNames.includes('added_by_emoji')) {
    // Collect which optional migration columns actually exist in the old table
    const optionalCols = ['guest_message', 'dj_note', 'manual_order'];
    const presentOptional = optionalCols.filter(c => trackColNames.includes(c));

    db.pragma('foreign_keys = OFF');
    try {
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE tracks_new (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            youtube_id TEXT NOT NULL,
            title TEXT NOT NULL,
            artist TEXT,
            thumbnail TEXT,
            duration INTEGER,
            added_by_guest_id TEXT,
            added_by_name TEXT NOT NULL,
            added_by_emoji TEXT,
            status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','playing','played','pending','rejected')),
            played_at INTEGER,
            created_at INTEGER NOT NULL,
            guest_message TEXT,
            dj_note TEXT,
            manual_order INTEGER,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
            FOREIGN KEY (added_by_guest_id) REFERENCES guests(id) ON DELETE SET NULL
          )
        `);

        // Build column list dynamically so missing optional cols get NULL
        const coreCols = ['id', 'session_id', 'youtube_id', 'title', 'artist', 'thumbnail',
                          'duration', 'added_by_guest_id', 'added_by_name',
                          'status', 'played_at', 'created_at'];
        const allDestCols = [...coreCols, 'added_by_emoji', ...optionalCols];
        const allSrcExprs = [
          ...coreCols.map(c => c),
          'NULL', // added_by_emoji — will be backfilled below
          ...optionalCols.map(c => presentOptional.includes(c) ? c : 'NULL')
        ];
        db.exec(`
          INSERT INTO tracks_new (${allDestCols.join(', ')})
          SELECT ${allSrcExprs.join(', ')} FROM tracks
        `);

        // Backfill emoji from guests for all tracks whose guest still exists
        db.exec(`
          UPDATE tracks_new
          SET added_by_emoji = (SELECT emoji FROM guests WHERE id = tracks_new.added_by_guest_id)
          WHERE added_by_guest_id IS NOT NULL
        `);

        db.exec('DROP TABLE tracks');
        db.exec('ALTER TABLE tracks_new RENAME TO tracks');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_session_status ON tracks(session_id, status)');
      });
      migrate();
      console.log('   → migrated: tracks recreated — added_by_guest_id nullable + ON DELETE SET NULL + added_by_emoji column');
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
} catch (e) { console.error('Migration tracks nullable/emoji failed:', e.message); }

console.log('📀 Database ready:', dbPath);

module.exports = db;
