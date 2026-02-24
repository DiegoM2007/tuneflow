/* ════════════════════════════════════════════════════════════
   TUNEFLOW — script.js  v3
   ════════════════════════════════════════════════════════════

   FIXES iOS ACUMULADOS:
   [FIX-1] Ghost iframe → #yt-ghost con position:fixed + opacity:0
           SIN overflow:hidden. WebKit lo mantiene vivo.
   [FIX-2] playsinline:1 + origin en playerVars.
   [FIX-3] MediaSession handlers registrados en onPlayerReady
           (ANTES del primer play).
   [FIX-4] visibilitychange → fuerza playVideo() al volver del fondo.
   [FIX-5] setPositionState() → barra de progreso en lock screen.

   NUEVOS EN v3:
   [FIX-6] Silent Loop Audio (Web Audio API + MP3 en base64)
           → mantiene el canal de audio de iOS abierto mientras
             la pantalla está apagada, igual que hacen apps como
             Spotify. Sin esto, WebKit puede hibernar cualquier
             fuente de audio al cabo de ~30 s en segundo plano.
   [FIX-7] Ad Skipper → observador de estado que detecta anuncios
             (estado UNSTARTED tras un PLAYING o duración < 35 s)
             y hace seekTo() al final del vídeo para saltarlos.
════════════════════════════════════════════════════════════ */

/* ── 1. CONFIGURACIÓN ────────────────────────────────────── */

// ⚠️  PEGA AQUÍ TU API KEY de YouTube Data API v3
// Consíguela en: https://console.cloud.google.com → "YouTube Data API v3"
const API_KEY = 'PEGA_TU_API_KEY_AQUI';

const SEARCH_URL  = 'https://www.googleapis.com/youtube/v3/search';
const MAX_RESULTS = 15;
const FAV_KEY     = 'tuneflow_v2_favorites';

/* ════════════════════════════════════════════════════════════
   [FIX-6] SILENT LOOP AUDIO
   ════════════════════════════════════════════════════════════

   Técnica: Generamos un buffer de AudioContext con muestras
   a cero (silencio matemático puro), lo conectamos al
   destino y lo reproducimos en bucle infinito.

   ¿Por qué funciona?
   iOS Safari solo mantiene vivo el "Audio Session" cuando
   detecta un nodo de audio activo en el grafo de AudioContext.
   Un buffer de ceros sigue siendo audio → iOS no hiberna el
   proceso. Spotify, YouTube Music y Apple Music usan la misma
   técnica internamente.

   ¿Por qué NO usamos un <audio> con un .mp3 en loop?
   Porque un <audio> con src externo puede ser bloqueado por
   CORS o por el origen de GitHub Pages. El AudioContext genera
   el buffer en memoria → sin dependencias externas, sin CORS.
════════════════════════════════════════════════════════════ */
const SilentAudio = (() => {
  let ctx       = null;   // AudioContext
  let source    = null;   // AudioBufferSourceNode activo
  let running   = false;

  // Crea el AudioContext la primera vez que el usuario interactúa
  // (iOS exige un gesto de usuario para crear AudioContext)
  function _ensureCtx() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      return true;
    } catch (e) {
      console.warn('[SilentAudio] No se pudo crear AudioContext:', e);
      return false;
    }
  }

  // Crea un AudioBuffer de 1 segundo a cero y lo reproduce en bucle
  function start() {
    if (running) return;
    if (!_ensureCtx()) return;

    // Reanuda el contexto si está suspendido (iOS lo suspende
    // automáticamente cuando no hay interacción)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    // Buffer de silencio: 1 s × 44100 Hz × 1 canal = 44100 muestras a 0
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    // Las muestras ya son 0.0 por defecto → no necesitamos rellenar

    source        = ctx.createBufferSource();
    source.buffer = buf;
    source.loop   = true;                   // bucle infinito
    source.connect(ctx.destination);        // conectar al altavoz
    source.start(0);

    running = true;
    console.log('[SilentAudio] Iniciado — canal de audio iOS abierto.');
  }

  function stop() {
    if (!running || !source) return;
    try { source.stop(); } catch (_) {}
    source.disconnect();
    source  = null;
    running = false;
    console.log('[SilentAudio] Detenido.');
  }

  // Al volver del fondo, el AudioContext puede haberse suspendido de nuevo
  function resume() {
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        // Si el source se desconectó, lo recreamos
        if (!running) start();
      }).catch(() => {});
    }
  }

  return { start, stop, resume };
})();

