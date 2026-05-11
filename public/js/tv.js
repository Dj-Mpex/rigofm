(() => {
  // ============================================
  // RIGO FM — TV Display
  // ============================================

  let state = {
    session: null,
    queue: [],
    currentTrack: null,   // The track currently playing (from queue)
    isFillerMode: false,
    fillerPlaylistId: null,
    player: null,
    playerReady: false,
    socket: null,
    pendingPlayAfterReady: null,
    lastUserVolume: 100,
    isFading: false
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
      state.fillerPlaylistId = playlistId;

      renderSession();
      initSocket();

      // Wait for user tap before doing anything that needs audio
      $('tv-start-btn').addEventListener('click', onStartTap, { once: true });
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
  }

  function renderSession() {
    if (!state.session) return;
    const joinUrl = `${window.location.origin}/join/${state.session.code}`;

    // Idle view fields
    $('tv-session-name').textContent = state.session.name;
    $('tv-session-code').textContent = state.session.code;
    $('tv-join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
    $('tv-qr').src = `/api/qr?text=${encodeURIComponent(joinUrl)}`;

    // Playing view fields
    $('tv-side-name').textContent = state.session.name;
    $('tv-join-mini-qr').src = `/api/qr?text=${encodeURIComponent(joinUrl)}`;
    $('tv-join-mini-url').textContent = joinUrl.replace(/^https?:\/\//, '');
    $('tv-join-mini-code').textContent = state.session.code;
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
      const { playlistId } = await api('/api/settings/filler');
      state.fillerPlaylistId = playlistId;
      // If we're currently in filler mode, restart filler with new playlist
      if (state.isFillerMode) {
        startFiller();
      }
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
    const playing = state.queue.find(t => t.status === 'playing');
    const nextQueued = state.queue.find(t => t.status === 'queued');

    if (playing) {
      // Backend already has something marked as playing -> ensure we are playing it
      if (!state.currentTrack || state.currentTrack.id !== playing.id || state.isFillerMode) {
        playTrack(playing);
      }
      return;
    }

    // No one is currently playing
    if (state.currentTrack && !state.isFillerMode) {
      state.currentTrack = null;
    }

    // Queued track exists -> mark as playing and play it immediately
    // (even if filler is currently running)
    if (nextQueued) {
      markAndPlay(nextQueued);
      return;
    }

    // Nothing queued and nothing playing -> start filler (if not already)
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
      playerVars: {
        autoplay: 1,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        showinfo: 0,
        disablekb: 1
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
  }

  function onPlayerStateChange(e) {
    // YT.PlayerState.ENDED = 0
    if (e.data === 0) {
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
    if (!state.fillerPlaylistId) {
      // No filler configured -> go idle screen
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
    $('tv-filler-badge').style.display = 'flex';
    ensurePlayingViewActive();
    state.player.loadPlaylist({
      list: state.fillerPlaylistId,
      listType: 'playlist',
      index: Math.floor(Math.random() * 50)
    });
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
    const playing = state.queue.find(t => t.status === 'playing');
    const queued = state.queue.filter(t => t.status === 'queued');

    // Now playing card
    if (playing) {
      $('tv-now').style.display = 'block';
      $('tv-now-name').textContent = playing.added_by_name;
      $('tv-now-title').textContent = `${playing.title}`;
      const av = $('tv-now-avatar');
      if (playing.added_by_emoji) {
        av.textContent = playing.added_by_emoji;
        av.style.background = 'transparent';
        av.style.fontSize = '1.6rem';
      } else {
        av.textContent = initials(playing.added_by_name);
        av.style.background = avatarBg(playing.added_by_name);
        av.style.color = '#0A0A0A';
        av.style.fontSize = '';
      }
    } else {
      $('tv-now').style.display = 'none';
    }

    // Queue
    $('tv-queue-count').textContent = queued.length;
    const list = $('tv-queue');
    if (queued.length === 0) {
      list.innerHTML = '';
      $('tv-queue-empty').style.display = 'block';
    } else {
      $('tv-queue-empty').style.display = 'none';
      list.innerHTML = '';
      queued.forEach((t, idx) => {
        const scoreClass = t.score > 0 ? '' : (t.score < 0 ? 'negative' : 'zero');
        const scoreDisplay = t.score > 0 ? `+${t.score}` : t.score;
        const el = document.createElement('div');
        el.className = 'tv-track';
        el.innerHTML = `
          <div class="tv-track-rank">${idx + 1}</div>
          <div class="tv-track-body">
            <div class="tv-track-title">${escapeHtml(t.title)}</div>
            <div class="tv-track-meta">
              ${t.added_by_emoji
                ? `<span class="avatar" style="background:transparent;font-size:0.85rem;">${t.added_by_emoji}</span>`
                : `<span class="avatar" style="background:${avatarBg(t.added_by_name)};color:#0A0A0A;">${escapeHtml(initials(t.added_by_name))}</span>`}
              <span>${escapeHtml(t.added_by_name)}</span>
            </div>
          </div>
          <div class="tv-track-score ${scoreClass}">${scoreDisplay}</div>
        `;
        list.appendChild(el);
      });
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

  // --- Init ---
  document.addEventListener('DOMContentLoaded', boot);
})();
