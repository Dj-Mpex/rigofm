const express = require('express');
const { google } = require('googleapis');

const router = express.Router();

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY
});

// GET /api/youtube/search?q=...
router.get('/search', async (req, res) => {
  const query = (req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }

  try {
    const searchResponse = await youtube.search.list({
      part: ['snippet'],
      q: query,
      type: ['video'],
      videoCategoryId: '10', // Music
      maxResults: 10,
      videoEmbeddable: 'true',
      safeSearch: 'none'
    });

    const videoIds = searchResponse.data.items.map(item => item.id.videoId);

    // Fetch durations and details
    const detailsResponse = await youtube.videos.list({
      part: ['contentDetails', 'snippet', 'status'],
      id: videoIds
    });

    const results = detailsResponse.data.items
      .filter(v => v.status.embeddable !== false)
      .map(v => ({
        youtube_id: v.id,
        title: v.snippet.title,
        artist: v.snippet.channelTitle,
        thumbnail: v.snippet.thumbnails.high?.url || v.snippet.thumbnails.default?.url,
        duration: parseDuration(v.contentDetails.duration),
        publishedAt: v.snippet.publishedAt
      }));

    res.json({ query, results });
  } catch (err) {
    console.error('YouTube search error:', err.message);
    res.status(500).json({
      error: 'YouTube search failed',
      details: err.message
    });
  }
});

// ISO 8601 duration (PT4M13S) -> seconds
function parseDuration(iso) {
  if (!iso) return 0;
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
}

module.exports = router;
