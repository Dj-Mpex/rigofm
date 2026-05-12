const express = require('express');
const crypto = require('crypto');
const db = require('../db/database');
const { searchYtDlp } = require('../services/youtube-fallback');

const router = express.Router();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// GET /api/youtube/search?q=...
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  try {
    const dbInstance = require('../db/database');

    // Settings (used both for filtering and cache key)
    const musicOnly = dbInstance.prepare("SELECT value FROM settings WHERE key = 'music_only'").get()?.value === 'true';
    const maxLen = parseInt(dbInstance.prepare("SELECT value FROM settings WHERE key = 'max_track_length'").get()?.value || '480', 10);
    const minLen = parseInt(dbInstance.prepare("SELECT value FROM settings WHERE key = 'min_track_length'").get()?.value || '60', 10);
    const blockedRaw = dbInstance.prepare("SELECT value FROM settings WHERE key = 'blocked_video_ids'").get()?.value || '[]';
    let blocked = [];
    try { blocked = JSON.parse(blockedRaw); } catch {}

    // Cache key: query + musicOnly (other filters applied AFTER caching, since they may change)
    const cacheKey = crypto.createHash('sha1').update(q.toLowerCase() + '|' + (musicOnly ? '1' : '0')).digest('hex');

    let rawResults = null;
    let sourceUsed = null;

    // === Step 1: Try cache ===
    const cached = dbInstance.prepare("SELECT results_json, created_at, source FROM youtube_cache WHERE cache_key = ?").get(cacheKey);
    if (cached && (Date.now() - cached.created_at) < CACHE_TTL_MS) {
      try {
        rawResults = JSON.parse(cached.results_json);
        sourceUsed = 'cache(' + cached.source + ')';
      } catch {}
    }

    // === Step 2: Try YouTube API ===
    if (!rawResults && process.env.YOUTUBE_API_KEY) {
      try {
        const searchParams = new URLSearchParams({
          part: 'snippet',
          type: 'video',
          videoEmbeddable: 'true',
          maxResults: '15',
          q,
          key: process.env.YOUTUBE_API_KEY
        });
        if (musicOnly) searchParams.append('videoCategoryId', '10');

        const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`);
        const searchData = await searchResp.json();

        if (searchData.items) {
          const videoIds = searchData.items.map(i => i.id.videoId).filter(Boolean).join(',');
          if (videoIds) {
            const detailsResp = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds}&key=${process.env.YOUTUBE_API_KEY}`
            );
            const detailsData = await detailsResp.json();

            if (detailsData.error) {
              console.warn('[search] YouTube Details API error:', detailsData.error.code, detailsData.error.message);
            }

            const detailsMap = {};
            detailsData.items?.forEach(item => {
              detailsMap[item.id] = {
                duration: parseIsoDuration(item.contentDetails.duration),
                categoryId: item.snippet.categoryId
              };
            });

            rawResults = searchData.items.map(item => {
              const d = detailsMap[item.id.videoId] || {};
              return {
                youtube_id: item.id.videoId,
                title: item.snippet.title,
                artist: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
                duration: d.duration || 0,
                categoryId: d.categoryId || null
              };
            });
            sourceUsed = 'api';
          }
        } else if (searchData.error) {
          console.warn('[search] YouTube API error:', searchData.error.code, searchData.error.message);
          // fall through to yt-dlp
        }
      } catch (apiErr) {
        console.warn('[search] YouTube API exception:', apiErr.message);
        // fall through to yt-dlp
      }
    }

    // === Step 3: Fallback yt-dlp ===
    if (!rawResults || rawResults.length === 0) {
      try {
        console.log('[search] Trying yt-dlp fallback for:', q);
        rawResults = await searchYtDlp(q, 15);
        sourceUsed = 'yt-dlp';
      } catch (ytErr) {
        console.error('[search] yt-dlp fallback failed:', ytErr.message);
        return res.status(503).json({
          error: 'Suche aktuell nicht verfügbar. Bitte später nochmal versuchen.',
          results: []
        });
      }
    }

    if (!rawResults) rawResults = [];

    // Cache the raw results (unfiltered) — filters may change, results stay valid
    if (sourceUsed && !sourceUsed.startsWith('cache')) {
      try {
        dbInstance.prepare(`
          INSERT INTO youtube_cache (cache_key, query, results_json, source, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            results_json = excluded.results_json,
            source = excluded.source,
            created_at = excluded.created_at
        `).run(cacheKey, q, JSON.stringify(rawResults), sourceUsed, Date.now());
      } catch (cacheErr) {
        console.warn('[search] cache write failed:', cacheErr.message);
      }
    }

    // === Apply runtime filters (NOT cached, because settings might change) ===
    const results = rawResults.filter(r => {
      if (blocked.includes(r.youtube_id)) return false;
      if (r.duration && r.duration < minLen) return false;
      if (r.duration && r.duration > maxLen) return false;
      // musicOnly via category only applies if categoryId is set (API path); yt-dlp results pass through
      if (musicOnly && r.categoryId && r.categoryId !== '10') return false;
      return true;
    });

    // === Mark already-existing tracks in current session (queue / playing / played) ===
    try {
      const session = dbInstance.prepare("SELECT * FROM sessions WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
      if (session && results.length > 0) {
        const ytIds = results.map(r => r.youtube_id);
        const placeholders = ytIds.map(() => '?').join(',');
        const existing = dbInstance.prepare(`
          SELECT t.id, t.youtube_id, t.status, t.played_at,
            COALESCE((SELECT SUM(v.value) FROM votes v WHERE v.track_id = t.id), 0) AS score
          FROM tracks t
          WHERE t.session_id = ? AND t.youtube_id IN (${placeholders})
        `).all(session.id, ...ytIds);

        let cooldownMs = 0;
        try {
          const cd = dbInstance.prepare("SELECT value FROM settings WHERE key = 'track_cooldown_minutes'").get();
          cooldownMs = (parseInt(cd?.value || '60', 10)) * 60 * 1000;
        } catch {}
        const now = Date.now();

        for (const r of results) {
          const match = existing.find(e => e.youtube_id === r.youtube_id);
          if (!match) continue;
          if (match.status === 'played') {
            const playedAt = match.played_at || 0;
            if (cooldownMs > 0 && now - playedAt >= cooldownMs) continue;
          }
          r.existing_track_id = match.id;
          r.existing_status = match.status;
          r.existing_score = match.score;
        }
      }
    } catch (e) {
      console.warn('Search match-check failed:', e.message);
    }

    console.log(`[search] q="${q}" source=${sourceUsed} results=${results.length}`);
    res.json({ results });
  } catch (err) {
    console.error('=== Search outer error ===');
    console.error(err);
    res.status(500).json({ error: err.message || 'Fehler', results: [] });
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
