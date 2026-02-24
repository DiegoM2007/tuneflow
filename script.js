/* ════════════════════════════════════════════════════════════
   TUNEFLOW — script.js
   ════════════════════════════════════════════════════════════

   RESUMEN DE FIXES iOS (todos aplicados desde cero):

   [FIX-1] Ghost iframe → el contenedor #yt-ghost usa
           position:fixed + opacity:0 SIN overflow:hidden.
           WebKit considera el nodo "activo" y no lo mata.

   [FIX-2] playsinline:1 + origin en playerVars → evita que
           iOS abra el video en pantalla completa nativa
           (que sí se suspende) y resuelve errores CORS.

   [FIX-3] MediaSession handlers registrados en onPlayerReady
           (ANTES del primer play), no en cada cambio de estado.
           iOS requiere que los handlers existan antes del
           primer gesto de reproducción.

   [FIX-4] Page Visibility API → al volver del fondo iOS
           a veces pausa el iframe aunque la música seguía.
           Detectamos hidden/visible y forzamos playVideo().

   [FIX-5] setPositionState() → actualiza la barra de progreso
           del widget de pantalla de bloqueo (iOS 15+).
════════════════════════════════════════════════════════════ */

/* ── 1. CONFIGURACIÓN ────────────────────────────────────── */

// ⚠️  PEGA AQUÍ TU API KEY de YouTube Data API v3
// Consíguela en: https://console.cloud.google.com
// Activa el servicio: "YouTube Data API v3"
const API_KEY = 'AIzaSyDuqcBihV_xdkHr3F0mCLhaCPz4uibpjj4';

const SEARCH_URL  = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS = 15;
const FAV_KEY     = 'tuneflow_v2_favorites';

/* ── 2. ESTADO ───────────────────────────────────────────── */
const S = {
  player:       null,   // instancia YT.Player
  ytReady:      false,  // iframe listo
  queue:        [],     // tracks activos (resultados o favs)
  idx:          -1,     // índice actual en queue
  playing:      false,  // ¿reproductor activo?
  favorites:    [],     // guardados en localStorage
  ticker:       null,   // setInterval del progreso
  bgPos:        0,      // posición guardada al ir al fondo
};

/* ── 3. DOM ──────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const D = {
  searchForm:    $('searchForm'),
  searchInput:   $('searchInput'),
  splash:        $('splash'),
  loader:        $('loader'),
  trackList:     $('trackList'),
  favList:       $('favList'),
  favCount:      $('favCount'),
  favEmpty:      $('favEmpty'),
  panelResults:  $('panel-results'),
  panelFavs:     $('panel-favorites'),
  tabs:          document.querySelectorAll('.tab'),

  playerTitle:   $('playerTitle'),
  playerArtist:  $('playerArtist'),
  playerThumb:   $('playerThumb'),
  playerHeart:   $('playerHeart'),

  progressTrack: $('progressTrack'),
  progressFill:  $('progressFill'),
  timeCurrent:   $('timeCurrent'),
  timeDuration:  $('timeDuration'),

  btnPlay:       $('btnPlay'),
  btnPrev:       $('btnPrev'),
  btnNext:       $('btnNext'),
  icoPlay:       $('icoPlay'),
  icoPause:      $('icoPause'),
};

/* ════════════════════════════════════════════════════════════
   4. YOUTUBE IFRAME API
   La librería llama onYouTubeIframeAPIReady() globalmente
   cuando está lista. Debe ser window-level.
════════════════════════════════════════════════════════════ */
window.onYouTubeIframeAPIReady = function () {
  S.player = new YT.Player('yt-player', {
    width:  '1',
    height: '1',
    playerVars: {
      autoplay:       0,
      controls:       0,
      disablekb:      1,
      fs:             0,
      iv_load_policy: 3,
      modestbranding: 1,
      rel:            0,
      // [FIX-2a] playsinline → sin esto iOS abre el video
      //          en pantalla completa nativa y lo suspende
      playsinline:    1,
      // [FIX-2b] origin → evita errores CORS silenciosos
      //          que cortan el audio al bloquear pantalla
      origin:         window.location.origin,
    },
    events: {
      onReady:       _onYTReady,
      onStateChange: _onYTStateChange,
    },
  });
};

function _onYTReady() {
  S.ytReady = true;
  // [FIX-3] Registrar handlers ANTES del primer play
  _registerMediaHandlers();
}

function _onYTStateChange(e) {
  const ST = YT.PlayerState;

  if (e.data === ST.PLAYING) {
    S.playing = true;
    _setPlayIcon(true);
    _startTicker();
    _syncMeta();       // título + artwork en lock screen
    _syncPosition();   // barra de progreso en lock screen

  } else if (e.data === ST.PAUSED) {
    S.playing = false;
    _setPlayIcon(false);
    _stopTicker();
    S.bgPos = S.player.getCurrentTime?.() ?? 0;

  } else if (e.data === ST.BUFFERING) {
    // Durante buffering no tocamos S.playing para evitar
    // que el icono parpadee; sólo pausamos el ticker de UI
    _stopTicker();

  } else if (e.data === ST.ENDED) {
    playNext();
  }
}

