import type { WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { isMusicPage } from './music-shell';
import { musicLinkFunctionScript } from './music-navigation';
import { findLabelByName, isMbid, labelAlbumIds, labelBaseName, labelFamily, PublicMetadataError } from './labels';
import type { LabelRelease } from './labels';
import { itunesCooldownMs, lookupAppleAlbums, searchAppleAlbums } from './recommendations';
import type { AppleAlbum, AppleAlbumMatch } from './recommendations';
import { pickSearchedAlbum, primaryArtist, releasedPattern } from './album-match';
import type { KnownLabelAlbums } from './playlist-labels';
import { pageLogFunctionScript } from './page-log';
import { albumQueueLimits, installAlbumQueue } from './album-queue';
import type { AlbumQueue, AlbumQueueMode } from './album-queue';
import { releaseDetailFunctionScript } from './release-detail';

// Música de un sello desde la columna Label (reemplaza el botón Record labels de la barra).
// La página sólo puede pedir claves que main publicó para esa columna (allowlist); main resuelve el sello, pide sus discos
// a MusicBrainz y confirma de una vez en Lookup cuáles están en la región. Sin cuenta, tokens ni IPC privilegiado.
// Orden del panel: primero los álbumes que la columna ya
// sabe que son de ese sello, después todos los discos de MusicBrainz con enlace a Apple y, para los que no lo tienen,
// una búsqueda en iTunes por artista principal + título.
export type LabelLink = { kind: 'mb'; id: string; name: string } | { kind: 'apple'; url: string; name: string } | { kind: 'name'; name: string };
const links = new Map<string, LabelLink>();
const keyPattern = /^(?:m[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|a\d{1,20}|p[a-f\d]{20})$/;
export const labelBrowserLimits = { links: 3000, pages: 10, albums: 600, searches: 150, local: 200 } as const;
export function labelLinkKey(link: LabelLink): string | undefined {
  let key: string;
  if (link.kind === 'mb') { if (!isMbid(link.id)) return; key = 'm' + link.id; }
  else if (link.kind === 'apple') {
    const match = link.url.match(/^https:\/\/music\.apple\.com\/[a-z]{2}\/label\/(?:[^/?#]+\/)?(\d{1,20})\/?$/);
    if (!match) return; key = 'a' + match[1];
  } else {
    const name = link.name.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 120) return;
    key = 'p' + createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 20);
  }
  if (!links.has(key) && links.size >= labelBrowserLimits.links) links.delete(links.keys().next().value!);
  links.set(key, { ...link, name: link.name.replace(/\s+/g, ' ').trim().slice(0, 120) });
  return key;
}
export type LabelRequest = { action: 'close' } | { action: 'more' } | { action: 'open'; link: LabelLink } | { action: 'play'; id: string; mode: AlbumQueueMode; following: string[]; start?: string } | { action: 'new-releases' };
// following: IDs de los discos que siguen al elegido en la lista tal como se ve (campo aparte del pedido, hasta 299).
const followingPattern = new RegExp(`^\\d{1,20}(?:,\\d{1,20}){0,${albumQueueLimits.albums - 2}}$`);
export function parseLabelRequest(value: unknown, following?: unknown): LabelRequest | undefined {
  if (value === 'close' || value === 'more' || value === 'new-releases') return { action: value };
  // Reproducir un disco de la lista: play/ID/p (en orden) o play/ID/s (los temas de cada disco mezclados); la cola sigue
  // por los discos siguientes de la lista mostrada. Main comprueba cada ID contra la lista que esta sesión mostró.
  // play/ID/p/TEMA: desde ese tema del disco desplegado, en orden (main comprueba que el tema sea del disco).
  if (typeof value === 'string' && /^play\/\d{1,20}\/(?:[ps]|p\/\d{1,20})$/.test(value)) {
    const [id, mode, start] = value.slice(5).split('/');
    return { action: 'play', id, mode: mode === 's' ? 'shuffle' : 'in-order', following: typeof following === 'string' && followingPattern.test(following) ? following.split(',') : [],
      ...(start ? { start } : {}) };
  }
  if (typeof value !== 'string' || !value.startsWith('open/')) return;
  const key = value.slice(5), link = keyPattern.test(key) ? links.get(key) : undefined;
  return link ? { action: 'open', link } : undefined;
}

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
const wakeMessage = 'elMusic.labels.request-ready';
// Línea de carga (0.1.55): la página la enciende con el clic en un sello o en New releases; se apaga al mostrarse el panel o
// si el pedido termina sin navegar. Si el pedido navegó, la navegación ya la tomó y este aviso no la toca.
// Cada pedido lleva su dueño (label:N): el final de un pedido viejo no apaga la línea de uno nuevo.
const busyOwner = /^label:[1-9]\d{0,8}$/;
export function endLabelBusyScript(owner: string): string {
  if (!busyOwner.test(owner)) throw new Error('INVALID_BUSY_OWNER');
  return `(() => { ${guard} dispatchEvent(new CustomEvent('el-music:busy', { detail: { op: 'end', owner: ${JSON.stringify(owner)} } })); return true; })()`;
}
// Lee y consume el pedido; el país sale de la URL o, en la biblioteca, de los enlaces públicos de la barra lateral.
const takeRequestScript = `(() => {
  ${guard}
  const root = document.documentElement, request = root.dataset.elMusicLabelRequest, busy = root.dataset.elMusicLabelBusy, following = root.dataset.elMusicLabelFollowing;
  delete root.dataset.elMusicLabelRequest; delete root.dataset.elMusicLabelBusy; delete root.dataset.elMusicLabelFollowing;
  const storefront = [...document.querySelectorAll('.navigation a[href]')].map(link => link.getAttribute('href') || '')
    .map(href => href.match(/^(?:https:\\/\\/music\\.apple\\.com)?\\/([a-z]{2})\\/(?:home|new|radio|search|browse)(?:[\\/?#]|$)/)?.[1]).find(Boolean);
  const parked = !!document.querySelector('#el-music-label-panel.el-music-panel--parked');
  return { parked, request: typeof request === 'string' && request.length < 192 ? request : null, busy: typeof busy === 'string' && busy.length < 24 ? busy : null,
    following: typeof following === 'string' && following.length < ${albumQueueLimits.albums * 21} ? following : null, country: location.pathname.match(/^\\/([a-z]{2})(?:\\/|$)/)?.[1] || storefront || null };
})()`;
// Página oficial del sello en Apple Music: una búsqueda de sólo lectura en el catálogo
// con la API pública del MusicKit que configuró la página (record-labels, hasta 5). Sólo vuelven IDs numéricos y nombres;
// sin tokens, cuenta ni escritura.
export function appleLabelSearchScript(name: string, country: string): string {
  if (!/^[a-z]{2}$/.test(country)) throw new Error('INVALID_COUNTRY');
  return `(async () => {
    ${guard}
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    if (typeof music?.api?.music !== 'function') return null;
    const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/search`)}, { term: ${JSON.stringify(name.slice(0, 120))}, types: 'record-labels', limit: 5 });
    if (Number(response?.status) >= 400 || Array.isArray(response?.data?.errors)) return null;
    const found = response?.data?.results?.['record-labels']?.data;
    return Array.isArray(found) ? found.slice(0, 5).map(label => ({ id: String(label?.id), name: String(label?.attributes?.name ?? '').slice(0, 240) })) : [];
  })()`;
}
// Elige el sello de Apple cuyo nombre base coincide («Ninja Tune» = «Ninja Tune Ltd»); si no hay uno así, ninguno.
export function pickAppleLabel(value: unknown, name: string): string | undefined {
  if (!Array.isArray(value)) return;
  const wanted = labelBaseName(name);
  const match = value.slice(0, 5).find(item => item && /^\d{1,20}$/.test(String(item.id)) && typeof item.name === 'string' && !!wanted && labelBaseName(item.name) === wanted);
  return match ? String(match.id) : undefined;
}
// Pedido de Play de un disco desde nuestras listas (tabla o tarjeta): el modo va en el pedido y los discos que le siguen en
// la lista tal como se ve, en un campo aparte; la cola la arma main (album-queue.ts).
const albumPlayRequestFunctionScript = `const requestAlbumPlay = (id, mode, following, start) => {
  const fromTrack = mode !== 'shuffle' && typeof start === 'string' && start.length <= 20 && [...start].every(digit => digit >= '0' && digit <= '9') && start.length > 0;
  pageLog('label-play', { siguientes: following.length, modo: mode === 'shuffle' ? 1 : 0, tema: fromTrack ? 1 : 0 });
  const root = document.documentElement;
  root.dataset.elMusicLabelFollowing = following.slice(0, ${albumQueueLimits.albums - 1}).join(',');
  root.dataset.elMusicLabelRequest = 'play/' + id + '/' + (mode === 'shuffle' ? 's' : 'p') + (fromTrack ? '/' + start : '');
  console.debug(${JSON.stringify(wakeMessage)});
};`;
// Aviso inmediato de un Play pedido desde nuestras listas: el botón gira y el LCD muestra el disco pedido hasta que el
// reproductor reacciona. source: de qué lista salió, para volver desde la canción del LCD.
const pendingAlbumPlayFunctionScript = `const markAlbumPlay = (button, album) => {
  button.disabled = true; button.classList.add('el-music-pending');
  const done = () => { button.classList.remove('el-music-pending'); button.disabled = false; removeEventListener('el-music:pending-play-done', done); };
  addEventListener('el-music:pending-play-done', done); setTimeout(done, 16000);
  const panel = button.closest('#el-music-label-panel');
  dispatchEvent(new CustomEvent('el-music:pending-play', { detail: { artist: album.artist, album: album.title, song: album.song || '', source: panel ? panel.dataset.kind || 'label-panel' : 'page' } }));
};`;
// Cierra el aviso inmediato del LCD cuando el play no se despachó (ocupado, no disponible o falló).
const pendingPlayFailedScript = `(() => { ${guard} dispatchEvent(new CustomEvent('el-music:pending-play', { detail: null })); return true; })()`;
function navigateScript(url: string): string {
  return `(() => { ${guard}
    history.pushState(null, '', ${JSON.stringify(url)}); dispatchEvent(new PopStateEvent('popstate', { state: null })); return true; })()`;
}

// Lista completa de discos, como una playlist: título, artista, fecha y género, ordenable
// por clic en el encabezado (asc/desc; fecha descendente al abrir). El orden vive en la página (dataset del contenedor):
// main sólo manda los discos y la página los vuelve a dibujar sin más pedidos.
// ▶ al pasar el mouse sobre la fila: reemplaza el número y pide a main reproducir ese disco y los de abajo.
// select: en un panel propio, el título despliega el disco arriba del panel en vez de abrir su página.
export const releasesTableFunctionScript = `${pendingAlbumPlayFunctionScript}
const renderReleases = (host, albums, afterNavigation, play, select) => {
  const columns = [['title', 'Album'], ['artist', 'Artist'], ['released', 'Released'], ['genre', 'Genre']];
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  let table = host.querySelector('table');
  if (!table) {
    table = document.createElement('table'); table.className = 'el-music-releases';
    const head = document.createElement('thead'), row = document.createElement('tr');
    const index = document.createElement('th'); index.textContent = '#'; index.scope = 'col'; row.appendChild(index);
    for (const [key, label] of columns) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.dataset.key = key; cell.textContent = label; cell.title = 'Sort by ' + label.toLowerCase();
      cell.addEventListener('click', () => {
        const [current, direction] = (host.dataset.sort || 'released:desc').split(':');
        host.dataset.sort = current === key ? key + ':' + (direction === 'asc' ? 'desc' : 'asc') : key + ':' + (key === 'released' ? 'desc' : 'asc');
        pageLog('label-table-sort', { filas: host[Symbol.for('el-music.releases')]?.length || 0 });
        renderReleases(host, host[Symbol.for('el-music.releases')] || [], afterNavigation, play, select);
      });
      row.appendChild(cell);
    }
    head.appendChild(row); table.append(head, document.createElement('tbody')); host.appendChild(table);
  }
  host[Symbol.for('el-music.releases')] = albums;
  const [key, direction] = (host.dataset.sort || 'released:desc').split(':');
  for (const cell of table.querySelectorAll('th[data-key]')) cell.dataset.direction = cell.dataset.key === key ? direction : '';
  const sorted = [...albums].sort((a, b) => {
    const left = a[key] || '', right = b[key] || '';
    if (!left !== !right) return left ? -1 : 1;
    return (collator.compare(left, right) || collator.compare(a.title, b.title)) * (direction === 'desc' ? -1 : 1);
  });
  const body = document.createElement('tbody');
  sorted.forEach((album, position) => {
    const row = document.createElement('tr'); row.dataset.id = album.id;
    const index = document.createElement('td'); index.className = 'el-music-releases-index';
    const number = document.createElement('span'); number.textContent = String(position + 1); index.appendChild(number);
    if (play) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'el-music-releases-play';
      button.title = 'Play ' + album.title; button.setAttribute('aria-label', 'Play ' + album.title);
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        markAlbumPlay(button, album);
        // La cola sigue por los discos de abajo, en el orden en que se ve la tabla.
        play(album.id, 'in-order', sorted.slice(position + 1).map(other => other.id));
      });
      index.appendChild(button);
    }
    row.appendChild(index);
    for (const [column] of columns) {
      const cell = document.createElement('td'); cell.dataset.key = column;
      if (column === 'title') {
        const link = document.createElement('a'); link.textContent = album.title;
        if (select) {
          link.href = album.url; link.dataset.elMusicInline = 'true';
          link.addEventListener('click', event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); select(album); });
        } else musicLink(link, album.url, album.title, afterNavigation);
        cell.appendChild(link);
      }
      else cell.textContent = album[column] || (column === 'released' || column === 'genre' ? '—' : '');
      row.appendChild(cell);
    }
    body.appendChild(row);
  });
  table.tBodies[0].replaceWith(body);
  // Se registra sólo cuando cambia la cantidad: el panel se vuelve a dibujar con cada tramo que llega.
  if (host.dataset.elMusicLogged !== String(albums.length)) { host.dataset.elMusicLogged = String(albums.length); pageLog('label-table', { filas: albums.length }); }
  // El shell marca la fila del disco que suena (▶ rojo) cada vez que la tabla se redibuja.
  dispatchEvent(new CustomEvent('el-music:releases-rendered'));
  return sorted.length;
};`;

// note: texto propio bajo el título (el panel de novedades lo usa); sin él va el de un sello.
// progress: fracción 0–1 de una carga larga o 'indeterminate' antes de conocer el total; sin él, sólo el anillo.
export interface PanelState { epoch: string; open: boolean; name: string; country: string; albums: AppleAlbum[]; busy: boolean; more: boolean; message: string; note?: string; progress?: number | 'indeterminate' }
export function labelPanelScript(state: PanelState): string {
  return `(() => {
    ${guard}
    const state = ${JSON.stringify(state)};
    let panel = document.getElementById('el-music-label-panel');
    // Los listeners de window de cada panel se cuelgan de su AbortController: se retiran junto con el panel.
    const listenersKey = Symbol.for('el-music.panel-listeners');
    const dropPanel = node => { node?.[listenersKey]?.abort(); node?.remove(); };
    if (!state.open) { dropPanel(panel); return true; }
    ${musicLinkFunctionScript}
    ${pageLogFunctionScript}
    ${releasesTableFunctionScript}
    ${albumPlayRequestFunctionScript}
    ${releaseDetailFunctionScript}
    const request = value => { document.documentElement.dataset.elMusicLabelRequest = value; console.debug(${JSON.stringify(wakeMessage)}); };
    const detailKey = Symbol.for('el-music.release-detail'), albumsKey = Symbol.for('el-music.panel-albums');
    if (!panel || panel.dataset.epoch !== state.epoch) {
      dropPanel(panel); panel = document.createElement('section'); panel.id = 'el-music-label-panel'; panel.dataset.epoch = state.epoch;
      panel[listenersKey] = new AbortController();
      panel.setAttribute('aria-label', 'Record label releases');
      // Entrada del historial sobre la que se abrió: el shell esconde el panel al salir de ella y lo muestra al volver.
      panel.dataset.entryKey = globalThis.navigation?.currentEntry?.key || '';
      // Cierre sin botón a la vista (Back ya vuelve a donde se estaba): lo usan Back propio, Alt+Left, la barra lateral y el shell.
      const close = document.createElement('button'); close.type = 'button'; close.hidden = true; close.tabIndex = -1; close.setAttribute('aria-hidden', 'true');
      close.textContent = 'Close'; close.dataset.closeLabels = 'true';
      close.addEventListener('click', () => { dropPanel(panel); request('close'); });
      const heading = document.createElement('h1'); heading.tabIndex = -1;
      const note = document.createElement('p'); note.className = 'el-music-label-note';
      const grid = document.createElement('ul'); grid.className = 'el-music-label-grid';
      // Disco desplegado arriba de la grilla (release-detail.ts): la cola sigue por las tarjetas de la derecha y de abajo.
      const detail = releaseDetail(panel, state.country, { play: requestAlbumPlay, mark: markAlbumPlay, link: (link, url, title) => musicLink(link, url, title),
        following: id => { const order = [...grid.children].map(child => child.dataset.id), index = order.indexOf(id); return index < 0 ? [] : order.slice(index + 1); } });
      panel[detailKey] = detail;
      // Mientras suena un disco de la lista, el desplegado pasa a ese disco; sólo si está abierto (cerrarlo es decisión del usuario).
      addEventListener('el-music:playing-release', event => {
        if (!panel.isConnected) return;
        const id = event.detail?.id, album = (panel[albumsKey] || []).find(item => item.id === id);
        if (album && detail.current() && detail.current() !== id) detail.show(album, { via: 2 });
      }, { signal: panel[listenersKey].signal });
      // Estado: anillo mientras se busca, el texto y, en cargas largas, una barra de progreso.
      const status = document.createElement('p'); status.className = 'el-music-label-status'; status.setAttribute('role', 'status');
      const ring = document.createElement('span'); ring.className = 'el-music-label-ring'; ring.setAttribute('aria-hidden', 'true');
      const statusText = document.createElement('span'); statusText.className = 'el-music-label-status-text';
      const bar = document.createElement('span'); bar.className = 'el-music-label-progress'; bar.setAttribute('aria-hidden', 'true'); bar.appendChild(document.createElement('span'));
      status.append(ring, statusText, bar);
      const more = document.createElement('button'); more.type = 'button'; more.className = 'el-music-label-more'; more.textContent = 'Load more';
      more.addEventListener('click', () => { more.disabled = true; request('more'); });
      const listTitle = document.createElement('h2'); listTitle.textContent = 'All releases';
      const list = document.createElement('div'); list.className = 'el-music-releases-host';
      panel.append(close, heading, note, detail.box, grid, status, more, listTitle, list); document.body.appendChild(panel); heading.focus();
    }
    const part = selector => panel.querySelector(':scope > ' + selector);
    const heading = part('h1'), note = part('.el-music-label-note'), grid = part('.el-music-label-grid'), status = part('.el-music-label-status'),
      more = part('.el-music-label-more'), listTitle = part('h2'), list = part('.el-music-releases-host'), detail = panel[detailKey];
    panel[albumsKey] = state.albums;
    panel.dataset.kind = state.note ? 'new-releases' : 'label-panel';
    // En New releases el estado va arriba de la lista (la carga es larga y la lista crece), debajo del disco desplegado; en un
    // sello, al pie, junto a «Load more».
    const anchor = panel.dataset.kind === 'new-releases' ? detail.box : grid;
    if (status.previousElementSibling !== anchor) anchor.after(status);
    listTitle.hidden = list.hidden = !state.albums.length;
    // La tabla se redibuja sólo si cambió la lista: el progreso no rehace las filas (ni corta un ▶ que está esperando).
    const ids = state.albums.map(album => album.id).join(',');
    if (list.dataset.ids !== ids) {
      list.dataset.ids = ids;
      renderReleases(list, state.albums, undefined, requestAlbumPlay, album => detail.show(album, { scroll: true, via: 0 }));
    }
    heading.textContent = state.name;
    note.textContent = state.note || ('Releases available in Apple Music ' + state.country.toUpperCase() + ' · Sources: your library, MusicBrainz and iTunes · May be incomplete');
    // Los discos llegan por tramos y main los ordena por fecha: los ya dibujados se mueven a su lugar y los que ya no están
    // en la lista (una lista vieja reemplazada por la nueva) se quitan.
    const shown = new Map([...grid.children].map(item => [item.dataset.id, item]));
    const wanted = new Set(state.albums.map(album => album.id));
    for (const [id, item] of shown) if (!wanted.has(id)) { item.remove(); shown.delete(id); }
    // Play y Shuffle sobre la tapa (al pasar el mouse o con foco): el disco y después los de la derecha y abajo, en el orden
    // en que se ven las tarjetas. Shuffle mezcla los temas de cada disco, no los discos entre sí.
    const glyph = (button, path, filled) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.dataset.filled = String(filled);
      svg.appendChild(shape); button.appendChild(svg);
    };
    for (const album of state.albums) {
      if (shown.has(album.id)) { grid.appendChild(shown.get(album.id)); continue; }
      const item = document.createElement('li'); item.dataset.id = album.id; item.dataset.title = album.title; item.dataset.artist = album.artist;
      // La tapa y el título despliegan el disco arriba del panel, sin ir a otra página.
      const link = document.createElement('a'); link.href = album.url; link.dataset.elMusicInline = 'true';
      link.addEventListener('click', event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); detail.show(album, { scroll: true, via: 0 }); });
      const art = document.createElement('span'); art.className = 'el-music-label-art';
      if (album.artworkUrl) { const image = document.createElement('img'); image.alt = ''; image.loading = 'lazy'; image.src = album.artworkUrl.replace('/100x100bb.', '/300x300bb.'); art.appendChild(image); }
      const title = document.createElement('strong'); title.textContent = album.title;
      const artist = document.createElement('span'); artist.textContent = album.artist + (album.released ? ' · ' + album.released.slice(0, 4) : '');
      link.append(art, title, artist);
      const actions = document.createElement('div'); actions.className = 'el-music-card-actions';
      for (const [mode, label, path, filled] of [['in-order', 'Play', 'M8 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L8.9 5.1a.6.6 0 0 0-.9.5Z', true],
        ['shuffle', 'Shuffle', 'M16 4h4v4M4 19 20 4M20 16v4h-4M14.5 14.5 20 20M4 5l5.5 5.5', false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'el-music-card-' + (mode === 'shuffle' ? 'shuffle' : 'play');
        button.title = label; button.setAttribute('aria-label', label + ' ' + album.title); glyph(button, path, filled);
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (button.disabled) return;
          markAlbumPlay(button, album);
          const order = [...grid.children].map(child => child.dataset.id), index = order.indexOf(album.id);
          requestAlbumPlay(album.id, mode, index < 0 ? [] : order.slice(index + 1));
          detail.show(album, { via: 1 });
        });
        actions.appendChild(button);
      }
      item.append(link, actions); grid.appendChild(item);
    }
    dispatchEvent(new CustomEvent('el-music:releases-rendered'));
    const [ring, statusText, bar] = status.children;
    statusText.textContent = state.busy ? state.message || 'Finding releases…' : state.message;
    status.hidden = !statusText.textContent; ring.hidden = !state.busy;
    bar.hidden = !state.busy || state.progress === undefined;
    bar.classList.toggle('el-music-label-progress--indeterminate', state.progress === 'indeterminate');
    bar.firstChild.style.width = typeof state.progress === 'number' ? Math.round(Math.max(0.02, Math.min(1, state.progress)) * 1000) / 10 + '%' : '';
    panel.setAttribute('aria-busy', state.busy ? 'true' : 'false');
    more.hidden = !state.more || state.busy; more.disabled = false; more.textContent = state.message ? 'Try again' : 'Load more';
    return true;
  })()`;
}

// Página oficial de un sello en Apple: año en cada tarjeta de «Top releases» y, al pie, la
// lista completa de discos. Los datos salen de la vista pública latest-releases del catálogo (100 por página, hasta 10
// páginas) con el MusicKit de la página; también top-releases para tener antes los años de las tarjetas. Sólo lectura.
export const labelPageLimits = { pageSize: 100, pages: 10 } as const;
export interface LabelPageRef { country: string; id: string; name: string }
export const takeLabelPageScript = `(() => { ${guard}
  const match = location.pathname.match(/^\\/([a-z]{2})\\/label\\/(?:[^/]+\\/)?(\\d{1,20})\\/?$/);
  if (!match || !document.querySelector('.content-container')) return null;
  const heading = [...document.querySelectorAll('.content-container h1')].map(element => element.textContent.replace(/\\s+/g, ' ').trim()).find(Boolean) || '';
  return { country: match[1], id: match[2], name: heading.slice(0, 120) };
})()`;
export function labelPageRef(value: unknown): LabelPageRef | undefined {
  if (!value || typeof value !== 'object') return;
  const { country, id, name } = value as Record<string, unknown>;
  if (typeof country !== 'string' || !/^[a-z]{2}$/.test(country) || typeof id !== 'string' || !/^\d{1,20}$/.test(id) || typeof name !== 'string') return;
  return { country, id, name: name.replace(/\s+/g, ' ').trim().slice(0, 120) };
}
export function labelReleasesScript(country: string, id: string, view: 'latest-releases' | 'top-releases', offset: number): string {
  if (!/^[a-z]{2}$/.test(country) || !/^\d{1,20}$/.test(id) || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('INVALID_LABEL_PAGE');
  return `(async () => {
    ${guard}
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    if (typeof music?.api?.music !== 'function') return null;
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/record-labels/${id}/view/${view}`)}, { limit: ${labelPageLimits.pageSize}, offset: ${offset} });
      const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
      if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) return { error: Number.isInteger(code) && code >= 400 ? code : refusal };
      const data = response?.data?.data;
      return Array.isArray(data) ? data.slice(0, ${labelPageLimits.pageSize}).map(album => ({ id: String(album?.id), name: String(album?.attributes?.name ?? '').slice(0, 240),
        artist: String(album?.attributes?.artistName ?? '').slice(0, 240), released: String(album?.attributes?.releaseDate ?? ''),
        genre: (Array.isArray(album?.attributes?.genreNames) ? album.attributes.genreNames.map(String).find(name => !/^(?:music|música|musica|musique|musik)$/i.test(name)) : '') || '',
        artwork: String(album?.attributes?.artwork?.url ?? '') })) : [];
    } catch (error) { const status = Number(error?.status ?? error?.response?.status ?? error?.errorCode); return { error: Number.isInteger(status) ? status : 0 }; }
  })()`;
}
// Sólo álbumes con ID numérico, título y artista; la URL se arma con el país de la página y la portada se valida.
export function labelReleases(value: unknown, country: string): AppleAlbum[] {
  if (!Array.isArray(value) || !/^[a-z]{2}$/.test(country)) return [];
  const albums: AppleAlbum[] = [];
  for (const item of value.slice(0, labelPageLimits.pageSize) as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id), title = typeof item.name === 'string' ? item.name.trim().slice(0, 240) : '', artist = typeof item.artist === 'string' ? item.artist.trim().slice(0, 240) : '';
    if (!/^\d{1,20}$/.test(id) || !title || !artist) continue;
    const released = typeof item.released === 'string' && releasedPattern.test(item.released) ? item.released : undefined;
    const genre = typeof item.genre === 'string' ? item.genre.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    let artworkUrl: string | undefined;
    if (typeof item.artwork === 'string' && item.artwork.length <= 2048) {
      try {
        const url = new URL(item.artwork.replace('{w}x{h}', '300x300'));
        if (url.protocol === 'https:' && url.hostname === 'is1-ssl.mzstatic.com' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
          /^\/image\/thumb\/[A-Za-z\d]{1,40}\/v4\/(?:[a-f\d]{2}\/){3}[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/[A-Za-z\d._-]{1,240}\.(?:jpg|png)\/300x300(?:bb|sr|bf)?\.(?:jpg|png)$/.test(url.pathname)) artworkUrl = url.href;
      } catch { /* portada inválida: sin imagen */ }
    }
    albums.push({ id, title, artist, url: `https://music.apple.com/${country}/album/${id}`, ...(artworkUrl ? { artworkUrl } : {}), ...(released ? { released } : {}), ...(genre ? { genre } : {}) });
  }
  return albums;
}
export interface LabelPageState { epoch: string; open: boolean; id: string; country: string; albums: AppleAlbum[]; busy: boolean; message: string }
export function labelPageScript(state: LabelPageState): string {
  return `(() => {
    ${guard}
    const state = ${JSON.stringify(state)};
    const root = document.documentElement, container = document.querySelector('.content-container');
    let section = document.getElementById('el-music-label-releases');
    const onPage = new RegExp('^/[a-z]{2}/label/(?:[^/]+/)?' + state.id + '/?$').test(location.pathname);
    if (!state.open || !container || !onPage) { section?.remove(); delete root[Symbol.for('el-music.label-years')]; return true; }
    ${musicLinkFunctionScript}
    ${pageLogFunctionScript}
    ${releasesTableFunctionScript}
    ${albumPlayRequestFunctionScript}
    if (!section || section.dataset.epoch !== state.epoch) {
      section?.remove(); section = document.createElement('section'); section.id = 'el-music-label-releases'; section.dataset.epoch = state.epoch;
      section.setAttribute('aria-label', 'All releases of this label');
      const heading = document.createElement('h2'); heading.textContent = 'All releases';
      const note = document.createElement('p'); note.className = 'el-music-label-note'; note.textContent = 'From the Apple Music catalog · Click a column to sort';
      const status = document.createElement('p'); status.className = 'el-music-label-status'; status.setAttribute('role', 'status');
      const host = document.createElement('div'); host.className = 'el-music-releases-host';
      section.append(heading, note, status, host); container.appendChild(section);
    }
    const [, , status, host] = section.children;
    status.textContent = state.busy ? 'Loading releases… ' + state.albums.length + ' so far' : state.message || (state.albums.length + ' releases');
    renderReleases(host, state.albums, undefined, requestAlbumPlay);
    // Años de las tarjetas: la lista va a un mapa propio y music-shell.js la aplica (también cuando Apple vuelve a dibujar).
    root[Symbol.for('el-music.label-years')] = new Map(state.albums.filter(album => album.released).map(album => [album.id, album.released.slice(0, 4)]));
    document.dispatchEvent(new Event('el-music-label-years'));
    return true;
  })()`;
}

// Estado de la carga del panel: familia de MusicBrainz con su cursor, discos sin enlace pendientes de buscar en iTunes y
// álbumes que la columna ya conoce. Cada tramo avanza recién cuando terminó bien: «Try again» retoma desde ahí.
interface LabelLoad { ids: string[]; index: number; offset: number; local: string[]; named: LabelRelease[]; pending: LabelRelease[]; queued: Set<string>;
  checked: number; found: number; identified: boolean; failedIdentify: boolean }
const various = /^(?:various artists|varios artistas|artistas varios)$/i;
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
// Error pasajero: red, tiempo agotado, 429 o 5xx de MusicBrainz o iTunes, o la espera de iTunes tras un 429.
export function transientLabelError(error: unknown): boolean {
  if (error instanceof PublicMetadataError) return error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && (error.status === 429 || (error.status ?? 0) >= 500));
  return error instanceof Error && error.message === 'RECOMMENDATION_RATE_LIMITED';
}
// Código numérico para el log: estado HTTP, 1 red, 2 tiempo agotado, 3 espera de iTunes, 0 otro.
function errorCode(error: unknown): number {
  if (error instanceof PublicMetadataError) return error.kind === 'http' ? error.status ?? 0 : error.kind === 'network' ? 1 : error.kind === 'timeout' ? 2 : 0;
  return error instanceof Error && error.message === 'RECOMMENDATION_RATE_LIMITED' ? 3 : 0;
}
// Hasta dos reintentos ante un error pasajero, a los 2 y 4 s. Si iTunes pidió esperar tras un 429, se espera eso (hasta
// 60 s): reintentar antes fallaría sin llegar a la red.
async function retry<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await task(); }
    catch (error) {
      if (signal.aborted || !transientLabelError(error) || attempt >= 2) throw error;
      const cooldown = error instanceof Error && error.message === 'RECOMMENDATION_RATE_LIMITED' ? Math.min(itunesCooldownMs() + 250, 60000) : 0;
      await pause(Math.max(2000 * 2 ** attempt, cooldown), signal);
    }
  }
}

