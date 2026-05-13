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
    bindModeToggle();
    bindDjProfileModal();
    bindVisualsUI();

    // Charts toggle: hard-bind directly on the row via event delegation
    const chartsRow = document.getElementById('dj-charts-row');
    if (chartsRow) {
      chartsRow.addEventListener('click', async (ev) => {
        const link = ev.target.closest('[data-charts-val]');
        if (!link) return;
        ev.preventDefault();
        const enabled = link.getAttribute('data-charts-val') === 'true';
        console.log('[charts] click', enabled);

        // Update button state IMMEDIATELY (optimistic UI)
        const onLink = document.getElementById('dj-charts-on-link');
        const offLink = document.getElementById('dj-charts-off-link');
        if (onLink) onLink.classList.toggle('is-active', enabled);
        if (offLink) offLink.classList.toggle('is-active', !enabled);

        try {
          await api('/api/visuals/charts-overlay', { method: 'PUT', body: JSON.stringify({ enabled }) });
          // Don't call loadVisuals() — it re-renders and overwrites our state
          // Just update the summary status text
          const status = document.getElementById('dj-visuals-summary-status');
          if (status) {
            const current = status.textContent || '';
            const parts = current.split(' · ');
            if (parts.length >= 2) {
              parts[2] = enabled ? 'Charts an' : 'Charts aus';
              status.textContent = parts.slice(0, 3).join(' · ');
            }
          }
        } catch (e) {
          // Revert on error
          if (onLink) onLink.classList.toggle('is-active', !enabled);
          if (offLink) offLink.classList.toggle('is-active', enabled);
          alert(e.message);
        }
      });
      console.log('[charts] row listener attached');
    } else {
      console.warn('[charts] row not found at bind time');
    }

    bindArchiveUI();
    bindLivestreamAdminUI();
    await loadMode();
    bootLiveDjStateOnce();
    loadLivestreamAdmin();
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
    if ($('mode-toggle')) $('mode-toggle').style.display = 'none';
  }

  function renderSessionActive(session) {
    $('no-session-state').style.display = 'none';
    $('active-session-state').style.display = 'block';
    if ($('mode-toggle')) $('mode-toggle').style.display = 'flex';
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
      if (document.body.classList.contains('live-dj-active')) loadDjView();
    });
    socket.on('config:changed', () => {
      loadMode();
      if (document.body.classList.contains('live-dj-active')) loadDjView();
      loadLivestreamAdmin();
    });
    socket.on('pending:updated', () => {
      if (document.body.classList.contains('live-dj-active')) loadDjView();
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
        <button class="guest-kick-btn" data-kick-id="${escapeHtml(g.id)}" data-kick-name="${escapeHtml(g.name)}" title="Gast rauswerfen">×</button>
      `;
      item.querySelector('.guest-kick-btn').addEventListener('click', () => {
        kickGuest(g.id, g.name);
      });
      list.appendChild(item);
    });
  }

  async function kickGuest(id, name) {
    if (!confirm(`${name} wirklich aus der Party entfernen?`)) return;
    try {
      await api(`/api/guests/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ adminPassword })
      });
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    }
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
      $('filter-cooldown').value = r.track_cooldown_minutes;
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
        music_only: $('filter-music-only').checked,
        track_cooldown_minutes: parseInt($('filter-cooldown').value, 10)
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
  // === Tab switching ===
  document.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset.tab;
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.admin-tab-content').forEach(s => s.style.display = 'none');
      const section = document.getElementById(`admin-tab-${tabName}`);
      if (section) section.style.display = 'block';
      if (tabName === 'dj') loadDjView();
      if (tabName === 'history') loadHistory();
      if (tabName === 'charts') loadCharts();
    });
  });

  async function loadHistory() {
    try {
      const r = await api('/api/tracks/history');
      renderHistory(r.history || []);
    } catch (err) {
      console.error('Load history error:', err);
    }
  }

  function renderHistory(items) {
    const container = $('history-list');
    if (!items.length) {
      container.innerHTML = '<p style="color: var(--color-text-muted);">Noch nichts gespielt.</p>';
      return;
    }
    container.innerHTML = items.map(t => {
      const time = new Date(t.played_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      const dur = formatDuration(t.duration || 0);
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const scoreClass = t.score > 0 ? 'positive' : t.score < 0 ? 'negative' : '';
      const scoreSign = t.score > 0 ? '+' : '';
      return `
        <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); background: var(--color-bg-elevated); border-radius: var(--radius-md);">
          <img src="${escapeHtml(t.thumbnail || '')}" alt="" style="width: 56px; height: 56px; border-radius: var(--radius-sm); object-fit: cover; flex-shrink: 0;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(t.title)}</div>
            <div style="color: var(--color-text-muted); font-size: var(--font-size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
              ${escapeHtml(t.artist || '')} · ${emoji}${escapeHtml(t.added_by_name || '?')}
            </div>
          </div>
          <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px; flex-shrink: 0; font-size: var(--font-size-sm);">
            <span style="color: var(--color-text-muted);">${time}</span>
            <span style="color: var(--color-text-muted);">${dur}</span>
            <span class="${scoreClass}" style="font-weight: 600;">${scoreSign}${t.score}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function formatDuration(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  async function loadCharts() {
    try {
      const r = await api('/api/sessions/charts');
      if (!r.charts) {
        $('charts-stats').innerHTML = '<p style="color: var(--color-text-muted);">Keine aktive Session.</p>';
        $('charts-tracks').innerHTML = '';
        $('charts-wishers').innerHTML = '';
        $('charts-voters').innerHTML = '';
        return;
      }
      renderChartsStats(r.charts.stats);
      renderChartsTracks(r.charts.top_tracks);
      renderChartsList('charts-wishers', r.charts.top_wishers, 'track_count', 'Tracks');
      renderChartsList('charts-voters', r.charts.top_voters, 'vote_count', 'Votes');
    } catch (err) {
      console.error('Load charts error:', err);
    }
  }

  function renderChartsStats(stats) {
    const items = [
      { label: 'Gäste', value: stats.total_guests || 0 },
      { label: 'Wünsche', value: stats.total_tracks || 0 },
      { label: 'Gespielt', value: stats.played_tracks || 0 },
      { label: 'Votes', value: stats.total_votes || 0 }
    ];
    $('charts-stats').innerHTML = items.map(i => `
      <div style="background: var(--color-bg-elevated); border-radius: var(--radius-md); padding: var(--space-4); text-align: center;">
        <div style="font-size: var(--font-size-2xl); font-weight: 700; color: var(--color-primary);">${i.value}</div>
        <div style="color: var(--color-text-muted); font-size: var(--font-size-sm); text-transform: uppercase; letter-spacing: 0.05em;">${i.label}</div>
      </div>
    `).join('');
  }

  function renderChartsTracks(tracks) {
    const container = $('charts-tracks');
    if (!tracks || !tracks.length) {
      container.innerHTML = '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Noch keine Tracks.</p>';
      return;
    }
    container.innerHTML = tracks.map((t, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      return `
        <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--color-bg-elevated); border-radius: var(--radius-sm);">
          <span style="font-size: var(--font-size-lg); min-width: 30px;">${medal}</span>
          <img src="${escapeHtml(t.thumbnail || '')}" alt="" style="width: 36px; height: 36px; border-radius: 4px; object-fit: cover; flex-shrink: 0;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--font-size-sm);">${escapeHtml(t.title)}</div>
            <div style="color: var(--color-text-muted); font-size: var(--font-size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${emoji}${escapeHtml(t.added_by_name || '?')}</div>
          </div>
          <div style="font-weight: 700; color: var(--color-primary); flex-shrink: 0;">${t.score > 0 ? '+' : ''}${t.score}</div>
        </div>
      `;
    }).join('');
  }

  function renderChartsList(elId, items, valueKey, valueLabel) {
    const container = $(elId);
    if (!items || !items.length) {
      container.innerHTML = '<p style="color: var(--color-text-muted); font-size: var(--font-size-sm);">Noch keine Daten.</p>';
      return;
    }
    container.innerHTML = items.map((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const emoji = u.emoji ? u.emoji + ' ' : '';
      return `
        <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); background: var(--color-bg-elevated); border-radius: var(--radius-sm);">
          <span style="font-size: var(--font-size-lg); min-width: 30px;">${medal}</span>
          <div style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${emoji}${escapeHtml(u.name || '?')}</div>
          <div style="font-weight: 700; color: var(--color-primary); flex-shrink: 0;">${u[valueKey]} ${valueLabel}</div>
        </div>
      `;
    }).join('');
  }

  // === Mode Toggle ===
  let currentMode = 'auto';

  async function loadMode() {
    try {
      const { mode } = await api('/api/sessions/mode');
      currentMode = mode || 'auto';
      setModeButtonActive(currentMode);
      const toggle = $('mode-toggle');
      if (toggle) toggle.style.display = currentSession ? 'flex' : 'none';
    } catch (err) {
      console.error('loadMode:', err);
    }
  }

  function setModeButtonActive(mode) {
    const b1 = $('mode-btn-auto');
    const b2 = $('mode-btn-live');
    if (b1) b1.classList.toggle('is-active', mode === 'auto');
    if (b2) b2.classList.toggle('is-active', mode === 'live-dj');

    // Toggle body class for cockpit fullscreen mode
    document.body.classList.toggle('live-dj-active', mode === 'live-dj');

    // When switching INTO live mode, force-activate the DJ tab
    if (mode === 'live-dj') {
      document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
      const djTab = document.querySelector('.admin-tab[data-tab="dj"]');
      if (djTab) djTab.classList.add('active');
      document.querySelectorAll('.admin-tab-content').forEach(s => s.style.display = 'none');
      const djSec = $('admin-tab-dj');
      if (djSec) djSec.style.display = 'block';
      loadDjView();
    }
  }

  async function setMode(mode) {
    try {
      await api('/api/sessions/mode', { method: 'PUT', body: JSON.stringify({ mode }) });
      setModeButtonActive(mode);
      if (mode === 'live-dj') {
        startDjPolling();
      } else {
        stopDjPolling();
      }
    } catch (e) {
      alert('Konnte Modus nicht setzen: ' + e.message);
    }
  }

  function bindModeToggle() {
    document.querySelectorAll('.admin-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.mode !== currentMode) setMode(btn.dataset.mode);
      });
    });
  }

  // === DJ View ===
  let _djPollTimer = null;

  async function loadDjView() {
    try {
      const [pendingRes, queueRes, guestsRes] = await Promise.all([
        api('/api/tracks/pending'),
        api('/api/tracks/queue'),
        api(`/api/sessions/active/guests?adminPassword=${encodeURIComponent(adminPassword)}`).catch(() => ({ guests: [] }))
      ]);
      const allQueue = queueRes.queue || [];
      const playing = allQueue.find(t => t.status === 'playing');
      const queued = allQueue
        .filter(t => t.status === 'queued')
        .sort((a, b) => (b.score || 0) - (a.score || 0));

      renderDjNowPlaying(playing);
      renderDjQueue(queued);
      renderDjPending(pendingRes.pending || []);
      renderDjGuestsSidebar(guestsRes.guests || []);
      loadDjProfiles();
      loadVisuals();
    } catch (e) {
      console.error('Load DJ view:', e);
    }
  }

  function renderDjGuestsSidebar(guests) {
    const sidebar = $('dj-guests-sidebar');
    if (!sidebar) return;

    const countEl = sidebar.querySelector('.dj-guests-sidebar-count');
    if (countEl) countEl.textContent = guests.length;

    const list = sidebar.querySelector('.dj-guests-sidebar-list');
    if (!list) return;

    if (guests.length === 0) {
      list.innerHTML = '<p class="dj-empty-state">Noch keine Gäste</p>';
      return;
    }

    list.innerHTML = '';
    guests.forEach(g => {
      const row = document.createElement('div');
      row.className = 'dj-guest-row';
      row.innerHTML = `
        <span class="dj-guest-emoji">${g.emoji || '🎵'}</span>
        <span class="dj-guest-name">${escapeHtml(g.name)}</span>
        <span class="dj-guest-tracks">${g.track_count}</span>
        <button class="dj-guest-kick-btn" title="Rauswerfen">×</button>
      `;
      row.querySelector('.dj-guest-kick-btn').addEventListener('click', () => {
        kickGuest(g.id, g.name);
      });
      list.appendChild(row);
    });
  }

  function startDjPolling() {
    stopDjPolling();
    _djPollTimer = setInterval(() => {
      if (document.body.classList.contains('live-dj-active')) {
        loadDjView();
      }
    }, 5000);
  }
  function stopDjPolling() {
    if (_djPollTimer) { clearInterval(_djPollTimer); _djPollTimer = null; }
  }

  function renderDjNowPlaying(track) {
    const c = $('dj-now-card');
    if (!c) return;
    if (!track) {
      c.innerHTML = '<p class="dj-empty-state">Kein Track läuft gerade.</p>';
      return;
    }
    const emoji = track.added_by_emoji ? track.added_by_emoji + ' ' : '';
    const msg = track.guest_message
      ? `<div class="dj-now-msg">„${escapeHtml(track.guest_message)}"</div>`
      : '';
    c.innerHTML = `
      <div class="dj-now-card-inner">
        <img src="${escapeHtml(track.thumbnail || '')}" alt="" class="dj-now-thumb">
        <div class="dj-now-info">
          <div class="dj-now-title">${escapeHtml(track.title || '')}</div>
          <div class="dj-now-sub">${escapeHtml(track.artist || '')}</div>
          <div class="dj-now-by">${emoji}${escapeHtml(track.added_by_name || '?')}</div>
          ${msg}
        </div>
        <div class="dj-now-action">
          <span class="dj-now-live-indicator">▶ LÄUFT</span>
          <button class="dj-btn-skip" data-skip="${track.id}">⏭ Skip</button>
          <button class="dj-btn-played-small" data-played="${track.id}">Als gespielt markieren</button>
        </div>
      </div>
    `;
    c.querySelector('[data-played]')?.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-played');
      try {
        await api(`/api/tracks/${id}/mark-played`, { method: 'POST', body: '{}' });
        loadDjView();
      } catch (err) { alert(err.message); }
    });
    c.querySelector('[data-skip]')?.addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-skip');
      try {
        await api(`/api/tracks/${id}/mark-played`, { method: 'POST', body: '{}' });
        loadDjView();
      } catch (err) { alert(err.message); }
    });
  }

  function renderDjQueue(items) {
    const badge = $('dj-queue-count-badge');
    if (badge) badge.textContent = items.length;

    const c = $('dj-queue-list');
    if (!c) return;
    if (!items.length) {
      c.innerHTML = '<p class="dj-empty-state">Queue ist leer.</p>';
      return;
    }
    c.innerHTML = items.map((t, i) => {
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const msg = t.guest_message
        ? `<div class="dj-track-msg">„${escapeHtml(t.guest_message)}"</div>`
        : '';
      const sign = t.score > 0 ? '+' : '';
      return `
        <div class="dj-track-row">
          <span class="dj-track-rank">${i + 1}</span>
          <img src="${escapeHtml(t.thumbnail || '')}" class="dj-track-thumb-md" alt="">
          <div class="dj-track-main">
            <div class="dj-track-title">${escapeHtml(t.title || '')}</div>
            <div class="dj-track-sub">${escapeHtml(t.artist || '')} · ${emoji}${escapeHtml(t.added_by_name || '?')}</div>
            ${msg}
          </div>
          <div class="dj-track-score">
            <span class="dj-track-score-num">${sign}${t.score || 0}</span>
            <span class="dj-track-score-label">Votes</span>
          </div>
          <div class="dj-track-actions">
            <button class="dj-btn-play" data-startplay="${escapeHtml(t.id)}">▶ Jetzt spielen</button>
          </div>
        </div>
      `;
    }).join('');
    c.querySelectorAll('[data-startplay]').forEach(b => b.addEventListener('click', async () => {
      const id = b.getAttribute('data-startplay');
      try {
        await api(`/api/tracks/${id}/mark-playing-manual`, { method: 'POST', body: '{}' });
        loadDjView();
      } catch (e) { alert(e.message); }
    }));
  }

  function renderDjPending(items) {
    const badge = $('dj-pending-count-badge');
    if (badge) badge.textContent = items.length;

    const c = $('dj-pending-list');
    if (!c) return;
    if (!items.length) {
      c.innerHTML = '<p class="dj-empty-state">Keine offenen Wünsche.</p>';
      return;
    }
    c.innerHTML = items.map(t => {
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const msg = t.guest_message
        ? `<div class="dj-track-msg">„${escapeHtml(t.guest_message)}"</div>`
        : '';
      return `
        <div class="dj-track-row">
          <img src="${escapeHtml(t.thumbnail || '')}" class="dj-track-thumb-md" alt="">
          <div class="dj-track-main">
            <div class="dj-track-title">${escapeHtml(t.title || '')}</div>
            <div class="dj-track-sub">${escapeHtml(t.artist || '')} · ${emoji}${escapeHtml(t.added_by_name || '?')}</div>
            ${msg}
          </div>
          <div class="dj-track-actions">
            <button class="dj-btn-approve" data-approve="${escapeHtml(t.id)}">✓ Annehmen</button>
            <button class="dj-btn-reject" data-reject="${escapeHtml(t.id)}">✕ Ablehnen</button>
          </div>
        </div>
      `;
    }).join('');
    c.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
      const id = b.getAttribute('data-approve');
      try {
        await api(`/api/tracks/${id}/approve`, { method: 'POST', body: '{}' });
        loadDjView();
      } catch (e) { alert(e.message); }
    }));
    c.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', async () => {
      const id = b.getAttribute('data-reject');
      const note = prompt('Optional: Notiz warum abgelehnt (nur für dich)?') || '';
      try {
        await api(`/api/tracks/${id}/reject`, { method: 'POST', body: JSON.stringify({ dj_note: note }) });
        loadDjView();
      } catch (e) { alert(e.message); }
    }));
  }

  async function bootLiveDjStateOnce() {
    try {
      const r = await api('/api/sessions/mode');
      const mode = r.mode || 'auto';
      setModeButtonActive(mode);
      if (mode === 'live-dj') startDjPolling();
    } catch {}
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

  // === DJ Profile Management ===
  let _editingProfileId = null;

  async function loadDjProfiles() {
    try {
      const r = await api('/api/dj-profiles');
      renderDjProfileList(r.profiles || [], r.active_id || '');
    } catch (e) {
      console.error('Load dj profiles:', e);
    }
  }

  function renderDjProfileList(profiles, activeId) {
    const c = $('dj-profile-list');
    if (!c) return;

    // Always include a "None" option at the start
    const noneActive = !activeId || activeId === '';
    let html = `
      <div class="dj-profile-card is-none ${noneActive ? 'is-active' : ''}" data-set-active="">
        <div class="dj-profile-card-logo-placeholder">—</div>
        <span class="dj-profile-card-name dj-profile-card-name-placeholder">Kein DJ aktiv</span>
      </div>
    `;

    html += profiles.map(p => {
      const isActive = p.id === activeId;
      const logo = p.logo_filename
        ? `<img src="/api/dj-profiles/uploads/${escapeHtml(p.logo_filename)}" class="dj-profile-card-logo" alt="">`
        : `<div class="dj-profile-card-logo-placeholder">🎧</div>`;
      return `
        <div class="dj-profile-card ${isActive ? 'is-active' : ''}" data-set-active="${escapeHtml(p.id)}">
          ${logo}
          <span class="dj-profile-card-name">${escapeHtml(p.name)}</span>
          <div class="dj-profile-card-actions">
            <button class="dj-profile-card-btn" data-edit="${escapeHtml(p.id)}" title="Bearbeiten">✎</button>
            <button class="dj-profile-card-btn dj-profile-delete" data-delete="${escapeHtml(p.id)}" title="Löschen">×</button>
          </div>
        </div>
      `;
    }).join('');

    c.innerHTML = html;

    // Click on card → set as active
    c.querySelectorAll('[data-set-active]').forEach(el => {
      el.addEventListener('click', async (e) => {
        // Ignore if click was on edit/delete button
        if (e.target.closest('[data-edit]') || e.target.closest('[data-delete]')) return;
        const id = el.getAttribute('data-set-active');
        try {
          await api(`/api/dj-profiles/active/${encodeURIComponent(id || 'none')}`, { method: 'PUT', body: '{}' });
          loadDjProfiles();
        } catch (err) { alert(err.message); }
      });
    });

    // Edit button
    c.querySelectorAll('[data-edit]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.getAttribute('data-edit');
        const profile = profiles.find(p => p.id === id);
        if (profile) openDjProfileModal(profile);
      });
    });

    // Delete button
    c.querySelectorAll('[data-delete]').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.getAttribute('data-delete');
        if (!confirm('DJ-Profil wirklich löschen?')) return;
        try {
          await api(`/api/dj-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
          loadDjProfiles();
        } catch (err) { alert(err.message); }
      });
    });
  }

  function openDjProfileModal(existingProfile) {
    _editingProfileId = existingProfile ? existingProfile.id : null;
    const modal = $('dj-profile-modal');
    const title = $('dj-profile-modal-title');
    const nameInput = $('dj-profile-name-input');
    const fileInput = $('dj-profile-logo-input');
    const currentLogoWrap = $('dj-profile-current-logo');
    const currentLogoImg = $('dj-profile-current-logo-img');
    const errEl = $('dj-profile-modal-error');

    if (existingProfile) {
      title.textContent = 'DJ-Profil bearbeiten';
      nameInput.value = existingProfile.name;
      if (existingProfile.logo_filename) {
        currentLogoImg.src = `/api/dj-profiles/uploads/${existingProfile.logo_filename}`;
        currentLogoWrap.style.display = 'block';
      } else {
        currentLogoWrap.style.display = 'none';
      }
    } else {
      title.textContent = 'Neues DJ-Profil';
      nameInput.value = '';
      currentLogoWrap.style.display = 'none';
    }
    fileInput.value = '';
    errEl.style.display = 'none';
    modal.classList.add('is-visible');
    setTimeout(() => nameInput.focus(), 100);
  }

  function closeDjProfileModal() {
    $('dj-profile-modal').classList.remove('is-visible');
    _editingProfileId = null;
  }

  async function saveDjProfile() {
    const nameInput = $('dj-profile-name-input');
    const fileInput = $('dj-profile-logo-input');
    const errEl = $('dj-profile-modal-error');
    const saveBtn = $('dj-profile-save');

    const name = nameInput.value.trim();
    if (!name) {
      errEl.textContent = 'Name ist erforderlich.';
      errEl.style.display = 'block';
      return;
    }

    const formData = new FormData();
    formData.append('name', name);
    if (fileInput.files[0]) {
      formData.append('logo', fileInput.files[0]);
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere…';
    errEl.style.display = 'none';

    try {
      const url = _editingProfileId
        ? `/api/dj-profiles/${encodeURIComponent(_editingProfileId)}`
        : '/api/dj-profiles';
      const method = _editingProfileId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Fehler');
      closeDjProfileModal();
      loadDjProfiles();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern';
    }
  }

  function bindDjProfileModal() {
    $('dj-profile-add-btn')?.addEventListener('click', () => openDjProfileModal(null));
    $('dj-profile-cancel')?.addEventListener('click', closeDjProfileModal);
    $('dj-profile-save')?.addEventListener('click', saveDjProfile);
    $('dj-profile-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'dj-profile-modal') closeDjProfileModal();
    });
  }

  // === Visuals Presets Management ===
  let _editingVisualsId = null;

  async function loadVisuals() {
    try {
      const r = await api('/api/visuals');
      renderVisualsList(r.presets || [], r.active_id || '');
      renderSourceToggle(r.tv_source || 'tracks');
      renderMuteToggle(r.tv_muted === true);
      renderChartsToggle(r.charts_overlay !== false);
      renderVisualsSummary(r);
    } catch (e) {
      console.error('Load visuals:', e);
    }
  }

  function renderVisualsSummary(r) {
    const status = $('dj-visuals-summary-status');
    if (!status) return;
    const sourceLabel = r.tv_source === 'visuals' ? 'Visuals' : r.tv_source === 'dj-visuals' ? 'DJ-Visuals' : 'Tracks';
    const muteLabel = r.tv_muted ? 'stumm' : 'Audio an';
    const chartsLabel = r.charts_overlay === false ? 'Charts aus' : 'Charts an';
    status.textContent = `${sourceLabel} · ${muteLabel} · ${chartsLabel}`;
  }

  function renderSourceToggle(source) {
    const a = $('dj-source-tracks');
    const b = $('dj-source-visuals');
    const c = $('dj-source-djvisuals');
    if (a) a.classList.toggle('is-active', source === 'tracks');
    if (b) b.classList.toggle('is-active', source === 'visuals');
    if (c) c.classList.toggle('is-active', source === 'dj-visuals');
  }

  function renderMuteToggle(muted) {
    const a = $('dj-mute-off');
    const b = $('dj-mute-on');
    if (a) a.classList.toggle('is-active', !muted);
    if (b) b.classList.toggle('is-active', muted);
  }

  function renderChartsToggle(enabled) {
    const a = document.getElementById('dj-charts-on-link');
    const b = document.getElementById('dj-charts-off-link');
    if (a) a.classList.toggle('is-active', enabled);
    if (b) b.classList.toggle('is-active', !enabled);
  }

  async function setChartsOverlay(enabled) {
    try {
      await api('/api/visuals/charts-overlay', { method: 'PUT', body: JSON.stringify({ enabled }) });
      loadVisuals();
    } catch (e) { alert(e.message); }
  }

  // Expose for inline onclick handlers (defensive — bind-via-addEventListener was unreliable)
  window.__setChartsOverlay = setChartsOverlay;

  function renderVisualsList(presets, activeId) {
    const c = $('dj-visuals-list');
    if (!c) return;

    if (!presets.length) {
      c.innerHTML = '<p class="dj-empty-state">Noch keine Visuals-Presets.</p>';
      return;
    }

    c.innerHTML = presets.map(p => {
      const isActive = p.id === activeId;
      const typeLabel = p.source_type === 'playlist' ? 'PLAYLIST' : 'VIDEO';
      return `
        <div class="dj-profile-card ${isActive ? 'is-active' : ''}" data-vset-active="${escapeHtml(p.id)}">
          <div class="dj-profile-card-logo-placeholder">🎬</div>
          <span class="dj-profile-card-name">
            ${escapeHtml(p.name)}
            <span class="dj-visuals-preset-type">${typeLabel}</span>
          </span>
          <div class="dj-profile-card-actions">
            <button class="dj-profile-card-btn" data-vedit="${escapeHtml(p.id)}" title="Bearbeiten">✎</button>
            <button class="dj-profile-card-btn dj-profile-delete" data-vdelete="${escapeHtml(p.id)}" title="Löschen">×</button>
          </div>
        </div>
      `;
    }).join('');

    c.querySelectorAll('[data-vset-active]').forEach(el => {
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-vedit]') || e.target.closest('[data-vdelete]')) return;
        const id = el.getAttribute('data-vset-active');
        try {
          await api(`/api/visuals/active/${encodeURIComponent(id)}`, { method: 'PUT', body: '{}' });
          loadVisuals();
        } catch (err) { alert(err.message); }
      });
    });

    c.querySelectorAll('[data-vedit]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.getAttribute('data-vedit');
        const preset = presets.find(p => p.id === id);
        if (preset) openVisualsModal(preset);
      });
    });

    c.querySelectorAll('[data-vdelete]').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.getAttribute('data-vdelete');
        if (!confirm('Visuals-Preset wirklich löschen?')) return;
        try {
          await api(`/api/visuals/${encodeURIComponent(id)}`, { method: 'DELETE' });
          loadVisuals();
        } catch (err) { alert(err.message); }
      });
    });
  }

  function openVisualsModal(existingPreset) {
    _editingVisualsId = existingPreset ? existingPreset.id : null;
    const modal = $('visuals-preset-modal');
    const title = $('visuals-preset-modal-title');
    const nameInput = $('visuals-preset-name-input');
    const sourceInput = $('visuals-preset-source-input');
    const errEl = $('visuals-preset-modal-error');

    if (existingPreset) {
      title.textContent = 'Visuals-Preset bearbeiten';
      nameInput.value = existingPreset.name;
      const sourceDisplay = existingPreset.source_type === 'playlist'
        ? `https://www.youtube.com/playlist?list=${existingPreset.source_id}`
        : `https://www.youtube.com/watch?v=${existingPreset.source_id}`;
      sourceInput.value = sourceDisplay;
    } else {
      title.textContent = 'Neues Visuals-Preset';
      nameInput.value = '';
      sourceInput.value = '';
    }
    errEl.style.display = 'none';
    modal.classList.add('is-visible');
    setTimeout(() => nameInput.focus(), 100);
  }

  function closeVisualsModal() {
    $('visuals-preset-modal').classList.remove('is-visible');
    _editingVisualsId = null;
  }

  async function saveVisualsPreset() {
    const nameInput = $('visuals-preset-name-input');
    const sourceInput = $('visuals-preset-source-input');
    const errEl = $('visuals-preset-modal-error');
    const saveBtn = $('visuals-preset-save');

    const name = nameInput.value.trim();
    const source = sourceInput.value.trim();
    if (!name || !source) {
      errEl.textContent = 'Name und YouTube-Quelle erforderlich.';
      errEl.style.display = 'block';
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichere…';
    errEl.style.display = 'none';

    try {
      const url = _editingVisualsId
        ? `/api/visuals/${encodeURIComponent(_editingVisualsId)}`
        : '/api/visuals';
      const method = _editingVisualsId ? 'PUT' : 'POST';
      await api(url, { method, body: JSON.stringify({ name, source }) });
      closeVisualsModal();
      loadVisuals();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern';
    }
  }

  async function setTvSource(source) {
    try {
      await api('/api/visuals/tv-source', { method: 'PUT', body: JSON.stringify({ source }) });
      renderSourceToggle(source);
      loadVisuals();
    } catch (e) { alert(e.message); }
  }

  async function setTvMute(muted) {
    try {
      await api('/api/visuals/tv-mute', { method: 'PUT', body: JSON.stringify({ muted }) });
      renderMuteToggle(muted);
      loadVisuals();
    } catch (e) { alert(e.message); }
  }

  function bindVisualsUI() {
    $('dj-visuals-add-btn')?.addEventListener('click', () => openVisualsModal(null));
    $('visuals-preset-cancel')?.addEventListener('click', closeVisualsModal);
    $('visuals-preset-save')?.addEventListener('click', saveVisualsPreset);
    $('visuals-preset-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'visuals-preset-modal') closeVisualsModal();
    });
    $('dj-source-tracks')?.addEventListener('click', () => setTvSource('tracks'));
    $('dj-source-visuals')?.addEventListener('click', () => setTvSource('visuals'));
    $('dj-source-djvisuals')?.addEventListener('click', () => setTvSource('dj-visuals'));
    $('dj-mute-off')?.addEventListener('click', () => setTvMute(false));
    $('dj-mute-on')?.addEventListener('click', () => setTvMute(true));
    $('dj-charts-on')?.addEventListener('click', () => setChartsOverlay(true));
    $('dj-charts-off')?.addEventListener('click', () => setChartsOverlay(false));

    // Delegated fallback: catches any data-charts button click even if direct bind failed
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-charts]');
      if (!btn) return;
      const enabled = btn.getAttribute('data-charts') === 'true';
      setChartsOverlay(enabled);
    });
  }

  // === Sessions Archive ===
  function bindArchiveUI() {
    const toggle = document.getElementById('archive-toggle-btn');
    const menu = document.getElementById('archive-menu');
    const closeBtn = document.getElementById('archive-close-btn');

    if (toggle) {
      toggle.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isOpen = menu.style.display === 'flex' || menu.style.display === 'block';
        if (isOpen) {
          menu.style.display = 'none';
        } else {
          menu.style.display = 'flex';
          loadArchive();
        }
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', () => { menu.style.display = 'none'; });

    // Close on outside click
    document.addEventListener('click', (ev) => {
      if (menu && menu.style.display !== 'none' && !menu.contains(ev.target) && ev.target !== toggle) {
        menu.style.display = 'none';
      }
    });
  }

  async function loadArchive() {
    try {
      const r = await api('/api/sessions/archive');
      renderArchive(r.sessions || []);
    } catch (err) {
      console.error('Load archive:', err);
    }
  }

  function renderArchive(sessions) {
    const c = document.getElementById('archive-list');
    if (!c) return;

    if (!sessions.length) {
      c.innerHTML = '<p class="archive-empty">Noch keine Sessions vorhanden.</p>';
      return;
    }

    const hasActive = sessions.some(s => s.active === 1);

    c.innerHTML = sessions.map(s => {
      const date = new Date(s.created_at).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      });
      const liveBadge = s.active === 1 ? '<span class="archive-card-livebadge">● Live</span>' : '';
      const topTrack = s.top_track_title
        ? `<div class="archive-card-toptrack">🏆 ${escapeHtml(s.top_track_title)}${s.top_track_artist ? ' · ' + escapeHtml(s.top_track_artist) : ''}</div>`
        : '';
      const canReactivate = !hasActive && s.active !== 1;
      const canDelete = s.active !== 1;

      return `
        <div class="archive-card ${s.active === 1 ? 'is-active' : ''}">
          <div class="archive-card-header">
            <span class="archive-card-name">${escapeHtml(s.name || '–')}</span>
            ${liveBadge}
          </div>
          <div class="archive-card-meta">
            <span class="archive-card-meta-item">📅 ${date}</span>
            <span class="archive-card-meta-item">🎵 ${s.track_count || 0}</span>
            <span class="archive-card-meta-item">👥 ${s.guest_count || 0}</span>
          </div>
          ${topTrack}
          <div class="archive-card-actions">
            <button class="archive-card-btn" data-reactivate="${escapeHtml(s.id)}" ${canReactivate ? '' : 'disabled'} title="${canReactivate ? '' : (hasActive ? 'Beende erst die aktive Session' : 'Bereits aktiv')}">↻ Reaktivieren</button>
            <button class="archive-card-btn is-danger" data-delete="${escapeHtml(s.id)}" ${canDelete ? '' : 'disabled'} title="${canDelete ? '' : 'Aktive Session zuerst beenden'}">× Löschen</button>
          </div>
        </div>
      `;
    }).join('');

    c.querySelectorAll('[data-reactivate]').forEach(b => {
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-reactivate');
        if (!confirm('Diese Session reaktivieren? Sie wird zur aktiven Session.')) return;
        try {
          await api(`/api/sessions/${encodeURIComponent(id)}/reactivate`, { method: 'POST', body: '{}' });
          document.getElementById('archive-menu').style.display = 'none';
          location.reload();
        } catch (err) { alert(err.message); }
      });
    });

    c.querySelectorAll('[data-delete]').forEach(b => {
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-delete');
        if (!confirm('Diese Session und alle ihre Daten endgültig löschen? Das kann nicht rückgängig gemacht werden.')) return;
        try {
          await api(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'DELETE' });
          loadArchive();
        } catch (err) { alert(err.message); }
      });
    });
  }

  // === Livestream Admin ===
  async function loadLivestreamAdmin() {
    try {
      const r = await api(`/api/livestream/admin?adminPassword=${encodeURIComponent(adminPassword)}`);
      const urlInput = document.getElementById('livestream-url-input');
      const statusInput = document.getElementById('livestream-status-input');
      const statusBadge = document.getElementById('livestream-current-status');
      if (urlInput) urlInput.value = r.streamUrl || '';
      if (statusInput) statusInput.value = r.statusUrl || '';
      if (statusBadge) statusBadge.textContent = r.online ? '🟢 Live' : '⚫ Offline';
    } catch (e) {
      console.error('Load livestream:', e);
    }
  }

  function bindLivestreamAdminUI() {
    const saveBtn = document.getElementById('livestream-save-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
      const streamUrl = document.getElementById('livestream-url-input').value.trim();
      const statusUrl = document.getElementById('livestream-status-input').value.trim();
      try {
        await api('/api/livestream/admin', {
          method: 'PUT',
          body: JSON.stringify({ adminPassword, streamUrl, statusUrl })
        });
        const msg = document.getElementById('livestream-save-msg');
        if (msg) {
          msg.style.display = 'inline';
          setTimeout(() => { msg.style.display = 'none'; }, 2000);
        }
        loadLivestreamAdmin();
      } catch (e) { alert(e.message); }
    });
  }
})();
