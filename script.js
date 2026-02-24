/* ==============================================
   TUNEFLOW — script.js
   Lógica: Búsqueda YouTube, Reproductor,
           Favoritos (localStorage), MediaSession API
   ============================================== */

/* ─────────────────────────────────────────────
   1. CONFIGURACIÓN — ¡PEGA TU API KEY AQUÍ!
   Obtén una en: https://console.cloud.google.com
   Activa: "YouTube Data API v3"
   ───────────────────────────────────────────── */
const YT_API_KEY = 'AIzaSyDuqcBihV_xdkHr3F0mCLhaCPz4uibpjj4'; // <-- ⚠️ REEMPLAZA ESTO

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS    = 15;   // Canciones por búsqueda

/* ─────────────────────────────────────────────
   2. ESTADO GLOBAL DE LA APLICACIÓN
   ───────────────────────────────────────────── */
const state = {
  queue:        [],    // Array de tracks del resultado actual
  currentIndex: -1,   // Índice del track que suena
  isPlaying:    false,
  favorites:    [],    // Se carga desde localStorage
  ytPlayer:     null,  // Instancia del YT.Player
  ytReady:      false, // ¿Está listo el iframe API?
  progressTimer: null, // setInterval para actualizar la barra
};

/* ─────────────────────────────────────────────
   3. REFERENCIAS DOM
   ───────────────────────────────────────────── */
const dom = {
  searchForm:      document.getElementById('searchForm'),
  searchInput:     document.getElementById('searchInput'),
  loader:          document.getElementById('loader'),
  emptyState:      document.getElementById('emptyState'),
  trackList:       document.getElementById('trackList'),
  favoritesList:   document.getElementById('favoritesList'),
  emptyFavorites:  document.getElementById('emptyFavorites'),
  favCount:        document.getElementById('favCount'),
  resultsPanel:    document.getElementById('resultsPanel'),
  favoritesPanel:  document.getElementById('favoritesPanel'),
  tabs:            document.querySelectorAll('.tab'),

  // Player bar
  playerTitle:     document.getElementById('playerTitle'),
  playerChannel:   document.getElementById('playerChannel'),
  playerThumb:     document.getElementById('playerThumb'),
  playerFavBtn:    document.getElementById('playerFavBtn'),
  iconPlay:        document.getElementById('iconPlay'),
  iconPause:       document.getElementById('iconPause'),
  playBtn:         document.getElementById('playBtn'),
  prevBtn:         document.getElementById('prevBtn'),
  nextBtn:         document.getElementById('nextBtn'),
  progressBar:     document.getElementById('progressBar'),
  progressContainer: document.getElementById('progressContainer'),
  currentTime:     document.getElementById('currentTime'),
  totalTime:       document.getElementById('totalTime'),
};

/* ─────────────────────────────────────────────
   4. YOUTUBE IFRAME API
   La función onYouTubeIframeAPIReady() la llama
   automáticamente la librería cuando está lista.
   ───────────────────────────────────────────── */
