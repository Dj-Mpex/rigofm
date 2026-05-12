const express = require('express');
const db = require('../db/database');

const router = express.Router();

// GET /api/youtube/search?q=...
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  try {
    const db = require('../db/database');
    const musicOnly = db.prepare("SELECT value FROM settings WHERE key = 'music_only'").get()?.value === 'true';

    // Step 1: search videos
    const searchParams = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '15',
      q,
      key: process.env.YOUTUBE_API_KEY
    });
    if (musicOnly) searchParams.append('videoCategoryId', '10');

    const searchUrl = `https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    if (!searchData.items) return res.json({ results: [] });

    const videoIds = searchData.items.map(i => i.id.videoId).join(',');
    if (!videoIds) return res.json({ results: [] });

    // Step 2: fetch details (duration + category)
    const detailsResp = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds}&key=${process.env.YOUTUBE_API_KEY}`
    );
    const detailsData = await detailsResp.json();

    // Read filter settings
    const maxLen = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'max_track_length'").get()?.value || '480', 10);
    const minLen = parseInt(db.prepare("SELECT value FROM settings WHERE key = 'min_track_length'").get()?.value || '60', 10);
    const blockedRaw = db.prepare("SELECT value FROM settings WHERE key = 'blocked_video_ids'").get()?.value || '[]';
    let blocked = [];
    try { blocked = JSON.parse(blockedRaw); } catch {}

    const detailsMap = {};
    detailsData.items?.forEach(item => {
      detailsMap[item.id] = {
        duration: parseIsoDuration(item.contentDetails.duration),
        categoryId: item.snippet.categoryId
      };
    });

    // Combine + filter
    const results = searchData.items.map(item => {
      const d = detailsMap[item.id.videoId] || {};
      return {
        youtube_id: item.id.videoId,
        title: item.snippet.title,
        artist: item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
        duration: d.duration || 0,
        categoryId: d.categoryId || null
      };
    }).filter(r => {
      if (blocked.includes(r.youtube_id)) return false;
      if (r.duration < minLen) return false;
      if (r.duration > maxLen) return false;
      if (musicOnly && r.categoryId && r.categoryId !== '10') return false;
      return true;
    });

    // Mark search results that already exist in current session (queued, playing or played)
    try {
      const session = db.prepare("SELECT * FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
      if (session && results && results.length > 0) {
        const ytIds = results.map(r => r.youtube_id);
        const placeholders = ytIds.map(() => '?').join(',');
        const existing = db.prepare(`
          SELECT t.id, t.youtube_id, t.status, t.played_at,
            COALESCE((SELECT SUM(v.value) FROM votes v WHERE v.track_id = t.id), 0) AS score
          FROM tracks t
          WHERE t.session_id = ? AND t.youtube_id IN (${placeholders})
        `).all(session.id, ...ytIds);

        // Get cooldown from settings
        let cooldownMs = 0;
        try {
          const cd = db.prepare("SELECT value FROM settings WHERE key = 'track_cooldown_minutes'").get();
          cooldownMs = (parseInt(cd?.value || '60', 10)) * 60 * 1000;
        } catch {}
        const now = Date.now();

        for (const r of results) {
          const match = existing.find(e => e.youtube_id === r.youtube_id);
          if (!match) continue;

          // If track is played AND cooldown has passed → no existing fields → normal add button
          if (match.status === 'played') {
            const playedAt = match.played_at || 0;
            if (cooldownMs > 0 && now - playedAt >= cooldownMs) {
              continue; // don't set existing_* — track stays in results as addable
            }
          }

          r.existing_track_id = match.id;
          r.existing_status = match.status;
          r.existing_score = match.score;
        }
      }
    } catch (e) {
      console.warn('Search match-check failed:', e.message);
    }

    res.json({ results });
  } catch (err) {
    console.error('=== YouTube Search Error ===');
    console.error('Message:', err.message);
    console.error('Status:', err.status || err.code);
    if (err.response && err.response.data) {
      console.error('API Response:', JSON.stringify(err.response.data, null, 2));
    }
    if (err.errors) {
      console.error('API Errors:', JSON.stringify(err.errors, null, 2));
    }
    console.error('Stack:', err.stack);
    console.error('===========================');
    res.status(500).json({ error: err.message || 'Unbekannter Fehler', results: [] });
  }
});

// Helper to parse ISO 8601 duration (PT4M13S → 253 seconds)
function parseIsoDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + min * 60 + s;
}

module.exports = router;
