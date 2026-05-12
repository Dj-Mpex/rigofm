require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const db = require('./db/database');
const youtubeRouter = require('./routes/youtube');
const sessionsRouter = require('./routes/sessions');
const tracksRouter = require('./routes/tracks');
const settingsRouter = require('./routes/settings');
const djProfilesRouter = require('./routes/dj-profiles');
const visualsRouter = require('./routes/visuals');
const sockets = require('./sockets');

const PORT = process.env.PORT || 3002;

// Trust reverse proxy (Cloudflare → NPM → app)
// This makes req.ip return the real client IP, not 127.0.0.1
app.set('trust proxy', true);

// app.use(helmet({ ... }));  // disabled - breaks YouTube iframe player

// Rate limiters (per IP)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,    // 1 minute
  max: 600,               // 600 req/min general API
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Anfragen. Bitte kurz warten.' }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Aktionen. Bitte kurz warten.' }
});

const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                // 20 YouTube searches/min (saves API quota)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Zu viele Suchanfragen. Bitte kurz warten.' }
});

// Middleware
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Make sockets module available to routes via app.locals
app.locals.sockets = sockets;

// Health check (no rate limit, useful for Docker healthcheck)
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

// Apply rate limiters to /api routes
app.use('/api/youtube/search', searchLimiter);
app.use('/api/tracks', writeLimiter);
app.use('/api/sessions/:code/join', writeLimiter);
app.use('/api', generalLimiter);

// API routes
app.use('/api/youtube', youtubeRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/tracks', tracksRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/dj-profiles', djProfilesRouter);
app.use('/api/visuals', visualsRouter);

// QR code generator
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

// TV display view
app.get('/tv', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'tv', 'index.html'));
});

// Initialize sockets
sockets.init(io);

server.listen(PORT, () => {
  console.log(`\n📻 Rigo FM running on http://localhost:${PORT}`);
  console.log(`   Tune in. Vote up.\n`);
});
