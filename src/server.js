require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const db = require('./db/database');
const youtubeRouter = require('./routes/youtube');
const sessionsRouter = require('./routes/sessions');
const tracksRouter = require('./routes/tracks');
const sockets = require('./sockets');

const PORT = process.env.PORT || 3002;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Make sockets module available to routes via app.locals
app.locals.sockets = sockets;

// Health check
app.get('/health', (req, res) => {
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const trackCount = db.prepare('SELECT COUNT(*) as count FROM tracks').get().count;
  res.json({
    status: 'ok',
    service: 'Rigo FM',
    tagline: 'Tune in. Vote up.',
    version: '0.1.0',
    db: { sessions: sessionCount, tracks: trackCount },
    sockets: io.engine.clientsCount,
    timestamp: new Date().toISOString()
  });
});

// API routes
app.use('/api/youtube', youtubeRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/tracks', tracksRouter);

// Guest landing (root + join paths)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'guest', 'index.html'));
});

app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'guest', 'index.html'));
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin', 'index.html'));
});

// QR code generator
const QRCode = require('qrcode');
app.get('/api/qr', async (req, res) => {
  const text = req.query.text || '';
  if (!text) return res.status(400).send('Missing text');
  try {
    const png = await QRCode.toBuffer(text, {
      type: 'png',
      width: 512,
      margin: 1,
      color: { dark: '#0A0A0A', light: '#FFFFFF' }
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    res.status(500).send('QR generation failed');
  }
});

// Initialize sockets
sockets.init(io);

server.listen(PORT, () => {
  console.log(`\n📻 Rigo FM running on http://localhost:${PORT}`);
  console.log(`   Tune in. Vote up.\n`);
});
