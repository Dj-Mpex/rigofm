(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    socket: null,
    sessionCode: null,
    sessionMode: 'auto',
    activeDjProfile: null,
    queue: [],
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Fehler');
    }
    return res.json();
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function boot() {
    try {
      const { session } = await api('/api/sessions/active');
      if (session) {
        state.sessionCode = session.code;
        renderSessionHeader(session);
      }
    } catch {}

    await refresh();
    initSocket();
  }

  function renderSessionHeader(session) {
    if (!session) return;
    const nameEl = $('sp-session-name');
    const codeEl = $('sp-session-code');
    const urlEl = $('sp-join-url');
    const qrEl = $('sp-qr-image');

    if (nameEl) nameEl.textContent = session.name || 'Party';
    if (codeEl) codeEl.textContent = session.code || '—';

    // Build join URL like TV does
    const origin = window.location.origin;
    const joinUrl = `${origin}/join/${session.code}`;
    if (urlEl) urlEl.textContent = joinUrl.replace(/^https?:\/\//, '');

    // QR via /api/qr?text=... like TV
    if (qrEl && session.code) {
      qrEl.src = `/api/qr?text=${encodeURIComponent(joinUrl)}`;
    }
  }

  async function refresh() {
    try {
      const [q, modeRes, profileRes] = await Promise.all([
        api('/api/tracks/queue'),
        api('/api/sessions/mode'),
        api('/api/dj-profiles/active')
      ]);
      state.queue = q.queue || [];
      state.sessionMode = modeRes.mode || 'auto';
      state.activeDjProfile = profileRes.profile || null;
      render();
    } catch (err) {
      console.error('[sidepanel] refresh:', err);
    }
  }

  function render() {
    renderDjProfile();
    renderNow();
    renderUpNext();
  }

  function renderDjProfile() {
    const section = $('sp-dj-profile-section');
    if (!section) return;
    const isLive = state.sessionMode === 'live-dj';
    if (!isLive) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';

    const profile = state.activeDjProfile;
    const nameEl = $('sp-dj-profile-name');
    const logoEl = $('sp-dj-profile-logo');

    if (profile) {
      if (nameEl) nameEl.textContent = profile.name || 'DJ';
      if (logoEl) {
        if (profile.logo_filename) {
          logoEl.onload = () => logoEl.classList.add('is-loaded');
          logoEl.onerror = () => logoEl.classList.remove('is-loaded');
          logoEl.src = `/api/dj-profiles/uploads/${encodeURIComponent(profile.logo_filename)}`;
        } else {
          logoEl.classList.remove('is-loaded');
          logoEl.src = '';
        }
      }
    } else {
      if (nameEl) nameEl.textContent = 'Live-Session';
      if (logoEl) {
        logoEl.classList.remove('is-loaded');
        logoEl.src = '';
      }
    }
  }

  function renderNow() {
    const section = $('sp-now-section');
    const c = $('sp-now-card');
    if (!c || !section) return;

    const playing = state.queue.find(t => t.status === 'playing');

    // In live-dj mode, hide the now-section entirely if no real track is playing
    if (state.sessionMode === 'live-dj' && !playing) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';

    if (!playing) {
      c.innerHTML = '<p class="sp-empty">Kein Track läuft.</p>';
      return;
    }

    const emoji = playing.added_by_emoji ? playing.added_by_emoji + ' ' : '';
    c.innerHTML = `
      <img src="${escapeHtml(playing.thumbnail || '')}" alt="" class="sp-now-thumb">
      <div class="sp-now-info">
        <div class="sp-now-title">${escapeHtml(playing.title || '')}</div>
        <div class="sp-now-sub">${escapeHtml(playing.artist || '')}</div>
        <div class="sp-now-by">${emoji}${escapeHtml(playing.added_by_name || '?')}</div>
      </div>
    `;
  }

  function renderUpNext() {
    const c = $('sp-upnext-list');
    const badge = $('sp-upnext-count');
    if (!c) return;

    const queued = state.queue
      .filter(t => t.status === 'queued')
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 5);

    if (badge) badge.textContent = queued.length;

    if (!queued.length) {
      c.innerHTML = '<p class="sp-empty">Queue ist leer.</p>';
      return;
    }

    c.innerHTML = queued.map((t, i) => {
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const sign = (t.score || 0) > 0 ? '+' : '';
      return `
        <div class="sp-upnext-row">
          <span class="sp-upnext-rank">${i + 1}</span>
          <img src="${escapeHtml(t.thumbnail || '')}" class="sp-upnext-thumb" alt="">
          <div class="sp-upnext-main">
            <div class="sp-upnext-title">${escapeHtml(t.title || '')}</div>
            <div class="sp-upnext-sub">${emoji}${escapeHtml(t.added_by_name || '?')}</div>
          </div>
          <span class="sp-upnext-score">${sign}${t.score || 0}</span>
        </div>
      `;
    }).join('');
  }

  function initSocket() {
    state.socket = io({ transports: ['websocket', 'polling'] });

    state.socket.on('connect', () => {
      console.log('[sidepanel] connected');
      if (state.sessionCode) {
        state.socket.emit('session:join', { sessionCode: state.sessionCode, role: 'tv' });
      }
    });

    state.socket.on('queue:updated', refresh);
    state.socket.on('config:changed', async () => {
      refresh();
      try {
        const { session } = await api('/api/sessions/active');
        if (session) renderSessionHeader(session);
      } catch {}
    });
  }

  // Init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
