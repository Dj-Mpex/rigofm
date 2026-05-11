const db = require('../db/database');

let ioInstance = null;

function init(io) {
  ioInstance = io;

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Client joins a session room (TV, Guest, Admin all do this)
    socket.on('session:join', ({ sessionCode }) => {
      if (!sessionCode) return;
      const room = `session:${sessionCode.toUpperCase()}`;
      socket.join(room);
      socket.data.sessionRoom = room;
      console.log(`   → joined ${room}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });
}

// Broadcast queue update to all clients in a session
function broadcastQueue(sessionCode) {
  if (!ioInstance) return;
  const room = `session:${sessionCode.toUpperCase()}`;
  ioInstance.to(room).emit('queue:updated');
}

// Broadcast specific track event
function broadcastTrackEvent(sessionCode, event, payload) {
  if (!ioInstance) return;
  const room = `session:${sessionCode.toUpperCase()}`;
  ioInstance.to(room).emit(event, payload);
}

// Helper: get session code by session id
function getSessionCodeById(sessionId) {
  const row = db.prepare('SELECT code FROM sessions WHERE id = ?').get(sessionId);
  return row ? row.code : null;
}

module.exports = { init, broadcastQueue, broadcastTrackEvent, getSessionCodeById };
