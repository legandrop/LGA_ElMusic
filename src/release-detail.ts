// Disco desplegado arriba de un panel propio (New releases o el panel de un sello). Un clic en una tapa o en el título de
// la lista lo abre en el mismo panel, sin ir a otra página; otro clic lo reemplaza, y el alto pasa de uno al otro con una
// transición corta. Mientras suena un disco de la lista, el desplegado sigue al disco que suena.
// Los datos salen del catálogo con el MusicKit que configuró la página (GET /v1/catalog/{país}/albums/{id}, sólo lectura,
// un disco de la lista mostrada) y se guardan en memoria (hasta 30 discos). Play, Shuffle y el ▶ de cada tema piden la
// cola a main por el canal de sellos (album-queue.ts); acá no se toca el reproductor.
// Se dibuja sólo con textContent; las portadas se aceptan únicamente de is*-ssl.mzstatic.com por HTTPS.
export const releaseDetailLimits = { cache: 30, tracks: 300, artists: 12 } as const;

// actions: play(id, modo, siguientes, tema), mark(botón, {title, artist, song}), link(a, url, título), following(id).
export const releaseDetailFunctionScript = String.raw`const releaseDetail = (panel, country, actions) => {
  const box = document.createElement('section'); box.className = 'el-music-release'; box.hidden = true; box.setAttribute('aria-label', 'Release');
  const cache = new Map(); let current = '', seq = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const art = (url, size) => {
    const value = String(url || '').replace('{w}x{h}', size + 'x' + size).replace(/\/\d{2,4}x\d{2,4}(bb|sr|bf)?\.(jpg|png)$/, '/' + size + 'x' + size + 'bb.$2');
    try { const parsed = new URL(value); return parsed.protocol === 'https:' && /^is\d-ssl\.mzstatic\.com$/.test(parsed.hostname) && !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash ? parsed.href : ''; }
    catch { return ''; }
  };
  const kindOf = (name, single) => / - Single$/i.test(name) || single ? 'Single' : / - EP$/i.test(name) ? 'EP' : 'Album';
  const bare = name => name.replace(/ - (?:Single|EP)$/i, '');
  const time = ms => { const seconds = Math.round(ms / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
  const longDate = value => {
    if (/^\d{4}$/.test(value)) return value;
    const date = new Date(value + (value.length === 7 ? '-01' : '') + 'T00:00:00');
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-US', value.length === 7 ? { year: 'numeric', month: 'long' } : { year: 'numeric', month: 'long', day: 'numeric' });
  };
  const length = ms => { const minutes = Math.round(ms / 60000); return minutes >= 60 ? Math.floor(minutes / 60) + ' hr ' + (minutes % 60) + ' min' : minutes + (minutes === 1 ? ' minute' : ' minutes'); };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const icon = (path, filled) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.dataset.filled = String(filled);
    const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.appendChild(shape); return svg;
  };
  const playPath = 'M8 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L8.9 5.1a.6.6 0 0 0-.9.5Z';
  const shufflePath = 'M16 4h4v4M4 19 20 4M20 16v4h-4M14.5 14.5 20 20M4 5l5.5 5.5';
  // Disco del catálogo: nombre, artistas (con su ID para el enlace), fecha, género, sello, ℗ y temas. Sólo lectura.
  const load = async id => {
    if (cache.has(id)) return cache.get(id);
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    if (typeof music?.api?.music !== 'function') throw new Error('UNAVAILABLE');
    // Tope de 15 s: si el catálogo no contesta, el desplegado pasa a su estado de error (con «Try again») en vez de
    // quedarse en «Loading songs…».
    let timer;
    const response = await Promise.race([music.api.music('/v1/catalog/' + country + '/albums/' + id, { include: 'artists' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), 15000); })]).finally(() => clearTimeout(timer));
    const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
    if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) throw new Error('STATUS');
    const data = Array.isArray(response?.data?.data) ? response.data.data[0] : undefined;
    if (!data || String(data.id) !== id) throw new Error('MISSING');
    const about = data.attributes || {};
    const artists = (Array.isArray(data.relationships?.artists?.data) ? data.relationships.artists.data : []).slice(0, ${releaseDetailLimits.artists})
      .map(item => ({ id: String(item?.id ?? ''), name: clean(item?.attributes?.name).slice(0, 240) })).filter(item => /^\d{1,20}$/.test(item.id) && item.name);
    const tracks = (Array.isArray(data.relationships?.tracks?.data) ? data.relationships.tracks.data : []).slice(0, ${releaseDetailLimits.tracks}).map(item => {
      const track = item?.attributes || {};
      return { id: String(item?.id ?? ''), name: clean(track.name).slice(0, 240), artist: clean(track.artistName).slice(0, 240), number: Number(track.trackNumber) || 0,
        disc: Number(track.discNumber) || 1, ms: Number(track.durationInMillis) || 0, explicit: track.contentRating === 'explicit', playable: item?.type === 'songs' && !!track.playParams };
    }).filter(track => /^\d{1,20}$/.test(track.id) && track.name);
    const genre = (Array.isArray(about.genreNames) ? about.genreNames.map(String).find(name => !/^(?:music|música|musica|musique|musik)$/i.test(name)) : '') || '';
    const detail = { id, name: clean(about.name).slice(0, 240), artist: clean(about.artistName).slice(0, 240), artists,
      released: /^\d{4}(?:-\d{2}){0,2}$/.test(String(about.releaseDate || '')) ? String(about.releaseDate) : '', genre: clean(genre).slice(0, 80),
      label: clean(about.recordLabel).slice(0, 240), copyright: clean(about.copyright).slice(0, 300), artwork: art(about.artwork?.url, 600),
      single: about.isSingle === true, explicit: about.contentRating === 'explicit', tracks };
    cache.set(id, detail); if (cache.size > ${releaseDetailLimits.cache}) cache.delete(cache.keys().next().value);
    return detail;
  };
  // Crédito del disco con un enlace por artista; lo demás («&», «,», «feat.») queda como texto.
  const artistLine = detail => {
    const line = el('p', 'el-music-release__artist');
    let rest = detail.artist;
    if (!detail.artists.length) { line.textContent = rest; return line; }
    while (rest) {
      let at = -1, who;
      for (const artist of detail.artists) {
        const found = rest.indexOf(artist.name);
        if (found >= 0 && (at < 0 || found < at || (found === at && artist.name.length > who.name.length))) { at = found; who = artist; }
      }
      if (at < 0) { line.append(rest); break; }
      if (at) line.append(rest.slice(0, at));
      const link = el('a', 'el-music-release__artist-link', who.name);
      actions.link(link, 'https://music.apple.com/' + country + '/artist/' + who.id, who.name);
      line.append(link); rest = rest.slice(at + who.name.length);
    }
    return line;
  };
  const playTrack = (button, album, track) => {
    if (!button || button.disabled) return;
    actions.mark(button, { title: album.title, artist: album.artist, song: track.name });
    actions.play(album.id, 'in-order', actions.following(album.id), track.id);
  };
  const render = (album, detail, state) => {
    const before = box.hidden ? 0 : box.getBoundingClientRect().height;
    box.hidden = false; box.dataset.id = album.id;
    box.dataset.title = detail?.name || album.title; box.dataset.artist = detail?.artist || album.artist;
    const close = el('button', 'el-music-release__close'); close.type = 'button'; close.title = 'Close'; close.setAttribute('aria-label', 'Close ' + (detail?.name || album.title));
    close.append(icon('M6 6l12 12M18 6 6 18', false)); close.addEventListener('click', () => hide());
    const cover = el('div', 'el-music-release__cover');
    const source = detail?.artwork || art(album.artworkUrl, 600);
    if (source) { const image = el('img'); image.alt = ''; image.decoding = 'async'; image.src = source; cover.append(image); }
    const name = detail?.name || album.title;
    const title = el('h2', 'el-music-release__title', bare(name));
    if (detail?.explicit) title.append(el('span', 'el-music-release__explicit', 'E'));
    const meta = el('p', 'el-music-release__meta', [kindOf(name, detail?.single), detail?.genre || album.genre, (detail?.released || album.released || '').slice(0, 4)].filter(Boolean).join(' · '));
    const buttons = el('div', 'el-music-release__actions');
    const playable = !!detail && detail.tracks.some(track => track.playable);
    for (const [mode, label, path, filled] of [['in-order', 'Play', playPath, true], ['shuffle', 'Shuffle', shufflePath, false]]) {
      const button = el('button', 'el-music-release__' + (mode === 'shuffle' ? 'shuffle' : 'play')); button.type = 'button';
      button.append(icon(path, filled), el('span', '', label)); button.setAttribute('aria-label', label + ' ' + bare(name));
      button.disabled = !!detail && !playable;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        actions.mark(button, { title: album.title, artist: album.artist });
        actions.play(album.id, mode, actions.following(album.id));
      });
      buttons.append(button);
    }
    const info = el('div', 'el-music-release__info');
    info.append(title, detail ? artistLine(detail) : el('p', 'el-music-release__artist', album.artist), meta, buttons);
    const head = el('div', 'el-music-release__head'); head.append(cover, info);
    const body = el('div', 'el-music-release__body');
    if (!detail) {
      const status = el('p', 'el-music-release__status'); status.setAttribute('role', 'status');
      if (state === 'error') {
        status.append('The songs could not be loaded. ');
        const retry = el('button', 'el-music-release__retry', 'Try again'); retry.type = 'button';
        retry.addEventListener('click', () => show(album, { force: true, via: 3 })); status.append(retry);
      } else status.append(el('span', 'el-music-release__ring'), 'Loading songs…');
      body.append(status);
    } else {
      const discs = new Set(detail.tracks.map(track => track.disc)).size > 1;
      const list = el('ol', 'el-music-release__tracks'); let disc = 0;
      for (const track of detail.tracks) {
        if (discs && track.disc !== disc) { disc = track.disc; list.append(el('li', 'el-music-release__disc', 'Disc ' + disc)); }
        const row = el('li', 'el-music-release__track'); row.dataset.id = track.id; row.dataset.title = track.name;
        const index = el('span', 'el-music-release__index'); index.append(el('span', 'el-music-release__number', track.number ? String(track.number) : ''));
        let button;
        if (track.playable) {
          button = el('button', 'el-music-release__track-play'); button.type = 'button'; button.title = 'Play'; button.setAttribute('aria-label', 'Play ' + track.name);
          button.append(icon(playPath, true)); button.addEventListener('click', event => { event.stopPropagation(); playTrack(button, album, track); });
          index.append(button);
          row.addEventListener('dblclick', event => { if (!(event.target instanceof Element) || !event.target.closest('a')) playTrack(button, album, track); });
        } else { row.classList.add('is-unavailable'); row.title = 'Not available'; }
        const song = el('span', 'el-music-release__song'), songName = el('span', 'el-music-release__song-name', track.name);
        if (track.explicit) songName.append(el('span', 'el-music-release__explicit', 'E'));
        song.append(songName);
        if (track.artist && track.artist !== detail.artist) song.append(el('span', 'el-music-release__song-artist', track.artist));
        row.append(index, song, el('span', 'el-music-release__duration', track.ms ? time(track.ms) : ''));
        list.append(row);
      }
      const foot = el('div', 'el-music-release__foot');
      if (detail.released) foot.append(el('p', '', longDate(detail.released)));
      const total = detail.tracks.reduce((sum, track) => sum + track.ms, 0);
      foot.append(el('p', '', detail.tracks.length + (detail.tracks.length === 1 ? ' song' : ' songs') + (total ? ', ' + length(total) : '')));
      if (detail.copyright || detail.label) foot.append(el('p', '', detail.copyright || detail.label));
      body.append(list, foot);
    }
    box.replaceChildren(close, el('div', 'el-music-release__inner'));
    box.lastChild.append(head, body);
    // Alto: de lo que había a lo nuevo, con una transición corta (sin ella si el sistema pide menos movimiento).
    const after = box.getBoundingClientRect().height;
    box.getAnimations().forEach(animation => animation.cancel());
    if (!reduced() && Math.abs(after - before) > 1) box.animate([{ height: before + 'px' }, { height: after + 'px' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
    // El shell marca el tema que suena (y el disco) cada vez que se dibuja una lista de discos.
    dispatchEvent(new CustomEvent('el-music:releases-rendered'));
  };
  // via (log release-detail): 0 clic en la tapa o el título, 1 Play en una tapa, 2 siguió al disco que suena, 3 reintento.
  const show = async (album, options = {}) => {
    if (!album || !/^\d{1,20}$/.test(String(album.id)) || !panel.isConnected) return;
    const mine = ++seq, started = performance.now(), via = options.via ?? 0;
    // Al principio del panel: el título del panel queda a la vista, con el disco justo debajo.
    const reveal = () => { if (options.scroll) panel.scrollTo({ top: 0, behavior: reduced() ? 'instant' : 'smooth' }); };
    if (current === album.id && !box.hidden && (box.dataset.loaded === album.id || box.dataset.loading === album.id) && !options.force) { reveal(); return; }
    current = album.id;
    const cached = cache.get(album.id);
    if (cached) { render(album, cached); box.dataset.loaded = album.id; reveal(); pageLog('release-detail', { temas: cached.tracks.length, ms: 0, cache: 1, via }); return; }
    delete box.dataset.loaded; render(album, undefined, 'loading'); reveal(); box.dataset.loading = album.id;
    try {
      const detail = await load(album.id);
      if (mine !== seq || !panel.isConnected) return;
      delete box.dataset.loading; render(album, detail); box.dataset.loaded = album.id;
      pageLog('release-detail', { temas: detail.tracks.length, ms: Math.round(performance.now() - started), cache: 0, via });
    } catch {
      if (mine !== seq || !panel.isConnected) return;
      delete box.dataset.loading; render(album, undefined, 'error'); pageLog('release-detail', { temas: -1, ms: Math.round(performance.now() - started), cache: 0, via });
    }
  };
  const hide = () => {
    seq++; current = ''; delete box.dataset.loaded; delete box.dataset.loading;
    const before = box.getBoundingClientRect().height;
    const done = () => { if (current) return; box.hidden = true; box.replaceChildren(); delete box.dataset.id; delete box.dataset.title; delete box.dataset.artist; };
    box.getAnimations().forEach(animation => animation.cancel());
    if (reduced() || !before) { done(); return; }
    box.animate([{ height: before + 'px', opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 200, easing: 'ease-in' }).finished.then(done, done);
  };
  return { box, show, hide, current: () => box.hidden ? '' : current };
};`;
