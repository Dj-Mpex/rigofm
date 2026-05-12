const db = require('../db/database');

let ioInstance = null;

function init(io) {
  ioInstance = io;

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Client joins a session room (TV, Guest, Admin all do this)
    socket.on('session:join', ({ sessionCode, role }) => {
      if (!sessionCode) return;
      const room = `session:${sessionCode.toUpperCase()}`;
      socket.join(room);
      socket.data.sessionRoom = room;
      socket.data.role = role || 'guest';

      // Sub-rooms by role for targeted messaging
      if (role === 'tv' || role === 'admin') {
        socket.join(`${room}:${role}`);
      }
      console.log(`   → joined ${room} as ${socket.data.role}`);
    });

    // === Admin → TV: Remote control commands ===
    socket.on('player:command', (payload) => {
      if (socket.data.role !== 'admin' || !socket.data.sessionRoom) return;
      ioInstance.to(`${socket.data.sessionRoom}:tv`).emit('player:command', payload);
    });

    // === TV → Admin: Player state updates ===
    socket.on('player:state', (payload) => {
      if (socket.data.role !== 'tv' || !socket.data.sessionRoom) return;
      ioInstance.to(`${socket.data.sessionRoom}:admin`).emit('player:state', payload);
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

// Broadcast config change to ALL connected clients (filler playlist etc.)
function broadcastConfigChange() {
  if (!ioInstance) return;
  ioInstance.emit('config:changed');
}

// Broadcast pending track update to ALL connected clients (DJ approval flow)
function broadcastPendingUpdate() {
  if (!ioInstance) return;
  ioInstance.emit('pending:updated');
}

// Helper: get session code by session id
function getSessionCodeById(sessionId) {
  const row = db.prepare('SELECT code FROM sessions WHERE id = ?').get(sessionId);
  return row ? row.code : null;
}

module.exports = { init, broadcastQueue, broadcastTrackEvent, broadcastConfigChange, broadcastPendingUpdate, getSessionCodeById };
