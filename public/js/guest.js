(() => {
  // ============================================
  // Confetti Engine (lightweight, no deps)
  // ============================================
  const confetti = (() => {
    const canvas = document.getElementById('confetti-canvas');
    const ctx = canvas ? canvas.getContext('2d') : null;
    let particles = [];
    let raf = null;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    if (canvas) {
      resize();
      window.addEventListener('resize', resize);
    }

    function spawn(count = 80) {
      if (!canvas || !ctx) return;
      const colors = ['#FF6B1A', '#FFA340', '#EDEDED', '#4ADE80', '#FF8540'];
      for (let i = 0; i < count; i++) {
        particles.push({
          x: canvas.width / 2 + (Math.random() - 0.5) * 100,
          y: canvas.height / 2,
          vx: (Math.random() - 0.5) * 14,
          vy: -8 - Math.random() * 10,
          gravity: 0.35,
          size: 4 + Math.random() * 6,
          color: colors[Math.floor(Math.random() * colors.length)],
          rotation: Math.random() * Math.PI * 2,
          rotSpeed: (Math.random() - 0.5) * 0.3,
          life: 1
        });
      }
      if (!raf) loop();
    }

    function loop() {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles = particles.filter(p => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.rotation += p.rotSpeed;
        p.life -= 0.008;
        if (p.life <= 0 || p.y > canvas.height + 50) return false;

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
        return true;
      });

      if (particles.length > 0) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }

    return { spawn };
  })();

  // Track which "my tracks" have already triggered confetti to avoid spam
  const _confettiSeen = new Set();

  function maybeConfetti(queue) {
    if (!state.guest) return;
    const top = queue.find(t => t.status === 'queued');
    if (!top) return;
    if (top.added_by_guest_id !== state.guest.id) return;
    if (_confettiSeen.has(top.id)) return;
    _confettiSeen.add(top.id);
    confetti.spawn(120);
    toast(`🎉 Dein Song "${top.title.slice(0, 30)}…" ist auf #1!`, 'success');
  }

  // ============================================
  // RIGO FM — Guest App
  // ============================================

  const STORAGE_KEY = 'rigofm_guest_v1';

  let state = {
    sessionCode: null,
    sessionId: null,
    sessionName: null,
    sessionMode: 'auto',
    guest: null,           // { id, name } once joined
    queue: [],
    pendingAction: null,   // queued action waiting for name modal
    socket: null,
    searchTimer: null,
    activeTab: 'queue'
  };

  // --- Element refs ---
  const $ = (id) => document.getElementById(id);

  // --- Utilities ---
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $(`view-${name}`).classList.add('active');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function initials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Deterministic color from name (HSL spread)
  function avatarBg(name) {
    if (!name) return 'var(--color-border)';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    const hue = h % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  function avatarHtml(name, size = 'sm', emoji = null) {
    if (emoji) {
      return `<span class="avatar avatar-${size}" style="background:transparent;font-size:1.1rem;">${emoji}</span>`;
    }
    return `<span class="avatar avatar-${size}" style="background:${avatarBg(name)}">${escapeHtml(initials(name))}</span>`;
  }

  function toast(msg, type = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    el.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // --- Storage ---
  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function saveStored(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }
  function clearStored() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }

  // --- Device ID (persistent across sessions, used for anti-abuse) ---
  function getDeviceId() {
    let id = null;
    try {
      id = localStorage.getItem('rigofm_device_v1');
    } catch {}
    if (!id) {
      id = crypto.randomUUID();
      try { localStorage.setItem('rigofm_device_v1', id); } catch {}
    }
    return id;
  }

  // --- Init / Boot ---
  async function boot() {
    // Determine session code from URL: /join/:code
    const match = window.location.pathname.match(/^\/join\/([A-Z0-9]+)/i);
    const codeFromUrl = match ? match[1].toUpperCase() : null;

    if (codeFromUrl) {
      // User came via QR / direct link with code → validate and load
      await loadSession(codeFromUrl);
    } else {
      // No code in URL → show code-entry screen
      bindCodeEntry();
      showView('code-entry');
      setTimeout(() => $('code-input').focus(), 200);
    }
  }

  async function loadSession(code) {
    try {
      const r = await api(`/api/sessions/by-code/${code}`);
      const session = r.session;

      state.sessionId = session.id;
      state.sessionCode = session.code;
      state.sessionName = session.name;

      try {
        const modeRes = await api('/api/sessions/mode');
        state.sessionMode = modeRes.mode || 'auto';
      } catch (e) {
        state.sessionMode = 'auto';
      }

      // Restore guest from storage if it matches this session
      const stored = loadStored();
      if (stored && stored.sessionCode === session.code && stored.guest) {
        state.guest = stored.guest;
      }
      updateProfileBadge();

      showView('app');
      initSocket();
      bindUI();
      await refreshQueue();
      loadGuestHistory();
      bindLivestreamUI();
      loadLivestreamConfig();
    } catch (err) {
      console.error('Load session error:', err);
      $('error-msg').textContent = err.message === 'Session not found or ended'
        ? 'Keine aktive Party mit diesem Code. Frag den DJ nach dem aktuellen Code.'
        : 'Verbindung zum Server fehlgeschlagen.';
      showView('error');
    }
  }

  function bindCodeEntry() {
    const input = $('code-input');
    const btn = $('code-submit');
    const errEl = $('code-error');

    // Auto-uppercase as user types
    input.addEventListener('input', (e) => {
      const cleaned = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (e.target.value !== cleaned) e.target.value = cleaned;
      errEl.style.display = 'none';
    });

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') submitCode();
    });

    btn.addEventListener('click', submitCode);

    async function submitCode() {
      const code = input.value.trim().toUpperCase();
      if (code.length < 4) {
        errEl.textContent = 'Bitte einen 6-stelligen Code eingeben.';
        errEl.style.display = 'block';
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Prüfe…';
      errEl.style.display = 'none';

      try {
        // Validate code by fetching session
        await api(`/api/sessions/by-code/${encodeURIComponent(code)}`);
        // Valid → redirect to /join/CODE
        window.location.href = `/join/${code}`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Beitreten';
        errEl.textContent = err.message === 'Session not found or ended'
          ? 'Code ungültig oder Party beendet.'
          : 'Fehler: ' + err.message;
        errEl.style.display = 'block';
      }
    }
  }

  // --- Socket ---
  function initSocket() {
    if (state.socket) return;
    state.socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    state.socket.on('connect', () => {
      $('g-conn-dot').classList.add('connected');
      state.socket.emit('session:join', { sessionCode: state.sessionCode });
      // Refresh on reconnect to catch missed events
      refreshQueue();
    });

    state.socket.on('disconnect', () => {
      $('g-conn-dot').classList.remove('connected');
    });

    state.socket.on('reconnect_attempt', (n) => {
      if (n === 3) toast('Verbindung wackelt …', 'error');
    });

    state.socket.on('queue:updated', () => { refreshQueue(); loadGuestHistory(); updateLivestreamMiniOverlay(); });

    state.socket.on('config:changed', async () => {
      try {
        const modeRes = await api('/api/sessions/mode');
        state.sessionMode = modeRes.mode || 'auto';
      } catch {}
    });

    state.socket.on('track:approved', (data) => {
      if (!data || data.guestId !== state.guest?.id) return;
      celebrateApproval();
    });

    state.socket.on('track:rejected', (data) => {
      if (!data || data.guestId !== state.guest?.id) return;
      // Quick vibration only, no confetti for rejection
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    });

    state.socket.on('guest:kicked', (data) => {
      if (!data || data.guestId !== state.guest?.id) return;
      // Clear identity
      state.guest = null;
      clearStored();
      // Disconnect to stop reconnect attempts
      state.socket.disconnect();
      state.socket = null;
      // Show kicked screen
      $('error-msg').textContent = 'Du wurdest vom DJ aus der Party entfernt.';
      showView('error');
    });

    state.socket.on('livestream:status', (data) => {
      updateLivestreamStatus(data?.online === true);
    });

    // Refresh when tab becomes visible again (e.g. user switched away and back)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.sessionId) refreshQueue();
    });
  }

  // --- UI binding ---
  function bindUI() {
    // Tabs
    document.querySelectorAll('.g-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Search
    $('g-search-input').addEventListener('input', onSearchInput);

    // Name modal
    $('name-submit').addEventListener('click', submitName);
    $('name-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') submitName(); });

    // Profile button
    $('g-profile-btn').addEventListener('click', onProfileClick);
  }

  function switchTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll('.g-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.g-tab-content').forEach(c => c.classList.remove('active'));
    $(`tab-${tab}`).classList.add('active');

    if (tab === 'mine') renderMine();
    if (tab === 'search') $('g-search-input').focus();
  }

  function updateProfileBadge() {
    const pill = $('g-profile-btn');
    const emojiEl = $('g-profile-emoji');
    const nameEl = $('g-profile-name');

    if (state.guest) {
      pill.classList.remove('is-anon');
      pill.classList.add('is-guest');
      emojiEl.textContent = state.guest.emoji || initials(state.guest.name);
      nameEl.textContent = state.guest.name;
    } else {
      pill.classList.remove('is-guest');
      pill.classList.add('is-anon');
      emojiEl.textContent = '?';
      nameEl.textContent = 'Tap to join';
    }
  }

  function onProfileClick() {
    if (state.guest) {
      if (confirm(`Eingeloggt als ${state.guest.name}. Identität zurücksetzen?`)) {
        state.guest = null;
        clearStored();
        updateProfileBadge();
        toast('Identität zurückgesetzt');
        refreshQueue();
      }
    } else {
      openNameModal(null);
    }
  }

  // --- Name modal ---
  function openNameModal(pendingAction) {
    state.pendingAction = pendingAction;
    $('name-modal').style.display = 'flex';
    $('name-error').style.display = 'none';
    $('name-input').value = '';
    setTimeout(() => $('name-input').focus(), 100);
  }

  function closeNameModal() {
    $('name-modal').style.display = 'none';
    state.pendingAction = null;
  }

  let _submittingName = false;
  async function submitName() {
    if (_submittingName) {
      return;
    }
    _submittingName = true;

    const name = $('name-input').value.trim();
    if (!name) {
      $('name-error').textContent = 'Bitte einen Namen eingeben.';
      $('name-error').style.display = 'block';
      _submittingName = false;
      return;
    }

    // Capture pending BEFORE any async work
    const pending = state.pendingAction;
    state.pendingAction = null;

    try {
      const deviceId = getDeviceId();
      const { guest } = await api(`/api/sessions/${state.sessionCode}/join`, {
        method: 'POST',
        body: JSON.stringify({ name, deviceId })
      });
      state.guest = { id: guest.id, name: guest.name, emoji: guest.emoji };
      saveStored({ sessionCode: state.sessionCode, guest: state.guest });
      updateProfileBadge();
      closeNameModal();

      if (pending && pending.type === 'add') {
        try {
          await addTrack(pending.track);
          toast(`"${pending.track.title.slice(0, 40)}…" hinzugefügt 🎉`, 'success');
          switchTab('queue');
        } catch (err) {
          toast(`Fehler: ${err.message}`, 'error');
        }
      } else if (pending && pending.type === 'vote') {
        try {
          await voteTrack(pending.trackId, pending.value);
          toast(`Willkommen, ${guest.name}! Vote gezählt 🎉`, 'success');
        } catch (err) {
          toast(`Fehler: ${err.message}`, 'error');
        }
      } else {
        toast(`Willkommen, ${guest.name}! 🎉`, 'success');
      }

      refreshQueue();
    } catch (err) {
      $('name-error').textContent = err.message;
      $('name-error').style.display = 'block';
      // Restore pending so user can retry
      state.pendingAction = pending;
    } finally {
      _submittingName = false;
    }
  }

  // Ensures guest exists; if not, opens modal with pendingAction. Returns true if guest is present.
  function requireGuest(pendingAction) {
    if (state.guest) return true;
    openNameModal(pendingAction);
    return false;
  }

  // --- Search ---
  function onSearchInput(e) {
    const q = e.target.value.trim();
    clearTimeout(state.searchTimer);
    if (!q) {
      $('g-search-results').innerHTML = '';
      $('g-search-hint').style.display = 'block';
      return;
    }
    state.searchTimer = setTimeout(() => runSearch(q), 400);
  }

  async function runSearch(q) {
    $('g-search-hint').style.display = 'none';
    $('g-search-results').innerHTML = '<p class="empty-state">Suche…</p>';
    try {
      const { results } = await api(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      renderSearchResults(results);
    } catch (err) {
      $('g-search-results').innerHTML = `<p class="empty-state" style="color:var(--color-danger);">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderSearchResults(results) {
    const list = $('g-search-results');
    if (!results || results.length === 0) {
      list.innerHTML = '<p class="empty-state">Keine Treffer</p>';
      return;
    }
    list.innerHTML = '';
    results.forEach(r => {
      const el = document.createElement('div');
      el.className = 'g-result';
      el.innerHTML = `
        <img class="g-result-thumb" src="${r.thumbnail}" alt="" loading="lazy">
        <div class="g-result-body">
          <div class="g-result-title">${escapeHtml(r.title)}</div>
          <div class="g-result-sub">${escapeHtml(r.artist)} · ${formatDuration(r.duration)}</div>
        </div>
        ${r.existing_track_id ? (
          r.existing_status === 'played'
            ? `<span class="search-already-played">✓ Bereits gespielt</span>`
            : `<button class="search-vote-btn" data-vote-id="${escapeHtml(r.existing_track_id)}">👍 Voten (${r.existing_score >= 0 ? '+' : ''}${r.existing_score || 0})</button>`
        ) : `<button class="g-result-add" data-add="${escapeHtml(r.youtube_id)}" aria-label="Hinzufügen">+</button>`}
      `;
      if (r.existing_track_id && r.existing_status !== 'played') {
        el.querySelector('.search-vote-btn').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const id = btn.getAttribute('data-vote-id');
          if (!requireGuest({ type: 'vote', trackId: id, value: 1 })) return;
          try {
            await api(`/api/tracks/${id}/vote`, {
              method: 'POST',
              body: JSON.stringify({ guestId: state.guest.id, value: 1 })
            });
            btn.disabled = true;
            btn.textContent = '✓ Gevotet';
          } catch (err) { alert(err.message); }
        });
      } else if (!r.existing_track_id) {
        el.querySelector('.g-result-add').addEventListener('click', () => onAddClick(r, el));
      }
      list.appendChild(el);
    });
  }

  function formatDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function onAddClick(track, resultEl) {
    if (!requireGuest({ type: 'add', track })) return;

    askForGuestMessage(async () => {
      const btn = resultEl.querySelector('.g-result-add');
      btn.disabled = true;
      btn.textContent = '…';

      try {
        await addTrack(track);
        btn.textContent = '✓';
        toast(`"${track.title.slice(0, 40)}…" hinzugefügt`, 'success');
        refreshQueue();
        setTimeout(() => { btn.disabled = false; btn.textContent = '+'; }, 1500);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '+';
        toast(err.message, 'error');
      }
    });
  }

  async function addTrack(track) {
    return api('/api/tracks', {
      method: 'POST',
      body: JSON.stringify({
        guestId: state.guest.id,
        youtube_id: track.youtube_id,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail,
        duration: track.duration,
        guest_message: state.sessionMode === 'live-dj' ? (window._pendingGuestMessage || '').trim() : undefined
      })
    });
  }

  // --- Queue / Voting ---
  async function refreshQueue() {
    if (!state.sessionId) return;
    try {
      const guestId = state.guest ? state.guest.id : '';
      const { queue } = await api(`/api/tracks/queue${guestId ? `?guestId=${guestId}` : ''}`);
      state.queue = queue;
      renderQueue();
      if (state.activeTab === 'mine') renderMine();
    } catch (err) {
      console.error('Queue fetch:', err);
    }
  }

  function renderQueue() {
    const list = $('g-queue-list');
    const queued = state.queue.filter(t => t.status === 'queued');
    const playing = state.queue.find(t => t.status === 'playing');

    // Now playing card
    const np = $('now-playing-card');
    if (playing) {
      np.style.display = 'block';
      $('np-thumb').src = playing.thumbnail || '';
      $('np-title').textContent = playing.title;
      const npEmoji = playing.added_by_emoji ? `${playing.added_by_emoji} ` : '';
      $('np-sub').innerHTML = `${escapeHtml(playing.artist || '')} · von ${npEmoji}<strong>${escapeHtml(playing.added_by_name)}</strong>`;
    } else {
      np.style.display = 'none';
    }

    if (queued.length === 0) {
      list.innerHTML = '';
      $('g-queue-empty').style.display = 'block';
      return;
    }
    $('g-queue-empty').style.display = 'none';

    list.innerHTML = '';
    queued.forEach((t, idx) => {
      list.appendChild(buildTrackCard(t, idx + 1));
    });
    maybeConfetti(state.queue);
  }

  function buildTrackCard(t, rank) {
    const isMine = state.guest && t.added_by_guest_id === state.guest.id;
    const isTop = rank === 1;
    const card = document.createElement('div');
    card.className = 'g-track' + (isMine ? ' is-mine' : '') + (isTop ? ' is-top' : '');
    card.dataset.id = t.id;

    const scoreClass = t.score > 0 ? '' : (t.score < 0 ? 'negative' : 'zero');
    const scoreDisplay = t.score > 0 ? `+${t.score}` : t.score;

    const voteSection = isMine
      ? `<div class="g-track-vote"><span class="mine-tag">Du</span><div class="vote-score ${scoreClass}">${scoreDisplay}</div></div>`
      : `<div class="g-track-vote">
          <button class="vote-btn up ${t.myVote === 1 ? 'active' : ''}" data-vote="1" data-id="${t.id}" aria-label="Up">▲</button>
          <div class="vote-score ${scoreClass}">${scoreDisplay}</div>
          <button class="vote-btn down ${t.myVote === -1 ? 'active' : ''}" data-vote="-1" data-id="${t.id}" aria-label="Down">▼</button>
        </div>`;

    card.innerHTML = `
      <div class="g-track-rank">${rank}</div>
      <div class="g-track-body">
        <div class="g-track-title">${escapeHtml(t.title)}</div>
        <div class="g-track-meta">
          <span class="by-pill">
            ${avatarHtml(t.added_by_name, 'sm', t.added_by_emoji)}
            <span class="by-name">${escapeHtml(t.added_by_name)}</span>
          </span>
        </div>
      </div>
      ${voteSection}
    `;

    card.querySelectorAll('.vote-btn').forEach(btn => {
      btn.addEventListener('click', onVoteClick);
    });

    return card;
  }

  async function onVoteClick(e) {
    const btn = e.currentTarget;
    const trackId = btn.dataset.id;
    let value = parseInt(btn.dataset.vote, 10);

    // Toggle: clicking active vote button clears vote
    const isActive = btn.classList.contains('active');
    if (isActive) value = 0;

    if (!requireGuest({ type: 'vote', trackId, value })) return;

    btn.classList.add('popped');
    setTimeout(() => btn.classList.remove('popped'), 300);

    try {
      await voteTrack(trackId, value);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function voteTrack(trackId, value) {
    return api(`/api/tracks/${trackId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ guestId: state.guest.id, value })
    });
  }

  // --- Mine tab ---
  function renderMine() {
    const list = $('g-mine-list');
    if (!state.guest) {
      list.innerHTML = '';
      $('g-mine-empty').textContent = 'Tritt der Party bei, um deine Songs zu sehen.';
      $('g-mine-empty').style.display = 'block';
      return;
    }
    const mine = state.queue.filter(t => t.added_by_guest_id === state.guest.id);
    if (mine.length === 0) {
      list.innerHTML = '';
      $('g-mine-empty').innerHTML = 'Du hast noch keine Songs hinzugefügt.<br>Wechsel zu „Suchen" und leg los.';
      $('g-mine-empty').style.display = 'block';
      return;
    }
    $('g-mine-empty').style.display = 'none';
    list.innerHTML = '';
    mine.forEach((t, idx) => {
      const card = buildTrackCard(t, idx + 1);
      // Add status tag (playing/queued)
      const titleEl = card.querySelector('.g-track-title');
      if (t.status === 'playing') {
        titleEl.innerHTML += ' <span class="status-tag playing">Jetzt</span>';
      }
      list.appendChild(card);
    });
  }

  function askForGuestMessage(callback) {
    if (state.sessionMode !== 'live-dj') {
      window._pendingGuestMessage = '';
      callback();
      return;
    }

    const modal = $('guest-message-modal');
    const input = $('guest-message-input');
    const submitBtn = $('guest-message-submit');
    const skipBtn = $('guest-message-skip');
    const counter = $('guest-message-counter');

    if (!modal || !input) {
      window._pendingGuestMessage = '';
      callback();
      return;
    }

    input.value = '';
    counter.textContent = '0 / 200';
    modal.classList.add('is-visible');
    setTimeout(() => input.focus(), 100);

    const updateCounter = () => {
      counter.textContent = `${input.value.length} / 200`;
    };
    input.addEventListener('input', updateCounter);

    const cleanup = () => {
      modal.classList.remove('is-visible');
      input.removeEventListener('input', updateCounter);
      submitBtn.onclick = null;
      skipBtn.onclick = null;
    };

    submitBtn.onclick = () => {
      window._pendingGuestMessage = input.value.trim().slice(0, 200);
      cleanup();
      callback();
    };
    skipBtn.onclick = () => {
      window._pendingGuestMessage = '';
      cleanup();
      callback();
    };
  }

  // --- Guest History ---
  async function loadGuestHistory() {
    try {
      const r = await api('/api/tracks/history-public');
      renderGuestHistory(r.history || []);
    } catch (e) {
      console.error('History:', e);
    }
  }

  function renderGuestHistory(items) {
    const c = document.getElementById('guest-history-list');
    const badge = document.getElementById('guest-history-count');
    if (badge) badge.textContent = items.length;
    if (!c) return;

    if (!items.length) {
      c.innerHTML = '<p class="guest-history-empty">Noch nichts gespielt.</p>';
      return;
    }

    c.innerHTML = items.map(t => {
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const time = t.played_at ? new Date(t.played_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
      return `
        <div class="guest-history-row">
          <img src="${escapeHtml(t.thumbnail || '')}" alt="" class="guest-history-thumb">
          <div class="guest-history-info">
            <div class="guest-history-title">${escapeHtml(t.title || '')}</div>
            <div class="guest-history-sub">${escapeHtml(t.artist || '')} · ${emoji}${escapeHtml(t.added_by_name || '?')} · ${time}</div>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Approval Celebration ---
  function celebrateApproval() {
    // Vibration
    if (navigator.vibrate) navigator.vibrate([80, 40, 80, 40, 200]);

    // Confetti burst
    spawnConfetti();
  }

  function spawnConfetti() {
    const container = document.createElement('div');
    container.className = 'rigo-confetti-container';
    document.body.appendChild(container);

    const colors = ['#FF6B1A', '#FBB040', '#4ADE80', '#60A5FA', '#F472B6', '#fff'];
    const count = 60;

    for (let i = 0; i < count; i++) {
      const piece = document.createElement('div');
      piece.className = 'rigo-confetti-piece';
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = (Math.random() * 0.3) + 's';
      piece.style.animationDuration = (1.8 + Math.random() * 1.2) + 's';
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      container.appendChild(piece);
    }

    setTimeout(() => container.remove(), 3500);
  }

  // === Livestream ===
  let _hls = null;
  let _streamUrl = '';

  async function loadLivestreamConfig() {
    try {
      const r = await api('/api/livestream/config');
      _streamUrl = r.streamUrl || '';
      updateLivestreamStatus(r.online === true);
    } catch (e) {
      console.error('Livestream config:', e);
    }
  }

  function updateLivestreamStatus(online) {
    const card = document.getElementById('livestream-card');
    if (!card) return;
    if (online && _streamUrl) {
      card.style.display = 'block';
    } else {
      card.style.display = 'none';
      closeLivestreamPlayer();
    }
  }

  function openLivestreamPlayer() {
    if (!_streamUrl) return;
    const modal = document.getElementById('livestream-player-modal');
    const video = document.getElementById('livestream-video');
    if (!modal || !video) return;

    modal.style.display = 'flex';

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = _streamUrl;
    } else if (window.Hls && window.Hls.isSupported()) {
      if (_hls) { try { _hls.destroy(); } catch {} _hls = null; }
      _hls = new window.Hls({ lowLatencyMode: true });
      _hls.loadSource(_streamUrl);
      _hls.attachMedia(video);
    } else {
      video.src = _streamUrl;
    }

    video.muted = true;
    video.play().catch(() => {});

    updateLivestreamMiniOverlay();
  }

  function closeLivestreamPlayer() {
    const modal = document.getElementById('livestream-player-modal');
    const video = document.getElementById('livestream-video');
    if (modal) modal.style.display = 'none';
    if (video) {
      try { video.pause(); } catch {}
      video.src = '';
      video.removeAttribute('src');
    }
    if (_hls) {
      try { _hls.destroy(); } catch {}
      _hls = null;
    }
  }

  function toggleLivestreamFullscreen() {
    const modal = document.getElementById('livestream-player-modal');
    if (!modal) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      if (modal.requestFullscreen) modal.requestFullscreen();
      else if (modal.webkitRequestFullscreen) modal.webkitRequestFullscreen();
    }
  }

  function updateLivestreamMiniOverlay() {
    const overlay = document.getElementById('livestream-mini-overlay');
    if (!overlay) return;
    const playing = (state.queue || []).find(t => t.status === 'playing');
    if (!playing) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = 'block';
    const thumb = document.getElementById('livestream-mini-thumb');
    const title = document.getElementById('livestream-mini-title');
    const artist = document.getElementById('livestream-mini-artist');
    const voteBtn = document.getElementById('livestream-mini-vote');
    if (thumb) thumb.src = playing.thumbnail || '';
    if (title) title.textContent = playing.title || '';
    if (artist) artist.textContent = playing.artist || '';
    if (voteBtn) voteBtn.setAttribute('data-livestream-vote', playing.id);
  }

  function bindLivestreamUI() {
    const card = document.getElementById('livestream-card');
    const closeBtn = document.getElementById('livestream-close-btn');
    const fsBtn = document.getElementById('livestream-fullscreen-btn');

    if (card) card.addEventListener('click', openLivestreamPlayer);
    if (closeBtn) closeBtn.addEventListener('click', closeLivestreamPlayer);
    if (fsBtn) fsBtn.addEventListener('click', toggleLivestreamFullscreen);

    // Vote from mini overlay
    document.body.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('[data-livestream-vote]');
      if (!btn) return;
      const trackId = btn.getAttribute('data-livestream-vote');
      if (!trackId || !state.guest?.id) return;
      try {
        await api(`/api/tracks/${trackId}/vote`, {
          method: 'POST',
          body: JSON.stringify({ guestId: state.guest.id, value: 1 })
        });
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '👍'; }, 1500);
      } catch (e) { /* ignore */ }
    });
  }

  // --- Start ---
  document.addEventListener('DOMContentLoaded', boot);
})();
