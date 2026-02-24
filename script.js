/* ==============================================
   TUNEFLOW — script.js  (v2 — iOS Background Fix)
   ============================================== */

/* ─────────────────────────────────────────────
   1. CONFIGURACIÓN — ¡PEGA TU API KEY AQUÍ!
   Obtén una en: https://console.cloud.google.com
   Activa: "YouTube Data API v3"
   ───────────────────────────────────────────── */
const YT_API_KEY = 'AIzaSyDuqcBihV_xdkHr3F0mCLhaCPz4uibpjj4'; // <-- ⚠️ REEMPLAZA ESTO

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS   = 15;

/* ─────────────────────────────────────────────
   2. ESTADO GLOBAL
   ───────────────────────────────────────────── */
const state = {
  queue:         [],
  currentIndex:  -1,
  isPlaying:     false,
  favorites:     [],
  ytPlayer:      null,
  ytReady:       false,
  progressTimer: null,

  // ── iOS BACKGROUND FIX ──────────────────────
  // Guardamos la posición cuando la app va a segundo plano
  // para poder reanudar exactamente donde se quedó.
  backgroundPos: 0,
};

/* ─────────────────────────────────────────────
   3. REFERENCIAS DOM
   ───────────────────────────────────────────── */
const dom = {
  searchForm:        document.getElementById('searchForm'),
  searchInput:       document.getElementById('searchInput'),
  loader:            document.getElementById('loader'),
  emptyState:        document.getElementById('emptyState'),
  trackList:         document.getElementById('trackList'),
  favoritesList:     document.getElementById('favoritesList'),
  emptyFavorites:    document.getElementById('emptyFavorites'),
  favCount:          document.getElementById('favCount'),
  resultsPanel:      document.getElementById('resultsPanel'),
  favoritesPanel:    document.getElementById('favoritesPanel'),
  tabs:              document.querySelectorAll('.tab'),

  playerTitle:       document.getElementById('playerTitle'),
  playerChannel:     document.getElementById('playerChannel'),
  playerThumb:       document.getElementById('playerThumb'),
  playerFavBtn:      document.getElementById('playerFavBtn'),
  iconPlay:          document.getElementById('iconPlay'),
  iconPause:         document.getElementById('iconPause'),
  playBtn:           document.getElementById('playBtn'),
  prevBtn:           document.getElementById('prevBtn'),
  nextBtn:           document.getElementById('nextBtn'),
  progressBar:       document.getElementById('progressBar'),
  progressContainer: document.getElementById('progressContainer'),
  currentTime:       document.getElementById('currentTime'),
  totalTime:         document.getElementById('totalTime'),
};

/* ═══════════════════════════════════════════════
   4. YOUTUBE IFRAME API
   ═══════════════════════════════════════════════

   CORRECCIÓN iOS #1 — playerVars críticos:
   ┌─────────────────┬───────────────────────────────────────────┐
   │ playsinline: 1  │ Impide que iOS abra el video en pantalla  │
   │                 │ completa nativa, que sí se suspende.       │
   │ origin          │ Autoriza el dominio de GitHub Pages para   │
   │                 │ evitar que WebKit bloquee el iframe.        │
   └─────────────────┴───────────────────────────────────────────┘
*/
function onYouTubeIframeAPIReady() {
  state.ytPlayer = new YT.Player('ytPlayer', {
    height: '1',
    width:  '1',
    playerVars: {
      autoplay:       0,
      controls:       0,
      disablekb:      1,
      fs:             0,
      iv_load_policy: 3,
      modestbranding: 1,
      rel:            0,
      playsinline:    1,                      // ← CRÍTICO iOS
      origin:         window.location.origin, // ← CRÍTICO iOS CORS
    },
    events: {
      onReady:       onPlayerReady,
      onStateChange: onPlayerStateChange,
    },
  });
}

