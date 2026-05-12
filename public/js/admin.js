(() => {
  const API = '';
  let adminPassword = sessionStorage.getItem('rigofm_admin_pw') || null;
  let socket = null;
  let currentSession = null;

  // --- Element refs ---
  const $ = (id) => document.getElementById(id);

  // --- View switching ---
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $(`view-${name}`).classList.add('active');
  }

  // --- API helper ---
  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // --- Login flow ---
  $('login-btn').addEventListener('click', login);
  $('login-password').addEventListener('keypress', (e) => { if (e.key === 'Enter') login(); });

  async function login() {
    const pw = $('login-password').value.trim();
    if (!pw) return;

    try {
      // Verify by trying to fetch guests
      await api(`/api/sessions/active/guests?adminPassword=${encodeURIComponent(pw)}`);
      adminPassword = pw;
      sessionStorage.setItem('rigofm_admin_pw', pw);
      enterDashboard();
    } catch (err) {
      if (err.message === 'No active session') {
        // Password is correct, but no session yet — still authenticated
        adminPassword = pw;
        sessionStorage.setItem('rigofm_admin_pw', pw);
        enterDashboard();
      } else {
        $('login-error').textContent = 'Falsches Passwort.';
        $('login-error').style.display = 'block';
      }
    }
  }

  $('logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem('rigofm_admin_pw');
    adminPassword = null;
    if (socket) socket.disconnect();
    showView('login');
  });

  // --- Dashboard ---
  async function enterDashboard() {
    showView('dashboard');
    $('login-error').style.display = 'none';
    initSocket();
    await loadFiller();
    await refreshAll();
    loadFilters();
    bindFilterUI();
  }

  async function refreshAll() {
    try {
      const { session } = await api('/api/sessions/active');
      currentSession = session;
      renderSessionActive(session);
      await Promise.all([refreshQueue(), refreshGuests()]);
    } catch (err) {
      currentSession = null;
      renderNoSession();
    }
  }

  function renderNoSession() {
    $('no-session-state').style.display = 'block';
    $('active-session-state').style.display = 'none';
  }

  function renderSessionActive(session) {
    $('no-session-state').style.display = 'none';
    $('active-session-state').style.display = 'block';
    $('session-name').textContent = session.name;
    $('session-code').textContent = session.code;

    const joinUrl = `${window.location.origin}/join/${session.code}`;
    $('join-url').textContent = joinUrl;
    $('qr-image').src = `/api/qr?text=${encodeURIComponent(joinUrl)}`;

    // Connect socket to session room
    if (socket) socket.emit('session:join', { sessionCode: session.code, role: 'admin' });
  }

  // --- Socket ---
  function initSocket() {
    if (socket) return;
    socket = io();
    socket.on('connect', () => {
      $('connection-status').classList.add('connected');
      if (currentSession) {
        socket.emit('session:join', { sessionCode: currentSession.code, role: 'admin' });
      }
    });
    socket.on('disconnect', () => {
      $('connection-status').classList.remove('connected');
      setTvOnline(false);
    });
    socket.on('queue:updated', () => {
      refreshQueue();
      refreshGuests();
    });
    socket.on('player:state', onPlayerState);
  }

  // --- Start session ---
  $('start-session-btn').addEventListener('click', async () => {
    const name = prompt('Name der Party:', 'Rigo Party');
    if (!name) return;
    try {
      await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ name, adminPassword })
      });
      await refreshAll();
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  });

  // --- End session ---
  $('end-session-btn').addEventListener('click', async () => {
    if (!confirm('Session wirklich beenden?')) return;
    try {
      await api('/api/sessions/end', {
        method: 'POST',
        body: JSON.stringify({ adminPassword })
      });
      currentSession = null;
      renderNoSession();
    } catch (err) {
      alert('Fehler: ' + err.message);
    }
  });

  // --- Queue ---
  async function refreshQueue() {
    if (!currentSession) return;
    try {
      const { queue } = await api('/api/tracks/queue');
      renderQueue(queue);
    } catch (err) {
      console.error('Queue fetch:', err);
    }
  }

  function renderQueue(queue) {
    const list = $('queue-list');
    list.innerHTML = '';
    $('track-count').textContent = queue.length;

    if (queue.length === 0) {
      $('queue-empty').style.display = 'block';
      return;
    }
    $('queue-empty').style.display = 'none';

    queue.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'track-item' + (t.status === 'playing' ? ' playing' : '');
      item.dataset.id = t.id;
      item.draggable = t.status !== 'playing';

      const scoreClass = t.score > 0 ? '' : (t.score < 0 ? 'negative' : 'zero');
      const scoreDisplay = t.score > 0 ? `+${t.score}` : t.score;

      item.innerHTML = `
        <span class="track-handle">${t.status === 'playing' ? '▶' : '⋮⋮'}</span>
        <img class="track-thumb" src="${t.thumbnail || ''}" alt="">
        <div class="track-meta">
          <div class="track-title">${escapeHtml(t.title)}</div>
          <div class="track-sub">${escapeHtml(t.artist || '')} · <span class="by">${t.added_by_emoji ? t.added_by_emoji + ' ' : ''}${escapeHtml(t.added_by_name)}</span></div>
        </div>
        <div class="track-score ${scoreClass}">${scoreDisplay}</div>
        <div class="track-actions">
          ${t.status !== 'playing' ? `<button class="btn btn-ghost btn-sm" data-action="play" data-id="${t.id}">▶ Play</button>` : ''}
          <button class="btn btn-danger btn-sm btn-icon" data-action="delete" data-id="${t.id}" title="Löschen">×</button>
        </div>
      `;

      attachDragHandlers(item);
      list.appendChild(item);
    });

    // Action buttons
    list.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', handleTrackAction);
    });
  }

  async function handleTrackAction(e) {
    const action = e.currentTarget.dataset.action;
    const id = e.currentTarget.dataset.id;

    if (action === 'delete') {
      if (!confirm('Track wirklich löschen?')) return;
      try {
        await api(`/api/tracks/${id}`, {
          method: 'DELETE',
          body: JSON.stringify({ adminPassword })
        });
      } catch (err) { alert(err.message); }
    } else if (action === 'play') {
      try {
        await api(`/api/tracks/${id}/mark-playing`, { method: 'POST', body: '{}' });
      } catch (err) { alert(err.message); }
    }
  }

  // --- Drag & Drop ---
  let dragSrc = null;
  function attachDragHandlers(el) {
    el.addEventListener('dragstart', (e) => {
      if (!el.draggable) return;
      dragSrc = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragSrc = null;
      persistOrder();
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragSrc || dragSrc === el) return;
      const rect = el.getBoundingClientRect();
      const after = (e.clientY - rect.top) > rect.height / 2;
      el.parentNode.insertBefore(dragSrc, after ? el.nextSibling : el);
    });
  }

  async function persistOrder() {
    const ids = [...$('queue-list').querySelectorAll('.track-item')].map(el => el.dataset.id);
    try {
      await api('/api/tracks/reorder', {
        method: 'POST',
        body: JSON.stringify({ adminPassword, orderedIds: ids })
      });
    } catch (err) {
      console.error('Reorder failed:', err);
      refreshQueue();
    }
  }

  // --- Guests ---
  async function refreshGuests() {
    if (!currentSession) return;
    try {
      const { guests } = await api(`/api/sessions/active/guests?adminPassword=${encodeURIComponent(adminPassword)}`);
      renderGuests(guests);
    } catch (err) {
      console.error('Guests fetch:', err);
    }
  }

  function renderGuests(guests) {
    $('guest-count').textContent = guests.length;
    const list = $('guest-list');
    list.innerHTML = '';
    if (guests.length === 0) {
      list.innerHTML = `<p style="color: var(--color-text-muted); text-align:center; padding: var(--space-4);">Noch keine Gäste</p>`;
      return;
    }
    guests.forEach(g => {
      const item = document.createElement('div');
      item.className = 'guest-item';
      const emojiPart = g.emoji ? `<span style="font-size:1.2rem;margin-right:8px;">${g.emoji}</span>` : '';
      const dupTag = g.dup_count > 0 ? `<span style="font-size:0.625rem;color:var(--color-warning);margin-left:6px;letter-spacing:0.08em;text-transform:uppercase;font-weight:bold;">⚠ ${g.dup_count}× Device</span>` : '';
      item.innerHTML = `
        <span class="name">${emojiPart}${escapeHtml(g.name)}${dupTag}</span>
        <span class="stats">
          <span><span class="stat-num">${g.track_count}</span> Tracks</span>
          <span><span class="stat-num">${g.vote_count}</span> Votes</span>
        </span>
      `;
      list.appendChild(item);
    });
  }

  // --- Utils ---
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // --- Init ---
  if (adminPassword) {
    enterDashboard();
  } else {
    showView('login');
  }

  // --- Filler playlist settings ---
  async function loadFiller() {
    try {
      const { playlistId } = await api('/api/settings/filler');
      $('filler-input').value = playlistId || '';
      const status = $('filler-status');
      if (playlistId) {
        status.textContent = `Aktiv: ${playlistId}`;
        status.className = 'filler-status info';
      } else {
        status.textContent = 'Kein Filler konfiguriert — TV bleibt im Idle-Mode';
        status.className = 'filler-status info';
      }
    } catch (err) {
      console.error('Load filler:', err);
    }
  }

  function extractPlaylistId(input) {
    const s = input.trim();
    if (!s) return '';
    // Already a bare ID
    if (/^[A-Za-z0-9_-]+$/.test(s)) return s;
    // Extract `list=...` parameter from any YouTube URL
    // (works for playlist?list=, watch?v=...&list=, etc.)
    const m = s.match(/[?&#]list=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    // Fallback: return original (will fail backend validation, user gets error)
    return s;
  }

  async function saveFiller() {
    const raw = $('filler-input').value;
    const playlistId = extractPlaylistId(raw);
    const status = $('filler-status');
    const btn = $('filler-save');

    btn.disabled = true;
    status.textContent = 'Speichern…';
    status.className = 'filler-status info';

    try {
      const res = await fetch('/api/settings/filler', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword, playlistId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fehler');

      $('filler-input').value = data.playlistId;
      status.textContent = data.playlistId
        ? `Gespeichert: ${data.playlistId}`
        : 'Filler deaktiviert';
      status.className = 'filler-status success';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'filler-status error';
    } finally {
      btn.disabled = false;
    }
  }

  $('filler-save').addEventListener('click', saveFiller);
  $('filler-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveFiller();
  });

  // ============================================
  // Player Remote Control Bar
  // ============================================
  let tvOnlineTimer = null;
  let userIsSeekingVolume = false;

  function setTvOnline(online) {
    const status = $('pb-tv-status');
    if (!status) return;
    status.classList.toggle('online', online);
    if (!online) {
      $('player-bar').style.display = 'none';
    }
  }

  function formatTime(sec) {
    if (!sec || !isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function onPlayerState(s) {
    if (!currentSession) return;

    // Show the bar
    $('player-bar').style.display = 'grid';
    setTvOnline(true);

    // Reset offline-timer
    clearTimeout(tvOnlineTimer);
    tvOnlineTimer = setTimeout(() => setTvOnline(false), 3500);

    // Update info
    if (s.isFillerMode) {
      $('pb-thumb').src = '/img/rigo-logo.png';
      $('pb-title').textContent = 'Idle Filler';
      $('pb-sub').innerHTML = `<span class="filler-tag">Filler</span> YouTube-Playlist`;
    } else if (s.currentTrack) {
      $('pb-thumb').src = s.currentTrack.thumbnail || '';
      $('pb-title').textContent = s.currentTrack.title;
      $('pb-sub').textContent = `${s.currentTrack.artist || ''} · @${s.currentTrack.added_by_name}`;
    } else {
      $('pb-thumb').src = '/img/rigo-logo.png';
      $('pb-title').textContent = '—';
      $('pb-sub').textContent = '—';
    }

    // Progress
    $('pb-time-current').textContent = formatTime(s.currentTime);
    $('pb-time-duration').textContent = formatTime(s.duration);
    const pct = s.duration > 0 ? (s.currentTime / s.duration) * 100 : 0;
    $('pb-progress-fill').style.width = `${Math.min(100, pct)}%`;

    // Play/pause icon: 1 = playing, 2 = paused
    const isPlaying = s.playerState === 1;
    $('pb-toggle-icon').textContent = isPlaying ? '❚❚' : '▶';

    // Volume + mute
    if (!userIsSeekingVolume) {
      $('pb-volume').value = s.isMuted ? 0 : s.volume;
    }
    $('pb-mute-icon').textContent = s.isMuted || s.volume === 0 ? '🔇' : '🔊';
  }

  function sendCommand(action, value) {
    if (!socket || !currentSession) return;
    socket.emit('player:command', { action, value });
  }

  // Wire up controls
  $('pb-toggle').addEventListener('click', () => sendCommand('toggle'));
  $('pb-skip').addEventListener('click', () => {
    if (confirm('Aktuellen Track skippen?')) sendCommand('skip');
  });
  $('pb-force-filler').addEventListener('click', () => {
    if (confirm('Zurück zur Filler-Playlist? Aktueller Song wird unterbrochen.')) {
      sendCommand('force-filler');
    }
  });
  $('pb-mute').addEventListener('click', () => {
    const isMutedNow = $('pb-mute-icon').textContent === '🔇';
    sendCommand(isMutedNow ? 'unmute' : 'mute');
  });

  // Volume slider — only send while user is actively dragging
  $('pb-volume').addEventListener('mousedown', () => { userIsSeekingVolume = true; });
  $('pb-volume').addEventListener('touchstart', () => { userIsSeekingVolume = true; }, { passive: true });
  $('pb-volume').addEventListener('input', (e) => {
    sendCommand('volume', parseInt(e.target.value, 10));
  });
  $('pb-volume').addEventListener('mouseup', () => { setTimeout(() => userIsSeekingVolume = false, 200); });
  $('pb-volume').addEventListener('touchend', () => { setTimeout(() => userIsSeekingVolume = false, 200); });

  // === Filter & Limits ===
  async function loadFilters() {
    try {
      const r = await api('/api/settings/filters');
      $('filter-max-length').value = r.max_track_length;
      $('filter-min-length').value = r.min_track_length;
      $('filter-music-only').checked = r.music_only;
      renderBlocklist(r.blocked_video_ids || []);
    } catch (err) {
      console.error('Load filters error:', err);
    }
  }

  function renderBlocklist(ids) {
    const container = $('blocked-list');
    if (!ids.length) {
      container.innerHTML = '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Keine blockierten Videos.</p>';
      return;
    }
    container.innerHTML = ids.map(id => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: var(--space-2) var(--space-3); background: var(--color-bg-elevated); border-radius: var(--radius-sm);">
        <code style="font-family: var(--font-mono); font-size: var(--font-size-sm);">${escapeHtml(id)}</code>
        <button class="btn btn-sm btn-danger" data-unblock="${escapeHtml(id)}">Entsperren</button>
      </div>
    `).join('');
    container.querySelectorAll('[data-unblock]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-unblock');
        try {
          const r = await api(`/api/settings/filters/block/${encodeURIComponent(id)}`, { method: 'DELETE' });
          renderBlocklist(r.blocked_video_ids || []);
        } catch (err) {
          alert('Konnte nicht entsperren: ' + err.message);
        }
      });
    });
  }

  function bindFilterUI() {
    $('filter-save-btn').addEventListener('click', async () => {
      const payload = {
        max_track_length: parseInt($('filter-max-length').value, 10),
        min_track_length: parseInt($('filter-min-length').value, 10),
        music_only: $('filter-music-only').checked
      };
      try {
        await api('/api/settings/filters', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const msg = $('filter-save-msg');
        msg.style.display = 'inline';
        setTimeout(() => { msg.style.display = 'none'; }, 2000);
      } catch (err) {
        alert('Speichern fehlgeschlagen: ' + err.message);
      }
    });

    $('block-add-btn').addEventListener('click', async () => {
      const input = $('block-videoid-input');
      const raw = input.value.trim();
      if (!raw) return;

      const id = extractYouTubeId(raw);
      if (!id) {
        alert('Konnte keine gültige YouTube-Video-ID erkennen.');
        return;
      }

      try {
        const r = await api('/api/settings/filters/block', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: id })
        });
        renderBlocklist(r.blocked_video_ids || []);
        input.value = '';
      } catch (err) {
        alert('Blockieren fehlgeschlagen: ' + err.message);
      }
    });
  }
  // Extract video ID from various YouTube URL formats, or return as-is if it looks like a raw ID
  function extractYouTubeId(input) {
    if (!input) return null;
    const trimmed = input.trim();

    // Raw 11-char ID (YouTube IDs are always 11 chars: a-z A-Z 0-9 _ -)
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

    // Try URL parsing
    try {
      const url = new URL(trimmed);

      // youtu.be/VIDEOID
      if (url.hostname === 'youtu.be') {
        const id = url.pathname.slice(1).split('/')[0];
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
      }

      // youtube.com/watch?v=VIDEOID  or  music.youtube.com/watch?v=VIDEOID
      if (url.hostname.endsWith('youtube.com')) {
        const v = url.searchParams.get('v');
        if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

        // youtube.com/embed/VIDEOID  or  youtube.com/shorts/VIDEOID
        const pathMatch = url.pathname.match(/\/(embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
        if (pathMatch) return pathMatch[2];
      }
    } catch {}

    // Last resort: regex on the raw input (e.g. paste with extra params/spaces)
    const m = trimmed.match(/[a-zA-Z0-9_-]{11}/);
    if (m) return m[0];

    return null;
  }
})();
