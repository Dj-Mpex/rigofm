(() => {
  // ============================================
  // RIGO FM — TV Display
  // ============================================

  let state = {
    session: null,
    sessionId: null,
    sessionMode: 'auto',
    activeDjProfile: null,
    queue: [],
    currentTrack: null,   // The track currently playing (from queue)
    isFillerMode: false,
    fillerPlaylistId: null,
    player: null,
    playerReady: false,
    socket: null,
    pendingPlayAfterReady: null,
    lastUserVolume: 100,
    isFading: false,
    tvSource: 'tracks',
    tvMuted: false,
    activeVisualsPreset: null,
    _activeFillerPlaylistId: null,
    chartsOverlayEnabled: true,
    _chartsTimer: null
  };

  const $ = (id) => document.getElementById(id);

  // --- Utilities ---
  function showState(name) {
    document.querySelectorAll('.tv-state').forEach(s => s.classList.remove('active'));
    $(`tv-${name}`).classList.add('active');
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

  function avatarBg(name) {
    if (!name) return '#444';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360}, 70%, 60%)`;
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

  // --- Boot ---
  async function boot() {
    try {
      const [{ session }, { playlistId }] = await Promise.all([
        api('/api/sessions/active'),
        api('/api/settings/filler')
      ]);
      state.session = session;
      state.sessionId = session.id;
      state.fillerPlaylistId = playlistId;
      try {
        const [modeRes, profileRes] = await Promise.all([
          api('/api/sessions/mode'),
          api('/api/dj-profiles/active')
        ]);
        state.sessionMode = modeRes.mode || 'auto';
        state.activeDjProfile = profileRes.profile || null;
      } catch (e) { /* non-fatal */ }
      try {
        const vRes = await api('/api/visuals/active');
        state.activeVisualsPreset = vRes.preset || null;
        state.tvSource = vRes.tv_source || 'tracks';
        state.tvMuted = vRes.tv_muted === true;
        state.chartsOverlayEnabled = vRes.charts_overlay !== false;
      } catch {}
      renderDjProfileCard();
      initChartsOverlay();

      renderSession();
      initSocket();

      // Wait for user tap before doing anything that needs audio
      $('tv-start-btn').addEventListener('click', onStartTap, { once: true });
      bindKioskUI();
    } catch (err) {
      console.error('Boot:', err);
      if (err.message === 'No active session') {
        showState('no-session');
      } else {
        showState('no-session');
        $('tv-no-session').querySelector('p').textContent = 'Server-Verbindung fehlgeschlagen.';
      }
    }
  }

  async function onStartTap() {
    // User interaction grants permission for audio autoplay
    showState('playing');
    await refreshQueue();
    initChartsOverlay();
  }

  function renderSession() {
    if (!state.session) return;
    const joinUrl = `${window.location.origin}/join/${state.session.code}`;
    const urlDisplay = joinUrl.replace(/^https?:\/\//, '');
    const qrSrc = `/api/qr?text=${encodeURIComponent(joinUrl)}`;

    // Set session name in ALL places it might appear
    document.querySelectorAll('#tv-session-name').forEach(el => el.textContent = state.session.name);

    // Set code in ALL places it might appear (idle screen + join-card)
    document.querySelectorAll('#tv-session-code, #tv-join-code').forEach(el => el.textContent = state.session.code);

    // Set join URL in ALL places
    document.querySelectorAll('#tv-join-url').forEach(el => el.textContent = urlDisplay);

    // Set QR src in ALL <img> tags with id tv-qr
    document.querySelectorAll('#tv-qr').forEach(img => img.src = qrSrc);
  }

  // --- Socket ---
  function initSocket() {
    state.socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });
    state.socket.on('connect', () => {
      state.socket.emit('session:join', { sessionCode: state.session.code, role: 'tv' });
      refreshQueue();
    });
    state.socket.on('queue:updated', refreshQueue);
    state.socket.on('config:changed', onConfigChanged);
    state.socket.on('player:command', handlePlayerCommand);
  }

  async function onConfigChanged() {
    try {
      const [{ playlistId }, modeRes, profileRes, vRes] = await Promise.all([
        api('/api/settings/filler'),
        api('/api/sessions/mode'),
        api('/api/dj-profiles/active'),
        api('/api/visuals/active')
      ]);

      const oldFiller = state.fillerPlaylistId;
      const oldMode = state.sessionMode;
      const oldSource = state.tvSource;
      const oldVisualsId = state.activeVisualsPreset ? state.activeVisualsPreset.id : null;
      const oldMuted = state.tvMuted;

      state.fillerPlaylistId = playlistId;
      state.sessionMode = modeRes.mode || 'auto';
      state.activeDjProfile = profileRes.profile || null;
      state.activeVisualsPreset = vRes.preset || null;
      state.tvSource = vRes.tv_source || 'tracks';
      state.tvMuted = vRes.tv_muted === true;
      const newVisualsId = state.activeVisualsPreset ? state.activeVisualsPreset.id : null;
      const oldCharts = state.chartsOverlayEnabled;
      state.chartsOverlayEnabled = vRes.charts_overlay !== false;

      console.log('[tv] onConfigChanged:', { oldSource, newSource: state.tvSource, oldMode, newMode: state.sessionMode, tvMuted: state.tvMuted });

      renderDjProfileCard();

      // Apply charts toggle immediately
      if (oldCharts !== state.chartsOverlayEnabled) {
        if (state.chartsOverlayEnabled) {
          initChartsOverlay();
        } else {
          stopChartsOverlay();
        }
      }

      // Apply mute change immediately (no playback restart needed)
      if (oldMuted !== state.tvMuted && state.player && state.playerReady) {
        if (state.tvMuted) state.player.mute();
        else state.player.unMute();
      }

      // Source change (tracks / visuals / dj-visuals) — handle in ALL modes
      if (oldSource !== state.tvSource) {
        document.body.classList.toggle('tv-source-djvisuals', state.tvSource === 'dj-visuals');
        state._activeFillerPlaylistId = null;
        state.isFillerMode = false;
        decideWhatToPlay();
        return;
      }

      // Mode switch → re-decide
      if (oldMode !== state.sessionMode) {
        state._activeFillerPlaylistId = null;
        decideWhatToPlay();
        return;
      }

      // Visuals preset changed while in live-dj + visuals mode → restart filler
      if (state.sessionMode === 'live-dj' && state.tvSource === 'visuals' && oldVisualsId !== newVisualsId) {
        state._activeFillerPlaylistId = null;
        startFiller();
        return;
      }

      // Filler playlist itself changed
      if (oldFiller !== playlistId && state.isFillerMode && state.tvSource !== 'visuals') {
        state._activeFillerPlaylistId = null;
        startFiller();
        return;
      }

      // Otherwise: nothing changed that affects current playback
    } catch (err) {
      console.error('config:changed fetch:', err);
    }
  }

  function handlePlayerCommand(cmd) {
    if (!state.player || !state.playerReady) return;
    switch (cmd.action) {
      case 'pause':
        state.player.pauseVideo();
        break;
      case 'play':
        state.player.playVideo();
        break;
      case 'toggle': {
        const s = state.player.getPlayerState();
        if (s === YT.PlayerState.PLAYING) state.player.pauseVideo();
        else state.player.playVideo();
        break;
      }
      case 'skip':
        onTrackEnded();
        break;
      case 'volume':
        if (typeof cmd.value === 'number') {
          state.player.setVolume(Math.max(0, Math.min(100, cmd.value)));
          state.lastUserVolume = Math.max(0, Math.min(100, cmd.value));
        }
        break;
      case 'mute':
        state.player.mute();
        break;
      case 'unmute':
        state.player.unMute();
        break;
      case 'force-filler':
        if (state.currentTrack && !state.isFillerMode) {
          api(`/api/tracks/${state.currentTrack.id}/mark-played`, { method: 'POST', body: '{}' })
            .catch(() => {});
        }
        startFiller();
        break;
    }
  }

  // --- Queue refresh ---
  async function refreshQueue() {
    try {
      const { queue } = await api('/api/tracks/queue');
      state.queue = queue;
      decideWhatToPlay();
      renderSidePanel();
    } catch (err) {
      console.error('Queue:', err);
    }
  }

  function decideWhatToPlay() {
    // DJ-Visuals mode: player stays off, external NDI/stream passes through
    if (state.tvSource === 'dj-visuals') {
      if (state.player && state.playerReady) try { state.player.stopVideo(); } catch {}
      return;
    }

    // Live-DJ mode: TV never plays guest tracks, only filler/visuals
    if (state.sessionMode === 'live-dj') {
      if (!state.isFillerMode) startFiller();
      return;
    }

    const playing = state.queue.find(t => t.status === 'playing');
    const nextQueued = state.queue.find(t => t.status === 'queued');

    if (playing) {
      if (!state.currentTrack || state.currentTrack.id !== playing.id || state.isFillerMode) {
        playTrack(playing);
      }
      return;
    }

    if (state.currentTrack && !state.isFillerMode) {
      state.currentTrack = null;
    }

    if (nextQueued) {
      markAndPlay(nextQueued);
      return;
    }

    // Nothing to play AND we are not currently in filler → start filler
    // BUT do NOT restart if filler is already running
    if (!state.isFillerMode) {
      startFiller();
    }
  }

  async function markAndPlay(track) {
    try {
      await api(`/api/tracks/${track.id}/mark-playing`, { method: 'POST', body: '{}' });
      // Socket will trigger refresh; we'll start the actual playback in decideWhatToPlay
    } catch (err) {
      console.error('mark-playing:', err);
    }
  }

  // --- YouTube Player ---
  window.onYouTubeIframeAPIReady = () => {
    state.player = new YT.Player('player', {
      height: '100%',
      width: '100%',
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        autoplay: 1,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        showinfo: 0,
        disablekb: 1,
        origin: window.location.origin,
        enablejsapi: 1
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError
      }
    });
  };

  function onPlayerReady() {
    state.playerReady = true;
    if (state.pendingPlayAfterReady) {
      const p = state.pendingPlayAfterReady;
      state.pendingPlayAfterReady = null;
      p();
    } else {
      // Initial: no queue yet, but everything booted -> start filler
      if (!state.currentTrack && state.queue.length === 0) {
        startFiller();
      }
    }
    // Apply initial mute state once player is ready
    if (state.tvMuted) state.player.mute();
  }

  function onPlayerStateChange(e) {
    // YT.PlayerState.ENDED = 0
    if (e.data === 0) {
      // If in filler mode with a single video (visuals), loop it
      if (state.isFillerMode && state.activeVisualsPreset && state.activeVisualsPreset.source_type === 'video' && state.tvSource === 'visuals') {
        state.player.seekTo(0);
        state.player.playVideo();
        return;
      }
      onTrackEnded();
    }
  }

  function onPlayerError(e) {
    console.error('YT player error:', e.data);
    // If a real track failed, skip it (mark played, move on)
    if (state.currentTrack && !state.isFillerMode) {
      api(`/api/tracks/${state.currentTrack.id}/mark-played`, { method: 'POST', body: '{}' })
        .catch(() => {});
    } else {
      // Filler failed -> just retry filler after delay
      setTimeout(startFiller, 2000);
    }
  }

  function ensurePlayingViewActive() {
    showState('playing');
  }

  function playTrack(track) {
    if (!state.playerReady) {
      ensurePlayingViewActive();
      state.pendingPlayAfterReady = () => playTrack(track);
      return;
    }

    // Special case: filler -> real track gets a smooth crossfade
    if (state.isFillerMode) {
      ensurePlayingViewActive();
      fadeFillerToTrack(track);
      return;
    }

    // Normal hard switch (track -> track, or initial)
    state.isFillerMode = false;
    state.currentTrack = track;
    $('tv-filler-badge').style.display = 'none';
    ensurePlayingViewActive();
    state.player.loadVideoById({ videoId: track.youtube_id });
  }

  function startFiller() {
    // Pick source: visuals preset (when visuals mode active) OR normal filler playlist
    const useVisuals = (state.tvSource === 'visuals' && state.activeVisualsPreset);

    let sourceId = null;
    let sourceType = null;
    if (useVisuals) {
      sourceId = state.activeVisualsPreset.source_id;
      sourceType = state.activeVisualsPreset.source_type;
    } else if (state.fillerPlaylistId) {
      sourceId = state.fillerPlaylistId;
      sourceType = 'playlist';
    }

    // Guard: if already playing this exact source, don't restart
    if (state.isFillerMode && state._activeFillerPlaylistId === sourceId) {
      return;
    }

    if (!sourceId) {
      state.isFillerMode = false;
      state.currentTrack = null;
      showState('idle');
      return;
    }

    if (!state.playerReady) {
      ensurePlayingViewActive();
      state.pendingPlayAfterReady = startFiller;
      return;
    }

    state.isFillerMode = true;
    state.currentTrack = null;
    const badge = $('tv-filler-badge');
    if (badge) {
      // In live-dj mode the filler badge should never show
      badge.style.display = (state.sessionMode === 'live-dj') ? 'none' : 'flex';
    }
    ensurePlayingViewActive();

    if (sourceType === 'playlist') {
      state.player.loadPlaylist({
        list: sourceId,
        listType: 'playlist',
        index: 0
      });
      // Activate shuffle mode after playlist is loaded
      try { state.player.setShuffle(true); } catch {}
      // Kick off a random first track
      setTimeout(() => {
        try { state.player.setShuffle(true); state.player.nextVideo(); } catch {}
      }, 800);
    } else {
      // Single video → load and loop on end (handled in onPlayerStateChange)
      state.player.loadVideoById({ videoId: sourceId });
    }

    // Apply mute state on every fresh load
    if (state.tvMuted && state.player) state.player.mute();
    else if (state.player) state.player.unMute();

    state._activeFillerPlaylistId = sourceId;
  }

  async function onTrackEnded() {
    if (state.isFillerMode) {
      // Filler track ended. Check if a real queued track is waiting.
      const queued = state.queue.find(t => t.status === 'queued');
      if (queued) {
        markAndPlay(queued);
      } else {
        // No real track waiting, playlist will continue automatically (loadPlaylist auto-advances)
      }
      return;
    }

    // Real track ended -> mark played
    if (state.currentTrack) {
      try {
        await api(`/api/tracks/${state.currentTrack.id}/mark-played`, { method: 'POST', body: '{}' });
      } catch (err) {
        console.error('mark-played:', err);
      }
    }
    // After mark-played the socket event will trigger refresh & decideWhatToPlay
  }

  // --- Side panel render ---
  function renderSidePanel() {
    if (!state.session) return;

    const nowCard = $('tv-now-card');

    // LIVE-DJ MODE: hide Now-Playing card entirely unless a REAL guest track is playing/queued
    if (state.sessionMode === 'live-dj') {
      const hasRealTrack = state.queue && state.queue.some(t => t.status === 'playing' || t.status === 'queued');

      if (!hasRealTrack) {
        if (nowCard) nowCard.style.display = 'none';
        // Also hide filler badge if present
        const badge = $('tv-filler-badge');
        if (badge) badge.style.display = 'none';
        return;
      } else {
        if (nowCard) nowCard.style.display = '';
        // Continue with normal render below for real track
      }
    } else {
      // Auto mode: ensure now-card is visible (in case it was hidden by live mode earlier)
      if (nowCard) nowCard.style.display = '';
    }

    const playing = state.queue.find(t => t.status === 'playing');
    const upcoming = state.queue.filter(t => t.status === 'queued');

    const sn = $('tv-session-name'); if (sn) sn.textContent = state.session.name || 'Rigo Party';

    const av = $('tv-now-avatar');
    const nm = $('tv-now-name');
    const tk = $('tv-now-track');
    if (playing) {
      if (av) av.textContent = playing.added_by_emoji || '🎵';
      if (nm) nm.textContent = playing.added_by_name || '—';
      if (tk) tk.textContent = playing.title || '';
    } else {
      if (av) av.textContent = '🎶';
      if (nm) nm.textContent = 'Filler';
      if (tk) tk.textContent = state.isFillerMode ? 'Lo-Fi-Playlist läuft' : 'Warte auf die Party…';
    }

    const qc = $('tv-queue-count'); if (qc) qc.textContent = upcoming.length;
    const ql = $('tv-queue-list');
    const qe = $('tv-queue-empty');
    if (!upcoming.length) {
      if (ql) ql.innerHTML = '';
      if (qe) qe.style.display = 'block';
    } else {
      if (qe) qe.style.display = 'none';
      if (ql) {
        ql.innerHTML = upcoming.slice(0, 8).map((t, i) => {
          const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
          const sign = t.score > 0 ? '+' : '';
          return `<div class="tv-queue-classic-item">
            <span class="tv-queue-classic-pos">${i + 1}</span>
            <div class="tv-queue-classic-main">
              <div class="tv-queue-classic-title">${escapeHtml(t.title)}</div>
              <div class="tv-queue-classic-by">${emoji}${escapeHtml(t.added_by_name || '?')}</div>
            </div>
            <span class="tv-queue-classic-score">${sign}${t.score || 0}</span>
          </div>`;
        }).join('');
      }
    }

    if (state.session.code) {
      const joinUrl = `${window.location.origin}/join/${state.session.code}`;
      const urlDisplay = joinUrl.replace(/^https?:\/\//, '');
      const qrSrc = `/api/qr?text=${encodeURIComponent(joinUrl)}`;
      document.querySelectorAll('#tv-qr').forEach(img => img.src = qrSrc);
      document.querySelectorAll('#tv-join-url').forEach(el => el.textContent = urlDisplay);
      document.querySelectorAll('#tv-join-code').forEach(el => el.textContent = state.session.code);
    }
  }

  // --- Player state polling (TV → Admin) ---
  setInterval(() => {
    if (!state.socket || !state.player || !state.playerReady) return;
    let playerState = null;
    try { playerState = state.player.getPlayerState(); } catch (_) { return; }
    let currentTime = 0;
    let duration = 0;
    let volume = 100;
    let isMuted = false;
    try { currentTime = state.player.getCurrentTime(); } catch (_) {}
    try { duration = state.player.getDuration(); } catch (_) {}
    try { volume = state.player.getVolume(); } catch (_) {}
    try { isMuted = state.player.isMuted(); } catch (_) {}
    state.socket.emit('player:state', {
      currentTrack: state.currentTrack,
      isFillerMode: state.isFillerMode,
      currentTime,
      duration,
      volume,
      isMuted,
      playerState
    });
  }, 1000);

  // === Volume fade helpers (only used Filler -> Queue transition) ===
  function fadeVolume(from, to, durationMs) {
    return new Promise(resolve => {
      if (!state.player || !state.playerReady) return resolve();
      const steps = 20;
      const stepMs = durationMs / steps;
      const delta = (to - from) / steps;
      let i = 0;
      state.isFading = true;
      const tick = () => {
        i++;
        const v = Math.round(from + delta * i);
        try { state.player.setVolume(Math.max(0, Math.min(100, v))); } catch {}
        if (i >= steps) {
          state.isFading = false;
          resolve();
        } else {
          setTimeout(tick, stepMs);
        }
      };
      tick();
    });
  }

  async function fadeFillerToTrack(track) {
    // Remember user's current volume before fading
    let startVolume = 100;
    try { startVolume = state.player.getVolume() || 100; } catch {}
    if (!state.player.isMuted()) state.lastUserVolume = startVolume;

    // 1.2s fade out
    await fadeVolume(startVolume, 0, 1200);

    // Switch track (still at vol 0)
    state.isFillerMode = false;
    state.currentTrack = track;
    $('tv-filler-badge').style.display = 'none';
    state.player.loadVideoById({ videoId: track.youtube_id });

    // Wait briefly for video to start, then fade in
    setTimeout(async () => {
      await fadeVolume(0, state.lastUserVolume, 1200);
    }, 600);
  }

  // === Party Charts Overlay ===
  function initChartsOverlay() {
    if (state.chartsOverlayEnabled === false) {
      console.log('[Charts] disabled, skipping init');
      return;
    }
    console.log('[Charts] init called, sessionId:', state.sessionId);
    if (!state.sessionId) {
      console.log('[Charts] no session, retry 1s');
      state._chartsTimer = setTimeout(initChartsOverlay, 1000);
      return;
    }
    console.log('[Charts] scheduled in 30s');
    state._chartsTimer = setTimeout(showChartsOverlay, 30 * 1000);
  }

  async function showChartsOverlay() {
    // Re-check current flag LIVE from API (don't trust cached state)
    try {
      const v = await api('/api/visuals/active');
      state.chartsOverlayEnabled = v.charts_overlay !== false;
    } catch {}

    if (state.chartsOverlayEnabled === false) {
      console.log('[Charts] flag is off, skipping show. Re-scheduling check in 30s.');
      state._chartsTimer = setTimeout(showChartsOverlay, 30 * 1000);
      return;
    }

    console.log('[Charts] showing');
    try {
      const r = await api('/api/sessions/charts');
      console.log('[Charts] data:', r);
      if (r && r.charts) {
        renderChartsOverlay(r.charts);
        const overlay = $('tv-charts-overlay');
        if (overlay) {
          overlay.classList.add('is-visible');
          state._chartsTimer = setTimeout(() => {
            overlay.classList.remove('is-visible');
            state._chartsTimer = setTimeout(showChartsOverlay, 30 * 1000);
          }, 10 * 1000);
          return;
        }
      }
      state._chartsTimer = setTimeout(showChartsOverlay, 30 * 1000);
    } catch (err) {
      console.error('[Charts] error:', err);
      state._chartsTimer = setTimeout(showChartsOverlay, 30 * 1000);
    }
  }

  function stopChartsOverlay() {
    // Clear any pending charts timer
    if (state._chartsTimer) {
      clearTimeout(state._chartsTimer);
      clearInterval(state._chartsTimer);
      state._chartsTimer = null;
    }
    // Hide overlay if visible right now
    const overlay = $('tv-charts-overlay');
    if (overlay) overlay.classList.remove('is-visible');
    console.log('[Charts] stopped');
  }

  function renderChartsOverlay(charts) {
    renderChartTrackList('tv-charts-tracks', (charts.top_tracks || []).slice(0, 5));
    renderChartUserList('tv-charts-wishers', (charts.top_wishers || []).slice(0, 3), 'track_count');
    renderChartUserList('tv-charts-voters', (charts.top_voters || []).slice(0, 3), 'vote_count');
  }

  function renderChartTrackList(elId, tracks) {
    const c = $(elId); if (!c) return;
    if (!tracks.length) { c.innerHTML = '<div style="color:var(--color-text-muted);padding:8px;">Noch keine Tracks</div>'; return; }
    c.innerHTML = tracks.map((t, i) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const cls = i === 0 ? 'tv-chart-item tv-chart-item--first' : 'tv-chart-item';
      const emoji = t.added_by_emoji ? t.added_by_emoji + ' ' : '';
      const sign = t.score > 0 ? '+' : '';
      return `<div class="${cls}">
        <span class="tv-chart-rank">${rank}</span>
        <div class="tv-chart-main">
          <div class="tv-chart-title">${escapeHtml(t.title)}</div>
          <div class="tv-chart-sub">${emoji}${escapeHtml(t.added_by_name || '?')}</div>
        </div>
        <span class="tv-chart-value">${sign}${t.score}</span>
      </div>`;
    }).join('');
  }

  function renderChartUserList(elId, users, valueKey) {
    const c = $(elId); if (!c) return;
    if (!users.length) { c.innerHTML = '<div style="color:var(--color-text-muted);padding:8px;">Noch keine Daten</div>'; return; }
    c.innerHTML = users.map((u, i) => {
      const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      const cls = i === 0 ? 'tv-chart-item tv-chart-item--first' : 'tv-chart-item';
      const emoji = u.emoji ? u.emoji + ' ' : '';
      return `<div class="${cls}">
        <span class="tv-chart-rank">${rank}</span>
        <div class="tv-chart-main">
          <div class="tv-chart-title">${emoji}${escapeHtml(u.name || '?')}</div>
        </div>
        <span class="tv-chart-value">${u[valueKey]}</span>
      </div>`;
    }).join('');
  }

  function renderDjProfileCard() {
    const section = $('tv-dj-profile-section');
    if (!section) return;

    const isLive = state.sessionMode === 'live-dj';

    if (!isLive) {
      section.style.display = 'none';
      return;
    }

    // In live mode: always show the card, even if no profile is selected
    section.style.display = 'block';

    const profile = state.activeDjProfile;
    const nameEl = $('tv-dj-profile-name');
    const logoEl = $('tv-dj-profile-logo');

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

  // === Kiosk Mode ===
  let _cursorIdleTimer = null;

  function enterKiosk() {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (el.msRequestFullscreen) el.msRequestFullscreen();
  }

  function hideCursor() {
    document.body.classList.add('is-cursor-hidden');
  }

  function showCursor() {
    document.body.classList.remove('is-cursor-hidden');
    if (_cursorIdleTimer) clearTimeout(_cursorIdleTimer);
    _cursorIdleTimer = setTimeout(hideCursor, 3000);
  }

  function onFullscreenChange() {
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    document.body.classList.toggle('is-kiosk', isFs);
    if (isFs) {
      showCursor(); // start the idle-timer cycle
    } else {
      document.body.classList.remove('is-cursor-hidden');
      if (_cursorIdleTimer) clearTimeout(_cursorIdleTimer);
    }
  }

  function bindKioskUI() {
    const btn = document.getElementById('tv-kiosk-btn');
    if (btn) btn.addEventListener('click', enterKiosk);

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    // Cursor activity tracking — only active during kiosk mode
    document.addEventListener('mousemove', () => {
      if (document.body.classList.contains('is-kiosk')) {
        showCursor();
      }
    });
  }

  // --- Init ---
  document.addEventListener('DOMContentLoaded', boot);
})();