function onPlayerReady() {
  state.ytReady = true;
  console.log('[TuneFlow] YouTube Player listo.');

  /* CORRECCIÓN iOS #2 — Registrar MediaSession en onReady
     En iOS, los handlers de MediaSession DEBEN registrarse antes
     de la primera reproducción. Si se registran después (p.ej.
     en onPlayerStateChange), el sistema los ignora en la pantalla
     de bloqueo. Los registramos aquí, una sola vez, con callbacks
     estables que siempre llaman al estado actual. */
  registerMediaSessionHandlers();
}

function onPlayerStateChange(event) {
  const YTS = YT.PlayerState;

  if (event.data === YTS.PLAYING) {
    state.isPlaying = true;
    updatePlayPauseIcon();
    startProgressTimer();
    /* Actualiza metadatos (título, artwork) en la pantalla de bloqueo.
       Se hace aquí y NO en onReady porque necesitamos el track actual. */
    syncMediaSessionMetadata();
    syncMediaSessionPositionState(); // Barra de progreso en lock screen

  } else if (event.data === YTS.PAUSED) {
    state.isPlaying = false;
    updatePlayPauseIcon();
    stopProgressTimer();
    // Guarda la posición exacta al pausar (necesaria al volver del fondo)
    state.backgroundPos = state.ytPlayer.getCurrentTime?.() || 0;

  } else if (event.data === YTS.BUFFERING) {
    // No cambiamos isPlaying durante buffering: la UI no "parpadea"
    stopProgressTimer();

  } else if (event.data === YTS.ENDED) {
    playNext();
  }
}

/* ═══════════════════════════════════════════════
   5. MEDIA SESSION API — Pantalla de Bloqueo iOS
   ═══════════════════════════════════════════════

   CORRECCIÓN iOS #3 — Separar registro de handlers (una vez)
   de la actualización de metadatos (en cada canción).

   iOS Safari requiere:
   a) Los handlers registrados antes del primer play → onPlayerReady
   b) Los metadatos actualizados en cada canción nueva
   c) setPositionState() para que la barra de progreso aparezca
      en el widget de la pantalla de bloqueo (iOS 15+)
*/
function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', () => {
    state.ytPlayer?.playVideo();
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    state.ytPlayer?.pauseVideo();
  });

  navigator.mediaSession.setActionHandler('nexttrack', playNext);

  navigator.mediaSession.setActionHandler('previoustrack', playPrev);

  // Seek interactivo desde la pantalla de bloqueo (iOS 16+)
  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) {
        state.ytPlayer?.seekTo(details.seekTime, true);
        syncMediaSessionPositionState();
      }
    });
  } catch (e) {
    // iOS 15 no soporta seekto → lo ignoramos silenciosamente
  }

  console.log('[TuneFlow] MediaSession handlers registrados.');
}

/* Actualiza el título, artista y artwork en la pantalla de bloqueo */
function syncMediaSessionMetadata() {
  if (!('mediaSession' in navigator)) return;
  const track = state.queue[state.currentIndex];
  if (!track) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title,
    artist: track.channel,
    album:  'TuneFlow',
    // iOS necesita al menos una imagen; sin artwork no muestra el widget
    artwork: [
      { src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' },
    ],
  });
}

/* Actualiza la barra de progreso que aparece en el widget de lock screen */
function syncMediaSessionPositionState() {
  if (!('mediaSession' in navigator)) return;
  if (!state.ytPlayer?.getDuration) return;

  const duration = state.ytPlayer.getDuration() || 0;
  const position = state.ytPlayer.getCurrentTime() || 0;

  if (duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: Math.min(position, duration), // position <= duration obligatorio
    });
  } catch (e) {
    // Algunos navegadores no soportan setPositionState → no es crítico
  }
}