function onYouTubeIframeAPIReady() {
  state.ytPlayer = new YT.Player('ytPlayer', {
    height: '1',
    width:  '1',
    playerVars: {
      autoplay:       0,
      controls:       0,   // Sin controles nativos de YT
      disablekb:      1,
      fs:             0,
      iv_load_policy: 3,   // Sin anotaciones
      modestbranding: 1,
      rel:            0,
      playsinline:    1,   // CRÍTICO para iOS: reproduce dentro de la página
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
}

/* Maneja los cambios de estado del reproductor de YT */
function onPlayerStateChange(event) {
  const YTS = YT.PlayerState;

  if (event.data === YTS.PLAYING) {
    state.isPlaying = true;
    updatePlayPauseIcon();
    startProgressTimer();
    updateMediaSession(); // Actualiza la pantalla de bloqueo

  } else if (event.data === YTS.PAUSED || event.data === YTS.BUFFERING) {
    state.isPlaying = false;
    updatePlayPauseIcon();
    stopProgressTimer();

  } else if (event.data === YTS.ENDED) {
    // Avanza automáticamente a la siguiente canción
    playNext();
  }
}

/* ─────────────────────────────────────────────
   5. BÚSQUEDA EN YOUTUBE DATA API v3
   ───────────────────────────────────────────── */
async function searchYouTube(query) {
  if (!query.trim()) return;

  // Validación: si no se cambió la API key, avisa al usuario
  if (YT_API_KEY === 'PEGA_TU_API_KEY_AQUI') {
    alert('⚠️ Debes añadir tu YouTube Data API Key en script.js (línea ~18).');
    return;
  }

  showLoader(true);
  clearResults();

  const params = new URLSearchParams({
    part:        'snippet',
    q:           query + ' official audio',  // Prioriza audio oficial
    type:        'video',
    videoCategoryId: '10',  // Categoría: Música
    maxResults:  MAX_RESULTS,
    key:         YT_API_KEY,
    safeSearch:  'none',
  });

  try {
    const res  = await fetch(`${YT_SEARCH_URL}?${params}`);
    const data = await res.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    // Transforma los items en objetos de track
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

/* ─────────────────────────────────────────────
   6. REPRODUCCIÓN
   ───────────────────────────────────────────── */

/* Reproduce un track por índice del queue */
function playTrack(index, queue) {
  if (!state.ytReady) {
    console.warn('[TuneFlow] Player aún no está listo.');
    return;
  }

  // Si se recibe un queue diferente (p.ej. desde favoritos), lo cargamos
  if (queue) state.queue = queue;

  state.currentIndex = index;
  const track = state.queue[index];
  if (!track) return;

  // Carga y reproduce el video en el iframe oculto
  state.ytPlayer.loadVideoById(track.id);
  state.isPlaying = true;

  updatePlayerUI(track);
  highlightActiveCard(track.id);
  updatePlayPauseIcon();
}

/* Pausa o reanuda */
function togglePlayPause() {
  if (!state.ytReady || state.currentIndex < 0) return;

  if (state.isPlaying) {
    state.ytPlayer.pauseVideo();
  } else {
    state.ytPlayer.playVideo();
  }
}

function playNext() {
  if (state.queue.length === 0) return;
  const nextIndex = (state.currentIndex + 1) % state.queue.length;
  playTrack(nextIndex);
}

function playPrev() {
  if (state.queue.length === 0) return;
  // Si llevamos más de 3 seg. reproducidos, vuelve al inicio de la canción
  const elapsed = state.ytPlayer.getCurrentTime?.() || 0;
  if (elapsed > 3) {
    state.ytPlayer.seekTo(0, true);
    return;
  }
  const prevIndex = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
  playTrack(prevIndex);
}

/* ─────────────────────────────────────────────
   7. ACTUALIZACIÓN DE LA UI DEL PLAYER
   ───────────────────────────────────────────── */
function updatePlayerUI(track) {
  dom.playerTitle.textContent   = track.title;
  dom.playerChannel.textContent = track.channel;

  // Actualiza el thumbnail en el player bar
  dom.playerThumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = track.thumbnail;
  img.alt = track.title;
  dom.playerThumb.appendChild(img);

  // Actualiza el botón de favorito del player
  const isFav = isFavorite(track.id);
  dom.playerFavBtn.classList.toggle('active', isFav);
  dom.playerFavBtn.setAttribute('aria-label', isFav ? 'Quitar de favoritos' : 'Añadir a favoritos');
}

function updatePlayPauseIcon() {
  dom.iconPlay.classList.toggle('hidden', state.isPlaying);
  dom.iconPause.classList.toggle('hidden', !state.isPlaying);
}

/* Resalta la card del track activo */
function highlightActiveCard(videoId) {
  document.querySelectorAll('.track-card').forEach(card => {
    const isActive = card.dataset.id === videoId;
    card.classList.toggle('playing', isActive);
  });
}

/* ─────────────────────────────────────────────
   8. BARRA DE PROGRESO
   ───────────────────────────────────────────── */
function startProgressTimer() {
  stopProgressTimer(); // Evita timers duplicados
  state.progressTimer = setInterval(updateProgress, 500);
}

function stopProgressTimer() {
  if (state.progressTimer) {
    clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function updateProgress() {
  if (!state.ytReady || !state.isPlaying) return;

  const current  = state.ytPlayer.getCurrentTime?.() || 0;
  const duration = state.ytPlayer.getDuration?.() || 0;

  if (duration > 0) {
    const pct = (current / duration) * 100;
    dom.progressBar.style.width = `${pct}%`;
  }

  dom.currentTime.textContent = formatTime(current);
  dom.totalTime.textContent   = formatTime(duration);
}

/* Seek al tocar/hacer click en la barra de progreso */
dom.progressContainer.addEventListener('click', (e) => {
  if (!state.ytReady || state.currentIndex < 0) return;
  const rect = dom.progressContainer.getBoundingClientRect();
  const pct  = (e.clientX - rect.left) / rect.width;
  const duration = state.ytPlayer.getDuration?.() || 0;
  state.ytPlayer.seekTo(pct * duration, true);
});

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/* ─────────────────────────────────────────────
   9. MEDIA SESSION API
   Muestra nombre de canción + controles en la
   pantalla de bloqueo de iOS / notificaciones.
   ───────────────────────────────────────────── */
function updateMediaSession() {
  // Verifica soporte (iOS 15+ en Safari lo soporta)
  if (!('mediaSession' in navigator)) return;

  const track = state.queue[state.currentIndex];
  if (!track) return;

  // Metadatos de la canción para la pantalla de bloqueo
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  track.title,
    artist: track.channel,
    album:  'TuneFlow',
    artwork: [
      { src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' },
    ],
  });

  // Registra las acciones de los botones del sistema
  navigator.mediaSession.setActionHandler('play',  () => {
    state.ytPlayer.playVideo();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    state.ytPlayer.pauseVideo();
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNext();
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    playPrev();
  });
  // Seek desde la pantalla de bloqueo (iOS 16+)
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime !== undefined) {
      state.ytPlayer.seekTo(details.seekTime, true);
    }
  });
}

/* ─────────────────────────────────────────────
   10. FAVORITOS — localStorage
   ───────────────────────────────────────────── */
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
    // Ya era favorito → lo eliminamos
    state.favorites.splice(idx, 1);
  } else {
    // No era favorito → lo añadimos al principio
    state.favorites.unshift(track);
  }

  saveFavorites();
  refreshFavUI(track.id);
  renderFavoritesList(); // Actualiza el panel de favoritos
}

/* Actualiza visualmente todos los botones ♥ de un track específico */
function refreshFavUI(videoId) {
  const isFav = isFavorite(videoId);

  // Botones en las cards de resultados
  document.querySelectorAll(`.fav-btn[data-id="${videoId}"]`).forEach(btn => {
    btn.classList.toggle('active', isFav);
    btn.setAttribute('aria-label', isFav ? 'Quitar de favoritos' : 'Añadir a favoritos');
  });

  // Botón en el player bar (si es la canción actual)
  const current = state.queue[state.currentIndex];
  if (current?.id === videoId) {
    dom.playerFavBtn.classList.toggle('active', isFav);
  }
}

/* ─────────────────────────────────────────────
   11. RENDERIZADO DE LISTAS
   ───────────────────────────────────────────── */
function createTrackCard(track, queue) {
  const isPlaying = state.queue[state.currentIndex]?.id === track.id && state.isPlaying;
  const isFav     = isFavorite(track.id);

  const card = document.createElement('div');
  card.className = `track-card${isPlaying ? ' playing' : ''}`;
  card.dataset.id = track.id;

  card.innerHTML = `
    <div class="track-thumb-wrapper">
      <img class="track-thumb" src="${escapeHtml(track.thumbnail)}" alt="${escapeHtml(track.title)}" loading="lazy" />
      <div class="now-playing-overlay">
        <div class="bars">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
    <div class="track-info">
      <p class="track-title">${escapeHtml(track.title)}</p>
      <p class="track-channel">${escapeHtml(track.channel)}</p>
    </div>
    <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${escapeHtml(track.id)}" aria-label="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
      <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>
  `;

  // Click en la card → reproduce
  card.addEventListener('click', (e) => {
    // Si hicieron click en el botón fav, no reproducir
    if (e.target.closest('.fav-btn')) return;
    const queueToUse = queue || state.queue;
    const idx = queueToUse.findIndex(t => t.id === track.id);
    playTrack(idx, queueToUse);
  });

  // Click en el botón favorito
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
  tracks.forEach(track => {
    fragment.appendChild(createTrackCard(track, tracks));
  });
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

/* ─────────────────────────────────────────────
   12. NAVEGACIÓN POR TABS
   ───────────────────────────────────────────── */
dom.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    dom.tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
      t.setAttribute('aria-selected', t.dataset.tab === target ? 'true' : 'false');
    });

    dom.resultsPanel.classList.toggle('active', target === 'results');
    dom.favoritesPanel.classList.toggle('active', target === 'favorites');

    // Al abrir favoritos, regenera la lista por si hubo cambios
    if (target === 'favorites') renderFavoritesList();
  });
});