export interface NewReleasesView { albums: AppleAlbum[]; artists: number; fromCache: boolean; checkedAt: number }
export interface NewReleasesStep { read: number; total?: number; artists: number; checked: number; libraryDone: boolean; albums: AppleAlbum[] }
export type NewReleasesLoader = (country: string, signal: AbortSignal, hooks: { onProgress: (step: NewReleasesStep) => void; onStale: (cached: NewReleasesView) => void }) => Promise<NewReleasesView>;
// Texto y fracción del progreso de New releases (la biblioteca y el catálogo avanzan a la vez): antes de saber el total,
// sólo «Reading your library…»; después, artistas consultados sobre el total y los discos hallados.
// Con el total de Apple, las entradas sin ID de catálogo cuentan como hechas al leerlas (no hay nada que consultar): el
// número de la derecha no cambia y el avance llega justo al total.
export function newReleasesProgress(step: NewReleasesStep | undefined): { message: string; progress: number | 'indeterminate' } {
  const count = (value: number): string => value.toLocaleString('en-US');
  if (!step || (!step.artists && !step.libraryDone)) return { message: 'Reading your library…', progress: 'indeterminate' };
  const found = step.albums.length ? ' · ' + count(step.albums.length) + (step.albums.length === 1 ? ' new release' : ' new releases') + ' so far' : '';
  if (step.total) {
    const done = Math.min(step.total, step.checked + Math.max(0, Math.min(step.read, step.total) - step.artists));
    return { message: 'Checking ' + count(done) + ' of ' + count(step.total) + ' artists in your library…' + found, progress: done / step.total };
  }
  if (step.libraryDone && step.artists) return { message: 'Checking ' + count(Math.min(step.checked, step.artists)) + ' of ' + count(step.artists) + ' artists in your library…' + found,
    progress: Math.min(1, step.checked / step.artists) };
  return { message: count(step.checked) + ' artists in your library checked…' + found, progress: 'indeterminate' };
}
const clock = (time: number, now = Date.now()): string => {
  const date = new Date(time), hours = date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
  return new Date(now).toDateString() === date.toDateString() ? hours : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + hours;
};
export function installLabelBrowser(contents: WebContents, onFailure: () => void, log: (event: string, fields?: Record<string, boolean | number>) => void,
  albumsOfLabel: (name: string) => KnownLabelAlbums = () => ({ ids: [], named: [] }), newReleases?: NewReleasesLoader,
  queue: AlbumQueue = installAlbumQueue(contents, log)): void {
  let state: PanelState = { epoch: randomUUID(), open: false, name: '', country: 'us', albums: [], busy: false, more: false, message: '' };
  let label: LabelLoad | undefined; let last: { link: LabelLink; country: string } | undefined;
  const appleLabels = new Map<string, string | null>();
  let controller = new AbortController(); let stopped = false; let polling = false; let pendingWake = false;
  const live = (): boolean => !stopped && !contents.isDestroyed() && isMusicPage(contents.getURL());
  // Dueño de la línea de carga del pedido que se está sirviendo (la página la encendió con el clic).
  let servingBusy: string | undefined;
  const endBusy = async (owner: string | undefined): Promise<void> => { if (owner && busyOwner.test(owner) && live()) await contents.mainFrame.executeJavaScript(endLabelBusyScript(owner)).catch(() => undefined); };
  const render = async (): Promise<void> => {
    if (live()) await contents.mainFrame.executeJavaScript(labelPanelScript(state)).catch(onFailure);
    if (state.open) await endBusy(servingBusy);
  };
  // Último panel de un sello ya cargado: al volver a él (Back desde un disco del panel) se reabre con sus discos, sin repetir
  // la búsqueda, durante 30 minutos. New releases no lo necesita: tiene su propia caché del día.
  let lastLabelPanel: { key: string; at: number; state: PanelState; load: LabelLoad } | undefined;
  const panelKey = (link: LabelLink, country: string): string => country + '/' + link.kind + ':' + (link.kind === 'mb' ? link.id : link.kind === 'apple' ? link.url : link.name.toLowerCase());
  const close = async (): Promise<void> => {
    controller.abort(); controller = new AbortController();
    // Sólo un panel que terminó bien: uno con error o a medio cargar se vuelve a pedir entero («Try again» identifica de nuevo).
    if (state.open && !state.note && !state.busy && !state.message && label && !label.failedIdentify && last && state.albums.length)
      lastLabelPanel = { key: panelKey(last.link, last.country), at: Date.now(), state: { ...state }, load: label };
    label = undefined;
    if (state.open) { state = { ...state, open: false, albums: [], busy: false, more: false }; await render(); }
  };
  // Disco sin ID: artista principal + título en iTunes y, para recopilatorios, sólo el título. La misma elección que la
  // columna, con el ID como «sello» para que dos ediciones del mismo recopilatorio queden ambiguas.
  const findRelease = async (release: LabelRelease, country: string, signal: AbortSignal): Promise<AppleAlbum | undefined> => {
    const pick = (found: AppleAlbumMatch[]): AppleAlbumMatch | undefined => {
      const match = pickSearchedAlbum(found.map(item => ({ id: item.id, name: item.name, artist: item.artist, label: item.id, copyright: '' })), release.artist, release.title);
      return match && found.find(item => item.id === match.id);
    };
    let match = pick(await searchAppleAlbums(primaryArtist(release.artist) + ' ' + release.title, country, signal, 10, false));
    if (!match && various.test(release.artist.trim()) && !signal.aborted) match = pick(await searchAppleAlbums(release.title, country, signal, 25, false));
    return match ? { id: match.id, title: match.name, artist: match.artist, url: `https://music.apple.com/${country}/album/${match.id}`,
      ...(match.artworkUrl ? { artworkUrl: match.artworkUrl } : {}), ...(match.released ? { released: match.released } : {}), ...(match.genre ? { genre: match.genre } : {}) } : undefined;
  };
  // Tramos, y cada uno se muestra apenas llega, ordenado por fecha: (1) álbumes que la columna ya sabe que son de este sello,
  // entre ellos el disco desde el que se abrió (por ID y, los guardados sólo por nombre, buscados en iTunes); (2) discos de
  // MusicBrainz con enlace a Apple, confirmados en la región con Lookup; (3) discos sin enlace, buscados en iTunes. Topes por
  // pedido: 10 páginas de MusicBrainz y 150 búsquedas.
  const load = async (): Promise<void> => {
    if (!label || state.busy) return;
    if (label.failedIdentify && last) { void open(last.link, last.country); return; }
    const owner = controller, epoch = state.epoch, current = label, country = state.country, started = Date.now();
    const stale = (): boolean => owner.signal.aborted || state.epoch !== epoch;
    let stage = 1, pages = 0, searches = 0;
    state.busy = true; state.message = ''; await render();
    const add = async (albums: AppleAlbum[]): Promise<void> => {
      const known = new Set(state.albums.map(album => album.id));
      state.albums = [...state.albums, ...albums.filter(album => !known.has(album.id))]
        .sort((a, b) => (b.released || '').localeCompare(a.released || '')).slice(0, labelBrowserLimits.albums);
      await render();
    };
    const full = (): boolean => state.albums.length >= labelBrowserLimits.albums;
    // Busca el primero de la lista; un error no pasajero con un disco puntual lo saltea en lugar de cortar todo.
    const search = async (list: LabelRelease[]): Promise<void> => {
      state.message = `Finding releases… ${current.checked} of ${current.checked + current.named.length + current.pending.length} checked`; await render();
      let album: AppleAlbum | undefined;
      try { album = await retry(() => findRelease(list[0], country, owner.signal), owner.signal); }
      catch (error) { if (stale() || transientLabelError(error)) throw error; log('Sellos: disco salteado', { código: errorCode(error) }); }
      if (stale()) return;
      list.shift(); current.checked++; searches++;
      if (album) { current.found++; await add([album]); }
    };
    try {
      if (current.local.length) {
        const albums = await retry(() => lookupAppleAlbums(current.local, country, owner.signal), owner.signal);
        if (stale()) return;
        current.local = []; await add(albums);
      }
      while (current.named.length && searches < labelBrowserLimits.searches && !full()) { if (stale()) return; await search(current.named); }
      stage = 2;
      while (current.index < current.ids.length && pages < labelBrowserLimits.pages && !full()) {
        const result = await retry(() => labelAlbumIds(current.ids[current.index], current.offset, owner.signal), owner.signal);
        if (stale()) return;
        const known = new Set(state.albums.map(album => album.id)), fresh = result.ids.filter(id => !known.has(id));
        stage = 3;
        const albums = fresh.length ? await retry(() => lookupAppleAlbums(fresh, country, owner.signal), owner.signal) : [];
        if (stale()) return;
        stage = 2; pages++;
        if (result.more) current.offset = result.nextOffset; else { current.index++; current.offset = 0; }
        for (const release of result.unlinked) {
          const key = (release.artist + '\u0001' + release.title).normalize('NFKC').toLowerCase();
          if (!current.queued.has(key)) { current.queued.add(key); current.pending.push(release); }
        }
        await add(albums);
      }
      stage = 4;
      while (current.pending.length && searches < labelBrowserLimits.searches && !full()) { if (stale()) return; await search(current.pending); }
      if (stale()) return;
      state.more = !full() && (current.index < current.ids.length || current.named.length > 0 || current.pending.length > 0);
      state.message = state.albums.length ? '' : current.identified ? 'No releases of this label were found in Apple Music.' :
        'This label could not be identified in MusicBrainz. The ℗ line may name a distributor or the artist.';
      log('Sellos: discos del sello', { álbumes: state.albums.length, buscadosItunes: current.checked, encontradosItunes: current.found,
        pendientes: current.named.length + current.pending.length, ms: Date.now() - started });
    } catch (error) {
      if (stale()) return;
      state.message = 'Releases could not be loaded. Try again.'; state.more = true;
      log('Sellos: error al cargar discos', { etapa: stage, código: errorCode(error) }); onFailure();
    } finally {
      if (!stale()) { state.busy = false; await render(); }
    }
  };
  // Novedades de los artistas de la biblioteca: el mismo panel, con los discos de las últimas cuatro
  // semanas y el ▶ de la lista; el recorrido vive en new-releases.ts.
  const openNewReleases = async (country: string): Promise<void> => {
    await close();
    if (!newReleases) return;
    // Controlador propio: con dos clics seguidos, el segundo cancela la búsqueda del primero.
    controller.abort(); controller = new AbortController();
    const owner = controller, epoch = randomUUID();
    const stale = (): boolean => owner.signal.aborted || state.epoch !== epoch;
    const about = (artists?: number): string => 'Albums, EPs and singles from the last 4 weeks by ' + (artists ? artists.toLocaleString('en-US') + ' artists' : 'the artists') + ' in your library · From the Apple Music catalog';
    state = { epoch, open: true, name: 'New releases', country, albums: [], busy: true, more: false, note: about(), ...newReleasesProgress(undefined) };
    await render();
    // El progreso llega con cada página de la biblioteca y cada lote del catálogo: se dibuja como mucho cada 400 ms (y
    // siempre el último), de a un dibujo por vez. Con una lista vieja a la vista, los discos nuevos esperan al final.
    let last: NewReleasesStep | undefined, showingStale = false, drawing = false, timer: NodeJS.Timeout | undefined, lastDraw = 0;
    const draw = async (): Promise<void> => {
      timer = undefined;
      if (stale() || !state.busy) return;
      if (drawing) { timer = setTimeout(() => void draw(), 120); return; }
      drawing = true; lastDraw = Date.now();
      // Con la lista vieja a la vista no se cuentan los discos nuevos: el número no coincidiría con los que se ven.
      const view = newReleasesProgress(showingStale && last ? { ...last, albums: [] } : last);
      state.message = showingStale ? 'Updating… ' + view.message : view.message; state.progress = view.progress;
      if (!showingStale && last) state.albums = last.albums;
      try { await render(); } finally { drawing = false; }
    };
    const schedule = (): void => { if (!timer) timer = setTimeout(() => void draw(), Math.max(0, 400 - (Date.now() - lastDraw))); };
    try {
      const result = await newReleases(country, owner.signal, {
        onProgress: step => { if (!stale()) { last = step; schedule(); } },
        onStale: cached => {
          if (stale() || !cached.albums.length) return;
          showingStale = true; state.albums = cached.albums;
          state.note = about(cached.artists) + ' · Checked ' + clock(cached.checkedAt); schedule();
        }
      });
      clearTimeout(timer); timer = undefined;
      if (stale()) return;
      state.albums = result.albums;
      state.note = about(result.artists) + ' · Checked ' + clock(result.checkedAt);
      state.message = result.albums.length ? '' : 'No new releases from your library artists in the last 4 weeks.';
    } catch (error) {
      clearTimeout(timer); timer = undefined;
      if (stale()) return;
      const stage = error instanceof Error && 'stage' in error ? Number((error as { stage: unknown }).stage) : 0, status = error instanceof Error && 'status' in error ? Number((error as { status: unknown }).status) : 0;
      state.message = stage === 1 ? 'Your library could not be read. Make sure you are signed in to Apple Music.' : 'New releases could not be loaded. Try again later.';
      if (showingStale) state.message += ' Showing the list from the last check.';
      log('Novedades: error', { etapa: stage, código: status }); onFailure();
    } finally {
      if (!stale()) {
        while (drawing) await new Promise(resolve => setTimeout(resolve, 30));
        if (!stale()) { state.busy = false; delete state.progress; await render(); }
      }
    }
  };
  const open = async (link: LabelLink, country: string): Promise<void> => {
    await close();
    if (link.kind === 'apple') { await contents.mainFrame.executeJavaScript(navigateScript(link.url)).catch(onFailure); return; }
    const saved = lastLabelPanel;
    if (saved && saved.key === panelKey(link, country) && Date.now() - saved.at < 30 * 60 * 1000) {
      last = { link, country }; label = saved.load; state = { ...saved.state, epoch: randomUUID(), open: true, busy: false };
      log('Sellos: panel reabierto con sus discos', { álbumes: state.albums.length, segundos: Math.round((Date.now() - saved.at) / 1000) });
      await render(); return;
    }
    last = { link, country };
    // Primero la página oficial de Apple: un pedido de lectura al catálogo; el resultado (también «no está») queda en caché.
    const cacheKey = country + '/' + labelBaseName(link.name);
    let appleId = appleLabels.get(cacheKey);
    if (appleId === undefined) {
      const owner = controller;
      let timer: NodeJS.Timeout | undefined;
      try {
        // Tope de 8 s: si el catálogo no contesta, se sigue con MusicBrainz sin guardar nada en caché.
        const found: unknown = await Promise.race([
          contents.mainFrame.executeJavaScript(appleLabelSearchScript(link.name, country)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('APPLE_LABEL_TIMEOUT')), 8000); })
        ]);
        appleId = pickAppleLabel(found, link.name) ?? null;
        // Sólo una respuesta real del catálogo (lista) acredita «no tiene página»; null es guarda o MusicKit no listo.
        if (Array.isArray(found)) {
          if (appleLabels.size >= 200) appleLabels.delete(appleLabels.keys().next().value!);
          appleLabels.set(cacheKey, appleId);
        }
      } catch { appleId = null; /* Sin catálogo: queda MusicBrainz. */ }
      finally { clearTimeout(timer); }
      if (owner.signal.aborted) return;
    }
    if (appleId) {
      log('Sellos: página de Apple abierta', { porNombre: link.kind === 'name' });
      await contents.mainFrame.executeJavaScript(navigateScript(`https://music.apple.com/${country}/label/${appleId}`)).catch(onFailure); return;
    }
    const owner = controller, epoch = randomUUID();
    const stale = (): boolean => owner.signal.aborted || state.epoch !== epoch;
    state = { epoch, open: true, name: link.name, country, albums: [], busy: true, more: false, message: '' };
    await render();
    const known = albumsOfLabel(link.name);
    let id = link.kind === 'mb' ? link.id : undefined, ids: string[] = [], failedIdentify = false;
    try {
      if (link.kind === 'name') { const found = await retry(() => findLabelByName(link.name, owner.signal), owner.signal); id = found?.id; if (found) state.name = found.name; }
      // Sin la familia queda sólo el sello pedido; si el error fue pasajero, «Try again» la vuelve a pedir.
      if (id) ids = await retry(() => labelFamily(id!, owner.signal), owner.signal).catch(error => {
        if (owner.signal.aborted) throw error;
        log('Sellos: error al pedir la familia del sello', { código: errorCode(error) });
        if (transientLabelError(error)) failedIdentify = true;
        return [id!];
      });
    } catch (error) {
      if (stale()) return;
      // Sin MusicBrainz se muestran igual los álbumes ya conocidos; «Try again» vuelve a identificar el sello.
      failedIdentify = true; log('Sellos: error al identificar el sello', { código: errorCode(error) }); onFailure();
    }
    if (stale()) return;
    state.busy = false;
    label = { ids, index: 0, offset: 0, local: known.ids.slice(-labelBrowserLimits.local), named: known.named.map(item => ({ ...item })), pending: [], queued: new Set(),
      checked: 0, found: 0, identified: !!id, failedIdentify: false };
    log('Sellos: catálogo pedido', { porNombre: link.kind === 'name', sellos: ids.length, conocidos: known.ids.length + known.named.length });
    await load();
    if (failedIdentify && label && !stale()) {
      label.failedIdentify = true; state.message = 'The label could not be loaded. Try again.'; state.more = true; await render();
    }
  };
  // Página oficial de un sello: al detectarla se piden sus discos y se dibujan años y lista; al salir se limpia.
  let page: LabelPageState = { epoch: '', open: false, id: '', country: 'us', albums: [], busy: false, message: '' };
  let pageController = new AbortController(); let pageAttempts = 0;
  const renderPage = async (): Promise<void> => { if (live()) await contents.mainFrame.executeJavaScript(labelPageScript(page)).catch(onFailure); };
  const clearPage = async (): Promise<void> => {
    pageController.abort(); pageController = new AbortController();
    if (page.open) { page = { ...page, open: false, albums: [], busy: false }; await renderPage(); }
  };
  const openPage = async (ref: LabelPageRef): Promise<void> => {
    await clearPage();
    const owner = pageController, epoch = randomUUID(), started = Date.now();
    const stale = (): boolean => owner.signal.aborted || page.epoch !== epoch;
    page = { epoch, open: true, id: ref.id, country: ref.country, albums: [], busy: true, message: '' };
    pageAttempts = 0;
    let pages = 0, status = 0;
    const add = (albums: AppleAlbum[]): void => {
      const known = new Set(page.albums.map(album => album.id));
      page.albums = [...page.albums, ...albums.filter(album => !known.has(album.id))].slice(0, labelPageLimits.pageSize * labelPageLimits.pages);
    };
    // Top releases primero (años de las tarjetas visibles) y después latest-releases de a 100 hasta que una página venga corta.
    const fetch = async (view: 'latest-releases' | 'top-releases', offset: number): Promise<AppleAlbum[] | undefined> => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (stale()) return;
        let result: unknown;
        try { result = await contents.mainFrame.executeJavaScript(labelReleasesScript(ref.country, ref.id, view, offset)); }
        catch { return; }
        if (stale()) return;
        // MusicKit todavía no está listo: se espera un segundo y se vuelve a probar.
        if (result === null) { await pause(1000, owner.signal).catch(() => {}); continue; }
        if (result && typeof result === 'object' && !Array.isArray(result) && 'error' in result) { status = Number((result as { error: unknown }).error) || 0; return; }
        pages++;
        return labelReleases(result, ref.country);
      }
    };
    try {
      const top = await fetch('top-releases', 0);
      if (stale()) return;
      if (top) { add(top); await renderPage(); }
      for (let offset = 0; offset < labelPageLimits.pageSize * labelPageLimits.pages; offset += labelPageLimits.pageSize) {
        const batch = await fetch('latest-releases', offset);
        if (stale()) return;
        if (!batch) break;
        add(batch); await renderPage();
        if (batch.length < labelPageLimits.pageSize) break;
      }
      if (stale()) return;
      page.busy = false;
      if (!page.albums.length) page.message = status ? 'Releases could not be loaded.' : 'No releases found.';
      await renderPage();
      log(status && !page.albums.length ? 'Sellos: error en la página de Apple' : 'Sellos: discos de la página de Apple',
        { álbumes: page.albums.length, páginas: pages, estado: status, ms: Date.now() - started });
    } catch (error) {
      if (stale()) return;
      page.busy = false; page.message = 'Releases could not be loaded.'; await renderPage();
      log('Sellos: error en la página de Apple', { código: errorCode(error), páginas: pages }); onFailure();
    }
  };
  // Play o Shuffle en un disco de la lista: sólo IDs que esta misma sesión mostró en el panel o en la página del sello
  // (los ajenos o repetidos se descartan sin rechazar el pedido); un pedido en vuelo por vez. La cola (el disco y los
  // siguientes de la lista, hasta el final) la arma y la alarga album-queue.ts.
  // Un clic nuevo mientras otro Play está en vuelo no se pierde: queda como siguiente y gana el último. El aviso del LCD
  // (ya puesto por la página para ese clic) sólo se retira si el pedido no prosperó y no hay otro esperando.
  let playInFlight = false;
  let nextPlay: { id: string; mode: AlbumQueueMode; following: readonly string[]; parked: boolean; start?: string } | undefined;
  const playFailed = (): Promise<unknown> => contents.mainFrame.executeJavaScript(pendingPlayFailedScript).catch(() => undefined);
  // parked: el panel está escondido (el usuario salió de su página), así que el pedido viene de la lista de la página.
  const playAlbum = async (id: string, mode: AlbumQueueMode, following: readonly string[] = [], start?: string, parked = false): Promise<void> => {
    const inPanel = state.open && !parked && state.albums.some(album => album.id === id);
    const list = inPanel ? state.albums : page.open ? page.albums : [];
    const shown = new Set(list.map(album => album.id));
    if (!shown.has(id)) { log('Sellos: play rechazado, disco fuera de la lista'); if (!playInFlight) await playFailed(); return; }
    if (playInFlight) { log('Sellos: play en espera, otro en vuelo'); nextPlay = { id, mode, following, parked, ...(start ? { start } : {}) }; return; }
    const ids = [id];
    for (const next of following) if (shown.has(next) && !ids.includes(next) && ids.length < albumQueueLimits.albums) ids.push(next);
    playInFlight = true;
    try {
      const result = await queue.start(ids, mode, inPanel ? state.country : page.country, start);
      log('Sellos: play de un disco', { resultado: result === 'requested' ? 1 : result === 'busy' ? 2 : result === 'unavailable' ? 3 : result === 'empty' ? 5 : 4,
        modo: mode === 'shuffle' ? 1 : 0, discos: ids.length, descartados: following.length - (ids.length - 1), tema: !!start });
      if (result !== 'requested' && !nextPlay) await playFailed();
    } catch { log('Sellos: error al reproducir un disco'); onFailure(); if (!nextPlay) await playFailed(); }
    finally {
      playInFlight = false;
      const waiting = nextPlay; nextPlay = undefined;
      if (waiting) void playAlbum(waiting.id, waiting.mode, waiting.following, waiting.start, waiting.parked);
    }
  };
  const poll = async (): Promise<void> => {
    if (polling) { pendingWake = true; return; }
    if (!live()) return;
    polling = true;
    try {
      const taken = await contents.mainFrame.executeJavaScript(takeRequestScript) as { parked?: boolean; request: string | null; busy: string | null; following: string | null; country: string | null } | null;
      const request = parseLabelRequest(taken?.request, taken?.following);
      const owner = typeof taken?.busy === 'string' && busyOwner.test(taken.busy) ? taken.busy : undefined;
      if (owner && (request?.action === 'open' || request?.action === 'new-releases')) servingBusy = owner;
      const done = (): Promise<void> => endBusy(owner);
      // Si otro pedido (cerrar, más, play) pisó al que encendió la línea antes de este sondeo, la línea se apaga igual.
      if (!request || request.action === 'close' || request.action === 'more' || request.action === 'play') await done();
      if (request) {
        if (request.action === 'close') await close();
        else if (request.action === 'more') void load();
        else if (request.action === 'play') void playAlbum(request.id, request.mode, request.following, request.start, taken?.parked === true);
        else if (request.action === 'new-releases') { if (taken?.country && /^[a-z]{2}$/.test(taken.country)) void openNewReleases(taken.country).finally(done); else { log('Novedades: sin país'); await done(); } }
        else if (taken?.country && /^[a-z]{2}$/.test(taken.country)) void open(request.link, taken.country).finally(done);
        else await done();
      }
      const ref = labelPageRef(await contents.mainFrame.executeJavaScript(takeLabelPageScript));
      if (ref && !(page.open && page.id === ref.id && page.country === ref.country)) {
        // Hasta tres intentos por página si el DOM todavía no tiene el contenedor; después se deja hasta que cambie la URL.
        log('Sellos: página de Apple detectada', { intento: pageAttempts + 1 }); pageAttempts++;
        if (pageAttempts <= 3) void openPage(ref);
      } else if (!ref && page.open) await clearPage();
      else if (!ref) pageAttempts = 0;
    } catch { /* Navegación en curso: el próximo ciclo lo vuelve a leer. */ }
    finally { polling = false; if (pendingWake) { pendingWake = false; void poll(); } }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === wakeMessage && details.frame === contents.mainFrame && live()) void poll();
  };
  contents.on('console-message', wake);
  const timer = setInterval(() => void poll(), 1500);
  // Una navegación del documento (recarga, otra página) cierra el panel. Las del enrutador de Apple (mismo documento) no:
  // el shell lo esconde al salir de la entrada del historial donde se abrió y lo vuelve a mostrar al volver a ella con Back,
  // antes de que Apple dibuje la página de abajo (sin pasar por ella). El panel escondido sigue cargando.
  const sameUrl = (url: string): boolean => {
    try { const next = new URL(url), current = new URL(contents.getURL()); return next.origin === current.origin && next.pathname === current.pathname && next.search === current.search; }
    catch { return false; }
  };
  contents.on('did-start-navigation', (details, url, inPlace, mainFrame) => {
    if (!(details.isMainFrame ?? mainFrame)) return;
    const sameDocument = details.isSameDocument ?? inPlace;
    if (sameDocument && sameUrl(details.url ?? url)) return;
    if (!sameDocument) void close();
    void clearPage();
  });
  contents.once('destroyed', () => { stopped = true; clearInterval(timer); controller.abort(); pageController.abort(); contents.removeListener('console-message', wake); });
}
