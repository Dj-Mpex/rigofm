const { spawn } = require('child_process');

function searchYtDlp(query, maxResults = 15) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${maxResults}:${query}`,
      '--no-warnings',
      '--no-playlist',
      '--flat-playlist',
      '--dump-single-json',
      '--quiet',
      '--skip-download',
      '--no-check-certificate'
    ];

    const proc = spawn('yt-dlp', args, { timeout: 25000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 400)}`));
      }
      try {
        const data = JSON.parse(stdout);
        const entries = data.entries || [];
        const results = entries.map(e => ({
          youtube_id: e.id,
          title: e.title || '',
          artist: e.uploader || e.channel || e.uploader_id || '',
          thumbnail: e.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
          duration: e.duration || 0,
          categoryId: null  // not available via yt-dlp flat search
        }));
        resolve(results);
      } catch (err) {
        reject(new Error('yt-dlp JSON parse failed: ' + err.message));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

module.exports = { searchYtDlp };