/* ════════════════════════════════════════════════════════════
   5. MEDIA SESSION API — pantalla de bloqueo iOS
════════════════════════════════════════════════════════════ */

// [FIX-3] Se llama UNA SOLA VEZ en onPlayerReady
function _registerMediaHandlers() {
  if (!('mediaSession' in navigator)) return;

  const ms = navigator.mediaSession;

  ms.setActionHandler('play',          () => S.player?.playVideo());
  ms.setActionHandler('pause',         () => S.player?.pauseVideo());
  ms.setActionHandler('nexttrack',     playNext);
  ms.setActionHandler('previoustrack', playPrev);

  // seekto disponible en iOS 16+; envuelto en try/catch por si no existe
  try {
    ms.setActionHandler('seekto', detail => {
      if (detail.seekTime != null) {
        S.player?.seekTo(detail.seekTime, true);
        _syncPosition();
      }
    });
  } catch (_) { /* iOS 15 — ignorado */ }
}

// Actualiza título, artista e imagen en el widget de lock screen
function _syncMeta() {
  if (!('mediaSession' in navigator)) return;
  const t = S.queue[S.idx];
  if (!t) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title:   t.title,
    artist:  t.channel,
    album:   'TuneFlow',
    artwork: [{ src: t.thumbnail, sizes: '320x180', type: 'image/jpeg' }],
  });
}

// [FIX-5] Actualiza la barra de progreso en el widget de lock screen
function _syncPosition() {
  if (!('mediaSession' in navigator)) return;
  if (!S.player?.getDuration) return;

  const duration = S.player.getDuration()    || 0;
  const position = S.player.getCurrentTime() || 0;

  if (duration <= 0) return;

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      // position NUNCA puede superar duration (lanza error si lo hace)
      position: Math.min(position, duration),
    });
  } catch (_) { /* navegadores sin soporte */ }
}

/* ════════════════════════════════════════════════════════════
   6. PAGE VISIBILITY API — segundo plano iOS
   [FIX-4] iOS a veces pausa el iframe al volver del fondo
════════════════════════════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Guardamos posición por si iOS pausa el iframe
    if (S.playing && S.player) {
      S.bgPos = S.player.getCurrentTime?.() ?? 0;
    }
    _stopTicker();   // ahorramos batería: no actualizamos UI invisible
  } else {
    // Volvemos al primer plano
    if (S.playing && S.player) {
      // Esperamos 300ms a que el iframe WebKit esté "despierto"
      setTimeout(() => {
        const st = S.player.getPlayerState?.();
        // Si estaba sonando pero iOS lo pausó → lo reanudamos
        if (st === YT.PlayerState.PAUSED) {
          S.player.playVideo();
        }
        _startTicker();
        _syncPosition();
      }, 300);
    }
  }
});

/* ════════════════════════════════════════════════════════════
   7. BÚSQUEDA — YouTube Data API v3
════════════════════════════════════════════════════════════ */
async function search(query) {
  query = query.trim();
  if (!query) return;

  if (API_KEY === 'PEGA_TU_API_KEY_AQUI') {
    alert('⚠️ Abre script.js y reemplaza PEGA_TU_API_KEY_AQUI con tu clave de YouTube.');
    return;
  }

  _showSplash(false);
  _showLoader(true);
  D.trackList.innerHTML = '';

  const params = new URLSearchParams({
    part:            'snippet',
    q:               query + ' official audio',
    type:            'video',
    videoCategoryId: '10',   // Música
    maxResults:      MAX_RESULTS,
    key:             API_KEY,
    safeSearch:      'none',
  });

  try {
    const res  = await fetch(`${SEARCH_URL}?${params}`);
    const data = await res.json();

    if (data.error) throw new Error(data.error.message);

    S.queue = (data.items || []).map(item => ({
      id:        item.id.videoId,
      title:     _esc(item.snippet.title),
      channel:   _esc(item.snippet.channelTitle),
      thumbnail: item.snippet.thumbnails?.medium?.url
                 || item.snippet.thumbnails?.default?.url
                 || '',
    }));

    _renderList(S.queue, D.trackList, S.queue);

  } catch (err) {
    D.trackList.innerHTML = `
      <div class="splash">
        <div class="splash-icon">⚠️</div>
        <p class="splash-title">Error</p>
        <p class="splash-sub">${err.message}</p>
      </div>`;
  } finally {
    _showLoader(false);
  }
}

