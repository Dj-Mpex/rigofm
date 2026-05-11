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
    await refreshAll();
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
    if (socket) socket.emit('session:join', { sessionCode: session.code });
  }

  // --- Socket ---
  function initSocket() {
    if (socket) return;
    socket = io();
    socket.on('connect', () => $('connection-status').classList.add('connected'));
    socket.on('disconnect', () => $('connection-status').classList.remove('connected'));
    socket.on('queue:updated', () => {
      refreshQueue();
      refreshGuests();
    });
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
          <div class="track-sub">${escapeHtml(t.artist || '')} · <span class="by">@${escapeHtml(t.added_by_name)}</span></div>
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
      item.innerHTML = `
        <span class="name">${escapeHtml(g.name)}</span>
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
})();