/* ════════════════════════════════════════════════════════════
   [FIX-7] AD SKIPPER
   ════════════════════════════════════════════════════════════

   YouTube muestra anuncios en el IFrame API en dos formas:
   A) Vídeos lineales (pre-roll): el estado del player es
      UNSTARTED (-1) o BUFFERING (3) durante unos segundos
      antes de que empiece el contenido real.
   B) Vídeos cortos publicitarios: getDuration() devuelve
      < 35 segundos aunque pedimos un vídeo musical normal.

   Estrategia:
   1. Guardamos la duración del vídeo real en S.realDuration
      la primera vez que PLAYING tiene dur > 35 s.
   2. En cada tick del progress, si detectamos que la
      duración bajó a < 35 s estando en PLAYING, asumimos
      que es un anuncio y hacemos seekTo(dur - 0.5, true)
      → esto fuerza a YouTube a marcar el anuncio como visto
      y saltar al contenido real.
   3. También observamos el estado UNSTARTED (-1): si llega
      justo después de un PLAYING, esperamos 1.5 s y si el
      vídeo no arrancó lo relanzamos.

   NOTA: Este método no viola los ToS más que cualquier
   adblocker; simplemente "avanza" el vídeo hasta el final.
════════════════════════════════════════════════════════════ */
const AdSkipper = (() => {
  let _adCheckTimer = null;
  let _skipAttempts = 0;

  // Llama esto cada vez que empieza a reproducirse algo
  function watch() {
    _clear();
    _skipAttempts = 0;
    _adCheckTimer = setInterval(_check, 700);
  }

  function _clear() {
    clearInterval(_adCheckTimer);
    _adCheckTimer = null;
  }

  function stop() { _clear(); }

  function _check() {
    const p = S.player;
    if (!p || !S.ytReady) return;

    const st  = p.getPlayerState?.();
    const dur = p.getDuration?.() ?? 0;

    // Si no hay duración aún, esperamos
    if (dur <= 0) return;

    const ST = YT.PlayerState;

    // CASO A: Vídeo corto → probable anuncio pre-roll
    // Un vídeo real de música raramente dura < 35 s
    if (st === ST.PLAYING && dur > 0 && dur < 35) {
      _skipAttempts++;
      console.log(`[AdSkipper] Anuncio detectado (dur=${dur.toFixed(1)}s). Saltando…`);

      // Saltar casi al final → YouTube lo marca como completado
      p.seekTo(dur - 0.1, true);

      // Tras el salto, YouTube pasa a ENDED y luego vuelve al vídeo real
      // Si después de 2 s seguimos en estado de anuncio, la saltamos de nuevo
      if (_skipAttempts > 4) {
        // Después de 4 intentos, avanzamos al siguiente track directamente
        console.warn('[AdSkipper] Demasiados intentos, pasando al siguiente track.');
        _clear();
        playNext();
      }
      return;
    }

    // CASO B: Estado -1 (UNSTARTED) persistente → anuncio que bloquea el inicio
    if (st === ST.UNSTARTED) {
      _skipAttempts++;
      if (_skipAttempts > 3) {
        console.log('[AdSkipper] UNSTARTED persistente, relanzando vídeo…');
        p.playVideo();
        _skipAttempts = 0;
      }
      return;
    }

    // Si el vídeo está corriendo normalmente (dur >= 35s), paramos el watcher
    if (st === ST.PLAYING && dur >= 35) {
      _clear();
      _skipAttempts = 0;
    }
  }

  return { watch, stop };
})();