/* ════════════════════════════════════════════════════════════
   8. REPRODUCCIÓN
════════════════════════════════════════════════════════════ */
function playTrack(index, queue) {
  if (!S.ytReady) return;

  if (queue) S.queue = queue;

  S.idx = index;
  const t = S.queue[index];
  if (!t) return;

  // loadVideoById dispara autoplay; no llamamos playVideo() después
  S.player.loadVideoById(t.id);
  S.playing = true;

  _updatePlayerBar(t);
  _highlightCard(t.id);
  _setPlayIcon(true);
  // _syncMeta y _syncPosition se llaman en _onYTStateChange → PLAYING
  // para garantizar que getDuration() ya devuelve el valor real
}

function togglePlay() {
  if (!S.ytReady || S.idx < 0) return;
  S.playing ? S.player.pauseVideo() : S.player.playVideo();
}

function playNext() {
  if (!S.queue.length) return;
  playTrack((S.idx + 1) % S.queue.length);
}

function playPrev() {
  if (!S.queue.length) return;
  const t = S.player.getCurrentTime?.() ?? 0;
  if (t > 3) {
    // Menos de 3 s → reinicia; más → canción anterior
    S.player.seekTo(0, true);
    _syncPosition();
    return;
  }
  playTrack((S.idx - 1 + S.queue.length) % S.queue.length);
}

/* ════════════════════════════════════════════════════════════
   9. UI DEL PLAYER BAR
════════════════════════════════════════════════════════════ */
function _updatePlayerBar(t) {
  D.playerTitle.textContent  = t.title;
  D.playerArtist.textContent = t.channel;

  // Thumbnail
  D.playerThumb.innerHTML = '';
  if (t.thumbnail) {
    const img = document.createElement('img');
    img.src = t.thumbnail;
    img.alt = t.title;
    D.playerThumb.appendChild(img);
  }

  // Estado del corazón en el player
  _setHeartState(D.playerHeart, _isFav(t.id));
}

function _setPlayIcon(isPlaying) {
  D.icoPlay.classList.toggle('visually-hidden', isPlaying);
  D.icoPause.classList.toggle('visually-hidden', !isPlaying);
}

function _highlightCard(id) {
  document.querySelectorAll('.track-card').forEach(c => {
    c.classList.toggle('track-card--playing', c.dataset.id === id);
  });
}

/* ════════════════════════════════════════════════════════════
   10. BARRA DE PROGRESO
════════════════════════════════════════════════════════════ */
function _startTicker() {
  _stopTicker();
  S.ticker = setInterval(() => {
    // No actualizamos la UI si la app está en fondo
    if (document.hidden || !S.playing) return;
    _updateProgress();
  }, 500);
}

function _stopTicker() {
  clearInterval(S.ticker);
  S.ticker = null;
}

function _updateProgress() {
  if (!S.ytReady) return;
  const cur = S.player.getCurrentTime?.() ?? 0;
  const dur = S.player.getDuration?.()    ?? 0;

  D.progressFill.style.width = dur > 0 ? `${(cur / dur) * 100}%` : '0%';
  D.progressTrack.setAttribute('aria-valuenow', dur > 0 ? Math.round((cur / dur) * 100) : 0);
  D.timeCurrent.textContent  = _fmt(cur);
  D.timeDuration.textContent = _fmt(dur);
}

// Tap en la barra para buscar posición
D.progressTrack.addEventListener('click', e => {
  if (!S.ytReady || S.idx < 0) return;
  const r   = D.progressTrack.getBoundingClientRect();
  const pct = (e.clientX - r.left) / r.width;
  const dur = S.player.getDuration?.() ?? 0;
  S.player.seekTo(pct * dur, true);
  _syncPosition();
});

/* ════════════════════════════════════════════════════════════
   11. FAVORITOS — localStorage
════════════════════════════════════════════════════════════ */
function _loadFavs() {
  try { S.favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); }
  catch { S.favorites = []; }
}

function _saveFavs() {
  localStorage.setItem(FAV_KEY, JSON.stringify(S.favorites));
}

function _isFav(id) { return S.favorites.some(f => f.id === id); }

function _toggleFav(track) {
  const i = S.favorites.findIndex(f => f.id === track.id);
  i >= 0 ? S.favorites.splice(i, 1) : S.favorites.unshift(track);
  _saveFavs();

  // Actualiza todos los corazones de ese id en pantalla
  document.querySelectorAll(`.heart-btn[data-id="${track.id}"]`).forEach(b => {
    _setHeartState(b, _isFav(track.id));
  });
  // Actualiza el corazón del player bar
  if (S.queue[S.idx]?.id === track.id) {
    _setHeartState(D.playerHeart, _isFav(track.id));
  }

  // Si el panel de favoritos está visible, lo recargamos
  if (D.panelFavs.classList.contains('panel--active')) {
    _renderFavPanel();
  }
}