/* ═══════════════════════════════════════════════
   6. GESTIÓN DE SEGUNDO PLANO — Page Visibility API
   ═══════════════════════════════════════════════

   CORRECCIÓN iOS #4 — Manejar el ciclo de vida de la página.

   Cuando el usuario bloquea el iPhone o cambia de app, iOS lanza
   el evento 'visibilitychange' con document.hidden = true.
   Si el audio estaba sonando, guardamos la posición y cuando
   la app vuelve al frente (hidden = false) nos aseguramos de
   que el player siga reproduciendo.
*/
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // App va a segundo plano
    if (state.isPlaying && state.ytPlayer) {
      state.backgroundPos = state.ytPlayer.getCurrentTime?.() || 0;
    }
    stopProgressTimer(); // No necesitamos actualizar la UI si no es visible
  } else {
    // App vuelve al primer plano
    if (state.isPlaying && state.ytPlayer) {
      // iOS a veces pausa el video al volver: forzamos play
      setTimeout(() => {
        const playerState = state.ytPlayer.getPlayerState?.();
        if (playerState === YT.PlayerState.PAUSED && state.isPlaying) {
          state.ytPlayer.playVideo();
        }
        startProgressTimer();
        syncMediaSessionPositionState();
      }, 300); // Pequeño delay para que el iframe esté activo
    }
  }
});

/* ═══════════════════════════════════════════════
   7. BÚSQUEDA EN YOUTUBE DATA API v3
   ═══════════════════════════════════════════════ */