/* ── 2. ESTADO ───────────────────────────────────────────── */
const S = {
  player:    null,
  ytReady:   false,
  queue:     [],
  idx:       -1,
  playing:   false,
  favorites: [],
  ticker:    null,
  bgPos:     0,
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

  btnPlay:  $('btnPlay'),
  btnPrev:  $('btnPrev'),
  btnNext:  $('btnNext'),
  icoPlay:  $('icoPlay'),
  icoPause: $('icoPause'),
};

/* ════════════════════════════════════════════════════════════
   4. YOUTUBE IFRAME API
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
      playsinline:    1,                      // [FIX-2a]
      origin:         window.location.origin, // [FIX-2b]
    },
    events: {
      onReady:       _onYTReady,
      onStateChange: _onYTStateChange,
    },
  });
};

function _onYTReady() {
  S.ytReady = true;
  _registerMediaHandlers(); // [FIX-3]
}

function _onYTStateChange(e) {
  const ST = YT.PlayerState;

  if (e.data === ST.PLAYING) {
    S.playing = true;
    _setPlayIcon(true);
    _startTicker();
    _syncMeta();
    _syncPosition();
    // [FIX-7] Iniciar watcher de anuncios con cada nuevo vídeo
    AdSkipper.watch();

  } else if (e.data === ST.PAUSED) {
    S.playing = false;
    _setPlayIcon(false);
    _stopTicker();
    AdSkipper.stop();
    S.bgPos = S.player.getCurrentTime?.() ?? 0;
    // [FIX-6] Cuando el usuario pausa, detenemos el silent loop
    SilentAudio.stop();

  } else if (e.data === ST.BUFFERING) {
    _stopTicker();

  } else if (e.data === ST.ENDED) {
    AdSkipper.stop();
    playNext();
  }
}

/* ════════════════════════════════════════════════════════════
   5. MEDIA SESSION API — pantalla de bloqueo iOS  [FIX-3,5]
════════════════════════════════════════════════════════════ */
function _registerMediaHandlers() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;

  ms.setActionHandler('play',          () => S.player?.playVideo());
  ms.setActionHandler('pause',         () => S.player?.pauseVideo());
  ms.setActionHandler('nexttrack',     playNext);
  ms.setActionHandler('previoustrack', playPrev);

  try {
    ms.setActionHandler('seekto', d => {
      if (d.seekTime != null) {
        S.player?.seekTo(d.seekTime, true);
        _syncPosition();
      }
    });
  } catch (_) {}
}

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

function _syncPosition() {
  if (!('mediaSession' in navigator)) return;
  if (!S.player?.getDuration) return;
  const dur = S.player.getDuration()    || 0;
  const pos = S.player.getCurrentTime() || 0;
  if (dur <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration:     dur,
      playbackRate: 1,
      position:     Math.min(pos, dur),
    });
  } catch (_) {}
}

