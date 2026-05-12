const express = require('express');
const db = require('../db/database');

const router = express.Router();

// DELETE /api/guests/:id — kick a guest (admin only)
router.delete('/:id', (req, res) => {
  const { adminPassword } = req.body;
  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }

  const { id } = req.params;
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  if (!guest) return res.status(404).json({ error: 'Gast nicht gefunden' });

  // Persist emoji into tracks before deleting guest (denormalize for history)
  if (guest.emoji) {
    db.prepare(`
      UPDATE tracks SET added_by_emoji = ?
      WHERE added_by_guest_id = ? AND (added_by_emoji IS NULL OR added_by_emoji = '')
    `).run(guest.emoji, id);
  }

  // Deleting the guest triggers:
  //   - votes: ON DELETE CASCADE  → votes by this guest are removed
  //   - tracks: ON DELETE SET NULL → added_by_guest_id set to NULL, name/emoji stay
  db.prepare('DELETE FROM guests WHERE id = ?').run(id);

  const sockets = req.app.locals.sockets;
  if (sockets && sockets.broadcastGuestKicked) sockets.broadcastGuestKicked(id);
  if (sockets && sockets.broadcastQueue) {
    const session = db.prepare('SELECT code FROM sessions WHERE active = 1 LIMIT 1').get();
    if (session) sockets.broadcastQueue(session.code);
  }

  res.json({ success: true });
});

module.exports = router;