/* ─────────────────────────────────────────────
   13. EVENTOS DE LOS CONTROLES
   ───────────────────────────────────────────── */
dom.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = dom.searchInput.value.trim();
  if (q) {
    // Asegura que el tab de resultados esté activo
    dom.tabs.forEach(t => {
      const isResults = t.dataset.tab === 'results';
      t.classList.toggle('active', isResults);
      t.setAttribute('aria-selected', isResults ? 'true' : 'false');
    });
    dom.resultsPanel.classList.add('active');
    dom.favoritesPanel.classList.remove('active');

    searchYouTube(q);
    dom.searchInput.blur(); // Cierra el teclado en iOS
  }
});

dom.playBtn.addEventListener('click', togglePlayPause);
dom.nextBtn.addEventListener('click', playNext);
dom.prevBtn.addEventListener('click', playPrev);

/* Botón favorito en el player bar */
dom.playerFavBtn.addEventListener('click', () => {
  const track = state.queue[state.currentIndex];
  if (track) toggleFavorite(track);
});

/* ─────────────────────────────────────────────
   14. HELPERS DE UI
   ───────────────────────────────────────────── */
function showLoader(show) {
  dom.loader.classList.toggle('hidden', !show);
}

function showEmptyState(show) {
  dom.emptyState.classList.toggle('hidden', !show);
  if (show) {
    dom.emptyState.style.display = 'flex';
  } else {
    dom.emptyState.style.display = 'none';
  }
}

function clearResults() {
  dom.trackList.innerHTML = '';
}

function showErrorMessage(msg) {
  dom.trackList.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <p class="empty-title">Error al buscar</p>
      <p class="empty-sub">${escapeHtml(msg)}</p>
    </div>
  `;
}

/* Escapa HTML para evitar XSS con datos de YouTube */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ─────────────────────────────────────────────
   15. INICIALIZACIÓN
   ───────────────────────────────────────────── */
function init() {
  loadFavorites();
  showEmptyState(true);
  console.log('[TuneFlow] App inicializada. Favoritos cargados:', state.favorites.length);
}

init();
