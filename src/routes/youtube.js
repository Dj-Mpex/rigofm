const express = require('express');

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

    res.json({ results });
  } catch (err) {
    console.error('YouTube search error:', err);
    res.status(500).json({ error: 'Suche fehlgeschlagen' });
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
