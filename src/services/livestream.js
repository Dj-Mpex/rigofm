const db = require('../db/database');

const POLL_INTERVAL_MS = 10_000;
const DEFAULT_STREAM_URL = process.env.RIGO_LIVESTREAM_URL || '';
const DEFAULT_STATUS_URL = process.env.RIGO_LIVESTREAM_STATUS_URL || '';

let _sockets = null;
let _pollTimer = null;
let _lastOnline = null; // null = unknown, true/false = known state

function getEffectiveUrls() {
  const rows = db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('livestream_url_override','livestream_status_url_override')"
  ).all();
  const overrides = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    streamUrl: overrides.livestream_url_override || DEFAULT_STREAM_URL,
    statusUrl: overrides.livestream_status_url_override || DEFAULT_STATUS_URL
  };
}

async function checkStatus() {
  const { statusUrl } = getEffectiveUrls();
  if (!statusUrl) return { online: false };
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { online: false };
    const json = await res.json();
    // Owncast /api/status returns { online: bool, ... }
    const online = json.online === true;
    return { online };
  } catch {
    return { online: false };
  }
}

async function _poll() {
  try {
    const { online } = await checkStatus();
    if (_lastOnline !== online) {
      _lastOnline = online;
      if (_sockets && _sockets.broadcastLivestreamStatus) {
        _sockets.broadcastLivestreamStatus(online);
      }
    }
  } catch (e) {
    console.error('Livestream poll error:', e.message);
  }
}

function start(socketsModule) {
  _sockets = socketsModule;
  if (_pollTimer) clearInterval(_pollTimer);
  _poll(); // immediate first check
  _pollTimer = setInterval(_poll, POLL_INTERVAL_MS);
}

function stop() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function getLastOnline() {
  return _lastOnline === true;
}

module.exports = { getEffectiveUrls, checkStatus, start, stop, getLastOnline };