function _setHeartState(btn, on) {
  btn.classList.toggle('heart-btn--on', on);
  btn.setAttribute('aria-label', on ? 'Quitar de favoritos' : 'Añadir a favoritos');
  const path = btn.querySelector('path');
  if (path) {
    path.setAttribute('fill', on ? 'currentColor' : 'none');
  }
}

/* ════════════════════════════════════════════════════════════
   12. RENDERIZADO DE LISTAS
════════════════════════════════════════════════════════════ */
function _renderList(tracks, container, queueRef) {
  container.innerHTML = '';
  if (!tracks.length) return;

  const frag = document.createDocumentFragment();
  tracks.forEach(t => frag.appendChild(_makeCard(t, queueRef)));
  container.appendChild(frag);
}

function _makeCard(track, queueRef) {
  const isPlaying = S.queue[S.idx]?.id === track.id;
  const fav       = _isFav(track.id);

  const card = document.createElement('div');
  card.className = `track-card${isPlaying ? ' track-card--playing' : ''}`;
  card.dataset.id = track.id;

  card.innerHTML = `
    <div class="thumb-wrap">
      <img class="thumb-img" src="${track.thumbnail}" alt="" loading="lazy">
      <div class="thumb-overlay" aria-hidden="true">
        <div class="bars"><b></b><b></b><b></b></div>
      </div>
    </div>
    <div class="track-info">
      <p class="track-title">${track.title}</p>
      <p class="track-artist">${track.channel}</p>
    </div>
    <button class="heart-btn${fav ? ' heart-btn--on' : ''}"
            data-id="${track.id}"
            aria-label="${fav ? 'Quitar de favoritos' : 'Añadir a favoritos'}">
      <svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}"
           stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    </button>`;

  // Tap en la card → reproducir
  card.addEventListener('click', e => {
    if (e.target.closest('.heart-btn')) return;
    const q   = queueRef || S.queue;
    const idx = q.findIndex(t => t.id === track.id);
    playTrack(idx, q);
  });

  // Tap en el corazón → favorito
  card.querySelector('.heart-btn').addEventListener('click', e => {
    e.stopPropagation();
    _toggleFav(track);
  });

  return card;
}

function _renderFavPanel() {
  const count = S.favorites.length;
  D.favCount.textContent = `${count} ${count === 1 ? 'canción' : 'canciones'}`;

  if (count === 0) {
    D.favList.innerHTML = '';
    D.favEmpty.classList.remove('visually-hidden');
  } else {
    D.favEmpty.classList.add('visually-hidden');
    _renderList(S.favorites, D.favList, S.favorites);
  }
}

/* ════════════════════════════════════════════════════════════
   13. NAVEGACIÓN POR TABS
════════════════════════════════════════════════════════════ */
D.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;

    D.tabs.forEach(t => {
      const active = t.dataset.tab === target;
      t.classList.toggle('tab--active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    D.panelResults.classList.toggle('panel--active', target === 'results');
    D.panelFavs.classList.toggle('panel--active',    target === 'favorites');

    if (target === 'favorites') _renderFavPanel();
  });
});

/* ════════════════════════════════════════════════════════════
   14. EVENTOS DE CONTROLES
════════════════════════════════════════════════════════════ */
D.searchForm.addEventListener('submit', e => {
  e.preventDefault();
  const q = D.searchInput.value.trim();
  if (!q) return;

  // Cambiar al tab de resultados automáticamente
  D.tabs.forEach(t => {
    const on = t.dataset.tab === 'results';
    t.classList.toggle('tab--active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  D.panelResults.classList.add('panel--active');
  D.panelFavs.classList.remove('panel--active');

  search(q);
  D.searchInput.blur(); // Cierra el teclado virtual en iOS
});

D.btnPlay.addEventListener('click',  togglePlay);
D.btnNext.addEventListener('click',  playNext);
D.btnPrev.addEventListener('click',  playPrev);

D.playerHeart.addEventListener('click', () => {
  const t = S.queue[S.idx];
  if (t) _toggleFav(t);
});

/* ════════════════════════════════════════════════════════════
   15. HELPERS
════════════════════════════════════════════════════════════ */
function _showSplash(show) {
  D.splash.style.display = show ? 'flex' : 'none';
}

function _showLoader(show) {
  if (show) {
    D.loader.classList.remove('visually-hidden');
  } else {
    D.loader.classList.add('visually-hidden');
  }
}

// Formatea segundos → "m:ss"
function _fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

// Escapa HTML básico para datos de la API
function _esc(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════
   16. INIT
════════════════════════════════════════════════════════════ */
(function init() {
  _loadFavs();
  _showSplash(true);
  _showLoader(false);
})();