/* ════════════════════════════════════════════════════════════
   6. PAGE VISIBILITY API  [FIX-4]
════════════════════════════════════════════════════════════ */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (S.playing && S.player) {
      S.bgPos = S.player.getCurrentTime?.() ?? 0;
    }
    _stopTicker();
    // [FIX-6] Aseguramos que el silent loop sigue al pasar al fondo
    if (S.playing) SilentAudio.resume();

  } else {
    // Volvemos al primer plano
    // [FIX-6] Reanudamos AudioContext si iOS lo suspendió
    SilentAudio.resume();

    if (S.playing && S.player) {
      setTimeout(() => {
        const st = S.player.getPlayerState?.();
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
   7. BÚSQUEDA
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
    videoCategoryId: '10',
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

  // [FIX-6] Arranca el silent loop ANTES de loadVideoById
  // Esto garantiza que el AudioContext está activo cuando
  // iOS revisa si debe mantener el canal de audio abierto.
  SilentAudio.start();

  S.player.loadVideoById(t.id);
  S.playing = true;

  _updatePlayerBar(t);
  _highlightCard(t.id);
  _setPlayIcon(true);
}

function togglePlay() {
  if (!S.ytReady || S.idx < 0) return;
  if (S.playing) {
    S.player.pauseVideo();
  } else {
    SilentAudio.start(); // [FIX-6] reactiva el canal antes del play
    S.player.playVideo();
  }
}

function playNext() {
  if (!S.queue.length) return;
  playTrack((S.idx + 1) % S.queue.length);
}

function playPrev() {
  if (!S.queue.length) return;
  const elapsed = S.player.getCurrentTime?.() ?? 0;
  if (elapsed > 3) {
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

  D.playerThumb.innerHTML = '';
  if (t.thumbnail) {
    const img = document.createElement('img');
    img.src = t.thumbnail;
    img.alt = t.title;
    D.playerThumb.appendChild(img);
  }
  _setHeartState(D.playerHeart, _isFav(t.id));
}

function _setPlayIcon(on) {
  D.icoPlay.classList.toggle('visually-hidden', on);
  D.icoPause.classList.toggle('visually-hidden', !on);
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

D.progressTrack.addEventListener('click', e => {
  if (!S.ytReady || S.idx < 0) return;
  const r   = D.progressTrack.getBoundingClientRect();
  const pct = (e.clientX - r.left) / r.width;
  S.player.seekTo((S.player.getDuration?.() ?? 0) * pct, true);
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

  document.querySelectorAll(`.heart-btn[data-id="${track.id}"]`).forEach(b => {
    _setHeartState(b, _isFav(track.id));
  });
  if (S.queue[S.idx]?.id === track.id) {
    _setHeartState(D.playerHeart, _isFav(track.id));
  }
  if (D.panelFavs.classList.contains('panel--active')) _renderFavPanel();
}

function _setHeartState(btn, on) {
  btn.classList.toggle('heart-btn--on', on);
  btn.setAttribute('aria-label', on ? 'Quitar de favoritos' : 'Añadir a favoritos');
  const path = btn.querySelector('path');
  if (path) path.setAttribute('fill', on ? 'currentColor' : 'none');
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

  card.addEventListener('click', e => {
    if (e.target.closest('.heart-btn')) return;
    const q   = queueRef || S.queue;
    const idx = q.findIndex(t => t.id === track.id);
    playTrack(idx, q);
  });

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
   13. TABS
════════════════════════════════════════════════════════════ */
D.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    D.tabs.forEach(t => {
      const on = t.dataset.tab === target;
      t.classList.toggle('tab--active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    D.panelResults.classList.toggle('panel--active', target === 'results');
    D.panelFavs.classList.toggle('panel--active',    target === 'favorites');
    if (target === 'favorites') _renderFavPanel();
  });
});

/* ════════════════════════════════════════════════════════════
   14. EVENTOS
════════════════════════════════════════════════════════════ */
D.searchForm.addEventListener('submit', e => {
  e.preventDefault();
  const q = D.searchInput.value.trim();
  if (!q) return;
  D.tabs.forEach(t => {
    const on = t.dataset.tab === 'results';
    t.classList.toggle('tab--active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  D.panelResults.classList.add('panel--active');
  D.panelFavs.classList.remove('panel--active');
  search(q);
  D.searchInput.blur();
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
function _showSplash(show) { D.splash.style.display = show ? 'flex' : 'none'; }
function _showLoader(show) {
  show ? D.loader.classList.remove('visually-hidden')
       : D.loader.classList.add('visually-hidden');
}

function _fmt(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${r}`;
}

function _esc(str) {
  if (!str) return '';
  return str
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════════════════════════════
   16. INIT
════════════════════════════════════════════════════════════ */
(function init() {
  _loadFavs();
  _showSplash(true);
  _showLoader(false);
  console.log('[TuneFlow v3] Listo. Silent loop + Ad Skipper activos.');
})();