async function searchYouTube(query) {
  if (!query.trim()) return;

  if (YT_API_KEY === 'PEGA_TU_API_KEY_AQUI') {
    alert('⚠️ Debes añadir tu YouTube Data API Key en script.js (línea ~12).');
    return;
  }

  showLoader(true);
  clearResults();

  const params = new URLSearchParams({
    part:            'snippet',
    q:               query + ' official audio',
    type:            'video',
    videoCategoryId: '10', // Música
    maxResults:      MAX_RESULTS,
    key:             YT_API_KEY,
    safeSearch:      'none',
  });

  try {
    const res  = await fetch(`${YT_SEARCH_URL}?${params}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error.message);

    state.queue = data.items.map(item => ({
      id:        item.id.videoId,
      title:     item.snippet.title,
      channel:   item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
    }));

    renderTrackList(state.queue, dom.trackList);
    showEmptyState(false);

  } catch (err) {
    console.error('[TuneFlow] Error en búsqueda:', err);
    showErrorMessage(err.message);
  } finally {
    showLoader(false);
  }
}

/* ═══════════════════════════════════════════════
   8. REPRODUCCIÓN
   ═══════════════════════════════════════════════ */
function playTrack(index, queue) {
  if (!state.ytReady) {
    console.warn('[TuneFlow] Player aún no está listo.');
    return;
  }

  if (queue) state.queue = queue;

  state.currentIndex = index;
  const track = state.queue[index];
  if (!track) return;

  state.ytPlayer.loadVideoById(track.id);
  state.isPlaying = true;

  updatePlayerUI(track);
  highlightActiveCard(track.id);
  updatePlayPauseIcon();
  // Los metadatos se sincronizan en onPlayerStateChange → PLAYING
  // para asegurarnos de que el iframe ya tenga duración disponible
}

function togglePlayPause() {
  if (!state.ytReady || state.currentIndex < 0) return;
  if (state.isPlaying) {
    state.ytPlayer.pauseVideo();
  } else {
    state.ytPlayer.playVideo();
  }
}

function playNext() {
  if (!state.queue.length) return;
  playTrack((state.currentIndex + 1) % state.queue.length);
}

function playPrev() {
  if (!state.queue.length) return;
  const elapsed = state.ytPlayer.getCurrentTime?.() || 0;
  if (elapsed > 3) {
    state.ytPlayer.seekTo(0, true);
    syncMediaSessionPositionState();
    return;
  }
  const prevIdx = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(prevIdx);
}

/* ═══════════════════════════════════════════════
   9. ACTUALIZACIÓN DE LA UI DEL PLAYER
   ═══════════════════════════════════════════════ */
function updatePlayerUI(track) {
  dom.playerTitle.textContent   = track.title;
  dom.playerChannel.textContent = track.channel;

  dom.playerThumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = track.thumbnail;
  img.alt = track.title;
  dom.playerThumb.appendChild(img);

  const isFav = isFavorite(track.id);
  dom.playerFavBtn.classList.toggle('active', isFav);
  dom.playerFavBtn.setAttribute('aria-label', isFav ? 'Quitar de favoritos' : 'Añadir a favoritos');
}

function updatePlayPauseIcon() {
  dom.iconPlay.classList.toggle('hidden', state.isPlaying);
  dom.iconPause.classList.toggle('hidden', !state.isPlaying);
}

function highlightActiveCard(videoId) {
  document.querySelectorAll('.track-card').forEach(card => {
    card.classList.toggle('playing', card.dataset.id === videoId);
  });
}

/* ═══════════════════════════════════════════════
   10. BARRA DE PROGRESO
   ═══════════════════════════════════════════════ */
function startProgressTimer() {
  stopProgressTimer();
  // Actualizamos cada 500ms cuando la app está en primer plano
  state.progressTimer = setInterval(() => {
    if (!state.isPlaying || document.hidden) return;
    updateProgress();
  }, 500);
}

function stopProgressTimer() {
  if (state.progressTimer) {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function updateProgress() {
  if (!state.ytReady) return;
  const current  = state.ytPlayer.getCurrentTime?.() || 0;
  const duration = state.ytPlayer.getDuration?.()    || 0;

  if (duration > 0) {
    dom.progressBar.style.width = `${(current / duration) * 100}%`;
  }
  dom.currentTime.textContent = formatTime(current);
  dom.totalTime.textContent   = formatTime(duration);
}

dom.progressContainer.addEventListener('click', (e) => {
  if (!state.ytReady || state.currentIndex < 0) return;
  const rect     = dom.progressContainer.getBoundingClientRect();
  const pct      = (e.clientX - rect.left) / rect.width;
  const duration = state.ytPlayer.getDuration?.() || 0;
  state.ytPlayer.seekTo(pct * duration, true);
  syncMediaSessionPositionState();
});

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ═══════════════════════════════════════════════
   11. FAVORITOS — localStorage
   ═══════════════════════════════════════════════ */
const FAV_KEY = 'tuneflow_favorites';

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    state.favorites = raw ? JSON.parse(raw) : [];
  } catch {
    state.favorites = [];
  }
}

function saveFavorites() {
  localStorage.setItem(FAV_KEY, JSON.stringify(state.favorites));
}

function isFavorite(videoId) {
  return state.favorites.some(t => t.id === videoId);
}

function toggleFavorite(track) {
  const idx = state.favorites.findIndex(t => t.id === track.id);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
  } else {
    state.favorites.unshift(track);
  }
  saveFavorites();
  refreshFavUI(track.id);
  renderFavoritesList();
}

function refreshFavUI(videoId) {
  const isFav = isFavorite(videoId);
  document.querySelectorAll(`.fav-btn[data-id="${videoId}"]`).forEach(btn => {
    btn.classList.toggle('active', isFav);
    btn.setAttribute('aria-label', isFav ? 'Quitar de favoritos' : 'Añadir a favoritos');
  });
  const current = state.queue[state.currentIndex];
  if (current?.id === videoId) {
    dom.playerFavBtn.classList.toggle('active', isFav);
  }
}

/* ═══════════════════════════════════════════════
   12. RENDERIZADO DE LISTAS
   ═══════════════════════════════════════════════ */
function createTrackCard(track, queue) {
  const isActive = state.queue[state.currentIndex]?.id === track.id;
  const isFav    = isFavorite(track.id);

  const card = document.createElement('div');
  card.className = `track-card${isActive ? ' playing' : ''}`;
  card.dataset.id = track.id;

  card.innerHTML = `
    <div class="track-thumb-wrapper">
      <img class="track-thumb" src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}" loading="lazy" />
      <div class="now-playing-overlay">
        <div class="bars"><span></span><span></span><span></span></div>
      </div>
    </div>
    <div class="track-info">
      <p class="track-title">${escapeHtml(track.title)}</p>
      <p class="track-channel">${escapeHtml(track.channel)}</p>
    </div>
    <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${escapeHtml(track.id)}"
            aria-label="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
      <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.fav-btn')) return;
    const queueToUse = queue || state.queue;
    const idx = queueToUse.findIndex(t => t.id === track.id);
    playTrack(idx, queueToUse);
  });

  card.querySelector('.fav-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(track);
  });

  return card;
}

