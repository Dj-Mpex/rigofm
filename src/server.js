require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const db = require('./db/database');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3002;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/health', (req, res) => {
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const trackCount = db.prepare('SELECT COUNT(*) as count FROM tracks').get().count;

  res.json({
    status: 'ok',
    service: 'Rigo FM',
    tagline: 'Tune in. Vote up.',
    version: '0.1.0',
    db: {
      sessions: sessionCount,
      tracks: trackCount
    },
    timestamp: new Date().toISOString()
  });
});

// Root route (temporary)
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Rigo FM</title></head>
      <body style="background:#0A0A0A;color:#EAEAEA;font-family:sans-serif;text-align:center;padding:50px;">
        <h1 style="color:#FF2E63;">📻 RIGO FM</h1>
        <p style="color:#08D9D6;">Tune in. Vote up.</p>
        <p style="color:#6B6B6B;">Server is running. Build in progress.</p>
      </body>
    </html>
  `);
});

server.listen(PORT, () => {
  console.log(`\n📻 Rigo FM running on http://localhost:${PORT}`);
  console.log(`   Tune in. Vote up.\n`);
});