function renderTrackList(tracks, container) {
  container.innerHTML = '';
  if (!tracks.length) return;
  const fragment = document.createDocumentFragment();
  tracks.forEach(track => fragment.appendChild(createTrackCard(track, tracks)));
  container.appendChild(fragment);
}

function renderFavoritesList() {
  dom.favoritesList.innerHTML = '';
  dom.favCount.textContent = `${state.favorites.length} ${state.favorites.length === 1 ? 'canción' : 'canciones'}`;
  if (!state.favorites.length) {
    dom.emptyFavorites.classList.remove('hidden');
    return;
  }
  dom.emptyFavorites.classList.add('hidden');
  renderTrackList(state.favorites, dom.favoritesList);
}

/* ═══════════════════════════════════════════════
   13. NAVEGACIÓN POR TABS
   ═══════════════════════════════════════════════ */
dom.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    dom.tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
      t.setAttribute('aria-selected', t.dataset.tab === target ? 'true' : 'false');
    });
    dom.resultsPanel.classList.toggle('active', target === 'results');
    dom.favoritesPanel.classList.toggle('active', target === 'favorites');
    if (target === 'favorites') renderFavoritesList();
  });
});

/* ═══════════════════════════════════════════════
   14. EVENTOS DE CONTROLES
   ═══════════════════════════════════════════════ */
dom.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = dom.searchInput.value.trim();
  if (!q) return;
  dom.tabs.forEach(t => {
    const isRes = t.dataset.tab === 'results';
    t.classList.toggle('active', isRes);
    t.setAttribute('aria-selected', isRes ? 'true' : 'false');
  });
  dom.resultsPanel.classList.add('active');
  dom.favoritesPanel.classList.remove('active');
  searchYouTube(q);
  dom.searchInput.blur();
});

dom.playBtn.addEventListener('click', togglePlayPause);
dom.nextBtn.addEventListener('click', playNext);
dom.prevBtn.addEventListener('click', playPrev);

dom.playerFavBtn.addEventListener('click', () => {
  const track = state.queue[state.currentIndex];
  if (track) toggleFavorite(track);
});

/* ═══════════════════════════════════════════════
   15. HELPERS DE UI
   ═══════════════════════════════════════════════ */
function showLoader(show) {
  dom.loader.classList.toggle('hidden', !show);
}

function showEmptyState(show) {
  dom.emptyState.style.display = show ? 'flex' : 'none';
}

function clearResults() {
  dom.trackList.innerHTML = '';
}

function showErrorMessage(msg) {
  dom.trackList.innerHTML = `
    <div class="empty-state" style="display:flex">
      <div class="empty-icon">⚠️</div>
      <p class="empty-title">Error al buscar</p>
      <p class="empty-sub">${escapeHtml(msg)}</p>
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

/* ═══════════════════════════════════════════════
   16. INICIALIZACIÓN
   ═══════════════════════════════════════════════ */
function init() {
  loadFavorites();
  showEmptyState(true);
  console.log('[TuneFlow v2] App inicializada. Favoritos:', state.favorites.length);
}

init();
