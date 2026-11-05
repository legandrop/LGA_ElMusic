import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';
import { findEditionLabels, isMbid, labelBaseName, phonographicHolder } from './labels';
import type { RecordLabel } from './labels';
import { labelLinkKey } from './record-labels';
import type { LabelLink } from './record-labels';
import { albumKeyPattern, labelCacheLimits, labelFresh, readLabelCache, saveLabelCache } from './label-cache';
import type { CachedLabel } from './label-cache';
import { itunesIdle, searchAppleAlbums } from './recommendations';
import type { AppleAlbumMatch } from './recommendations';
import { albumArtists, catalogAlbums, pickSearchedAlbum, primaryArtist, releasedPattern, type AlbumArtist } from './album-match';
import type { CatalogAlbum } from './album-match';

// Columna Label de las listas de canciones. La página entrega, por fila, el enlace público de
// álbum o, si Apple no lo puso (tandas de biblioteca cargadas después de las primeras ~100), artista y nombre del álbum.
// Main lee el sello (recordLabel) del catálogo con el MusicKit de la página: hasta 100 álbumes por pedido por ID, o una
// búsqueda de álbumes por artista + nombre (sólo catálogo, nada de la biblioteca).
// Mientras Apple tiene cortada esa búsqueda, el ID del álbum sale de la búsqueda pública de iTunes.
// Sin sello en el catálogo queda el titular ℗ (provisional, no acredita sello) y MusicBrainz intenta confirmarlo, con tope.
// En el almacén de la página: texto = sello(s), '℗ titular' = sólo copyright de la grabación, '' = sin dato,
// null = error (se reintenta pasado retryMs). Las claves son el ID de álbum o 'n:' + artista + U+0001 + álbum.
const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
export const playlistLabelLimits = { sample: 1000, known: 3000, catalogBatch: 100, catalogWorkers: 3, searchWorkers: 4, catalogPerPage: 3000,
  searchPerPage: 800, musicBrainzPerPage: 150, timeoutMs: 20000, retryMs: 10 * 60 * 1000, saveDelayMs: 15000 } as const;

// shown = fila a la vista; stored = la página ya tiene su sello; byIndex = ID tomado de la lista (temas de la playlist o
// alias de otra fila del mismo disco), no del enlace de Apple de la fila: si el catálogo no lo da, la fila vuelve a buscarse.
// Mensaje fijo y sin datos con que la página despierta el sondeo (music-shell.js, wakeLabels).
export const playlistLabelsWakeMessage = 'elMusic.labels.rows';
export interface PlaylistRef { key: string; country: string; id?: string; artist?: string; album?: string; shown?: boolean; stored?: boolean; byIndex?: boolean }
// Recorte estable: aplicarlo dos veces da lo mismo (main vuelve a limpiar lo que manda la página).
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
export function nameKey(artist: string, album: string): string { return 'n:' + clean(artist) + '\u0001' + clean(album); }
const keyPattern = albumKeyPattern;

export const playlistAlbumsScript = `(() => {
  ${guard}
  const store = document.documentElement[Symbol.for('el-music.playlist-labels')];
  const clean = value => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 200).trim();
  // Las páginas de biblioteca no llevan país: se toma de un enlace de álbum de la lista o de la barra lateral de Apple.
  const storefront = [...document.querySelectorAll('.navigation a[href]')].map(link => link.getAttribute('href') || '')
    .map(href => href.match(/^(?:https:\\/\\/music\\.apple\\.com)?\\/([a-z]{2})\\/(?:home|new|radio|search|browse)(?:[\\/?#]|$)/)?.[1]).find(Boolean);
  let country = location.pathname.match(/^\\/([a-z]{2})(?:\\/|$)/)?.[1] || storefront;
  // Lo que se ve primero: las filas desde media pantalla
  // arriba hasta media pantalla abajo van al frente (shown) y se mandan aunque ya tengan sello (stored), para que main
  // adelante en sus colas lo que todavía les falta (fecha y género incluidos). Alias: de cada fila con
  // enlace de Apple, también artista y álbum, para que main dé ese ID a las filas sin enlace del mismo disco. El enlace de
  // álbum propio (el-music-album-link) no cuenta como de Apple: la clave de la fila sigue siendo la del nombre.
  const seen = new Set(), near = [], far = [], aliases = [], above = -innerHeight / 2, below = innerHeight * 1.5;
  for (const row of document.querySelectorAll('.songs-list .songs-list-row')) {
    const cell = row.querySelector('.songs-list__col--tertiary');
    if (!cell) continue;
    const match = (cell.querySelector('a[href]:not(.el-music-album-link)')?.getAttribute('href') || '').match(/^(?:https:\\/\\/music\\.apple\\.com)?\\/([a-z]{2})\\/album\\/(?:[^/?#]+\\/)?(\\d{1,20})(?:[?#]|$)/);
    const album = clean(cell.textContent), artist = clean(row.querySelector('.songs-list__col--secondary')?.textContent);
    let ref;
    if (match) { ref = { key: match[2], country: match[1], id: match[2] }; country ||= match[1]; }
    else {
      if (!album || !artist) continue;
      ref = { key: 'n:' + artist + '\\u0001' + album, artist, album };
    }
    if (seen.has(ref.key)) continue;
    seen.add(ref.key);
    if (match && album && artist && aliases.length < 1000) aliases.push([artist, album, match[2]]);
    const box = row.getBoundingClientRect(), shown = box.bottom > above && box.top < below, stored = store?.has(ref.key) && store.get(ref.key) !== null;
    if (stored && !shown) continue;
    (shown ? near : far).push({ ...ref, ...(shown ? { shown: 1 } : {}), ...(stored ? { stored: 1 } : {}) });
    if (near.length + far.length >= ${playlistLabelLimits.sample}) break;
  }
  const refs = [...near, ...far].map(ref => ref.id ? ref : { ...ref, country });
  // Sin país no hay búsqueda por nombre: se avisa cuántas filas quedan afuera (main lo registra una vez por página).
  const named = refs.filter(ref => !ref.id).length;
  return [{ aliases }, ...(country ? refs : [...refs.filter(ref => ref.id), ...(named ? [{ dropped: named }] : [])])];
})()`;

export function playlistAlbums(value: unknown): PlaylistRef[] {
  if (!Array.isArray(value)) return [];
  const refs: PlaylistRef[] = [], keys = new Set<string>();
  for (const item of value.slice(0, playlistLabelLimits.sample + 2)) {
    const ref = item as Record<string, unknown>;
    if (!ref || typeof ref.country !== 'string' || !/^[a-z]{2}$/.test(ref.country) || typeof ref.key !== 'string' || keys.has(ref.key)) continue;
    const flags = { ...(ref.shown === 1 ? { shown: true } : {}), ...(ref.stored === 1 ? { stored: true } : {}) };
    if (typeof ref.id === 'string') {
      if (/^\d{1,20}$/.test(ref.id) && ref.key === ref.id && albumKeyPattern.test(ref.key)) { refs.push({ key: ref.id, country: ref.country, id: ref.id, ...flags }); keys.add(ref.key); }
    } else if (typeof ref.artist === 'string' && typeof ref.album === 'string' && clean(ref.artist) && clean(ref.album) &&
      ref.key === nameKey(ref.artist, ref.album) && albumKeyPattern.test(ref.key)) {
      refs.push({ key: ref.key, country: ref.country, artist: clean(ref.artist), album: clean(ref.album), ...flags }); keys.add(ref.key);
    }
  }
  return refs.slice(0, playlistLabelLimits.sample);
}
// Alias de la página: artista, álbum e ID de cada fila con enlace de Apple (hasta 1000), validados.
export function playlistAliases(value: unknown): Array<[string, string, string]> {
  const item = Array.isArray(value) ? value.find(entry => entry && typeof entry === 'object' && 'aliases' in entry) as { aliases?: unknown } | undefined : undefined;
  if (!Array.isArray(item?.aliases)) return [];
  return item.aliases.slice(0, 1000).filter((entry): entry is [string, string, string] => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' &&
    typeof entry[2] === 'string' && !!clean(entry[0]) && !!clean(entry[1]) && /^\d{1,20}$/.test(entry[2])).map(([artist, album, id]) => [clean(artist), clean(album), id]);
}

// Índice de discos de la lista (0.1.50): nombre de álbum + artista principal, normalizados, → ID de catálogo. Lo llenan los
// temas de la playlist de biblioteca (playlistTracksScript) y los alias de la página. Un nombre con dos IDs distintos (p. ej.
// versión explícita y limpia) queda ambiguo y no da ninguno: esa fila se busca como antes.
const same = (value: string): string => clean(value).normalize('NFKC').toLowerCase();
export class AlbumIndex {
  private readonly ids = new Map<string, Set<string>>();
  private key(artist: string, album: string): string { return same(primaryArtist(artist)) + '\u0001' + same(album); }
  add(artist: string, album: string, id: string): void {
    if (!clean(artist) || !clean(album) || !/^\d{1,20}$/.test(id) || this.ids.size >= 20000) return;
    const key = this.key(artist, album), set = this.ids.get(key) ?? new Set<string>();
    if (set.size < 4) set.add(id); this.ids.set(key, set);
  }
  find(artist: string, album: string): string | undefined { const set = this.ids.get(this.key(artist, album)); return set?.size === 1 ? [...set][0] : undefined; }
  forget(artist: string, album: string, id: string): void { this.ids.get(this.key(artist, album))?.delete(id); }
  clear(): void { this.ids.clear(); }
  get size(): number { return this.ids.size; }
}

// Temas de la playlist de biblioteca abierta: con el singleton de la página, de a 100 y
// con la relación pública catalog, sólo artista, álbum e ID de catálogo del álbum de cada tema (de la URL de la canción de
// catálogo, /album/…/{id}?i=…). Nada se escribe; no se leen otras playlists, historial ni cola.
export const playlistTrackLimits = { page: 100, pages: 50, parallel: 3, waitMs: 8000 } as const;
const libraryPlaylistPattern = /^p\.[A-Za-z0-9]{1,64}$/;
export function libraryPlaylistOf(url: string): string | undefined {
  try { const id = new URL(url).pathname.match(/^\/library\/playlist\/(p\.[A-Za-z0-9]{1,64})\/?$/)?.[1]; return id && libraryPlaylistPattern.test(id) ? id : undefined; } catch { return; }
}
export function playlistTracksScript(playlistId: string, offset: number): string {
  if (!libraryPlaylistPattern.test(playlistId) || !Number.isInteger(offset) || offset < 0 || offset % playlistTrackLimits.page || offset >= playlistTrackLimits.page * playlistTrackLimits.pages) throw new Error('INVALID_TRACKS');
  return `(async () => {
    ${guard}
    ${kit}
    if (music.isAuthorized !== true) return null;
    try {
      const response = await music.api.music(${JSON.stringify('/v1/me/library/playlists/' + playlistId + '/tracks')}, { limit: ${playlistTrackLimits.page}, offset: ${offset}, include: 'catalog' });
      ${refused}
      const data = response?.data?.data;
      if (!Array.isArray(data)) return { error: 0 };
      const items = [];
      for (const track of data.slice(0, ${playlistTrackLimits.page})) {
        const song = track?.relationships?.catalog?.data?.[0], url = String(song?.attributes?.url ?? '');
        const album = url.match(/^https:\\/\\/music\\.apple\\.com\\/[a-z]{2}\\/album\\/(?:[^/?#]+\\/)?(\\d{1,20})\\?i=\\d{1,20}$/)?.[1];
        const artist = track?.attributes?.artistName, name = track?.attributes?.albumName;
        if (album && typeof artist === 'string' && typeof name === 'string') items.push([artist.slice(0, 240), name.slice(0, 240), album]);
      }
      const total = Number(response?.data?.meta?.total);
      return { items, count: data.length, total: Number.isInteger(total) && total >= 0 ? total : -1, next: !!response?.data?.next };
    } ${failure}
  })()`;
}
export interface PlaylistTracksPage { items: Array<[string, string, string]>; count: number; total: number; next: boolean }
export function playlistTracksPage(value: unknown): PlaylistTracksPage | number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if ('error' in value) { const status = Number((value as { error: unknown }).error); return Number.isInteger(status) ? status : 0; }
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items) || !Number.isInteger(page.count) || !Number.isInteger(page.total)) return;
  const items = page.items.slice(0, playlistTrackLimits.page).filter((entry): entry is [string, string, string] => Array.isArray(entry) && typeof entry[0] === 'string' &&
    typeof entry[1] === 'string' && typeof entry[2] === 'string' && /^\d{1,20}$/.test(entry[2]));
  return { items, count: Math.min(Number(page.count), playlistTrackLimits.page), total: Number(page.total), next: page.next === true };
}

// Lectura del catálogo con el singleton MusicKit que configuró la página oficial: sólo sello y copyright de cada álbum.
const kit = `let music;
    try { const kit = globalThis.MusicKit; music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined; } catch { return null; }
    if (typeof music?.api?.music !== 'function') return null;`;
// MusicKit no lanza ante un 429 de búsqueda (tope de Apple, medido en ~100 búsquedas): devuelve la respuesta con
// status y errors y sin resultados. Sin esta comprobación el tope se leía como «álbum inexistente».
const refused = `const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
      if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) return { error: Number.isInteger(code) && code >= 400 ? code : refusal };`;
const failure = `catch (error) { const status = Number(error?.status ?? error?.response?.status ?? error?.errorCode); return { error: Number.isInteger(status) ? status : 0 }; }`;
// Fecha de lanzamiento y género (columnas Released y Genre): el primer género que no sea el genérico «Music».
export const albumFields = `album => ({ id: String(album?.id), name: String(album?.attributes?.name ?? '').slice(0, 240), artist: String(album?.attributes?.artistName ?? '').slice(0, 240),
      label: String(album?.attributes?.recordLabel ?? '').slice(0, 240), copyright: String(album?.attributes?.copyright ?? '').slice(0, 400),
      released: /^\\d{4}(?:-\\d{2}){0,2}$/.test(String(album?.attributes?.releaseDate ?? '')) ? String(album.attributes.releaseDate) : undefined,
      genre: (Array.isArray(album?.attributes?.genreNames) ? album.attributes.genreNames.map(String).find(name => !/^(?:music|música|musica|musique|musik)$/i.test(name)) : undefined)?.slice(0, 80),
      artists: (() => { const list = album?.relationships?.artists?.data; return Array.isArray(list) && list.every(item => typeof item?.attributes?.name === 'string')
        ? list.slice(0, 6).map(item => [String(item.attributes.name).slice(0, 240), String(item.id)]).filter(pair => pair[0].trim() && /^\\d{1,20}$/.test(pair[1])) : undefined; })() })`;
export function catalogAlbumsScript(country: string, ids: readonly string[]): string {
  if (!/^[a-z]{2}$/.test(country) || !ids.length || ids.length > playlistLabelLimits.catalogBatch || ids.some(id => !/^\d{1,20}$/.test(id))) throw new Error('INVALID_ALBUMS');
  return `(async () => {
    ${guard}
    ${kit}
    try {
      // include=artists: nombre e ID de los artistas del álbum, para enlazar el artista de las filas sin enlace.
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/albums`)}, { ids: ${JSON.stringify(ids.join(','))}, include: 'artists' });
      ${refused}
      const data = response?.data?.data;
      return Array.isArray(data) ? data.slice(0, ${playlistLabelLimits.catalogBatch}).map(${albumFields}) : [];
    } ${failure}
  })()`;
}
export function catalogSearchScript(country: string, term: string, limit = 10): string {
  if (!/^[a-z]{2}$/.test(country) || !clean(term) || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('INVALID_SEARCH');
  return `(async () => {
    ${guard}
    ${kit}
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/search`)}, { term: ${JSON.stringify(clean(term).slice(0, 200))}, types: 'albums', limit: ${limit} });
      ${refused}
      const data = response?.data?.results?.albums?.data;
      return Array.isArray(data) ? data.slice(0, ${limit}).map(${albumFields}) : [];
    } ${failure}
  })()`;
}
export { catalogAlbums, pickSearchedAlbum, primaryArtist } from './album-match';
export type { CatalogAlbum } from './album-match';

// Sólo claves válidas, nombres de texto acotados (o null por error) y la clave opaca del sello para abrir su música; la
// página los inserta con textContent y sólo puede devolver esa clave, que main valida contra su lista. Hay
// también fecha de lanzamiento (ISO) y género del álbum, en un segundo almacén (el-music.playlist-info).
// Sexto campo: ID de catálogo del álbum de una clave por nombre, para que la página enlace el álbum (Apple no lo enlaza).
// Séptimo campo: nombre e ID de catálogo de los artistas del álbum, para que la página enlace el artista de las
// filas donde Apple no lo enlaza (tandas de biblioteca).
export type PlaylistLabelEntry = readonly [string, string | null, string?, string?, string?, string?, ReadonlyArray<AlbumArtist>?];
export function playlistLabelsScript(entries: ReadonlyArray<PlaylistLabelEntry>): string {
  const clean = entries.filter(([id, name, key, released, genre, album, artists]) => keyPattern.test(id) && (typeof name === 'string' || name === null) &&
    (key === undefined || /^[amp][a-f\d-]{1,40}$/.test(key)) && (released === undefined || releasedPattern.test(released)) &&
    (genre === undefined || typeof genre === 'string') && (album === undefined || /^\d{1,20}$/.test(album)) &&
    (artists === undefined || albumArtists(artists) !== undefined)).slice(0, 500)
    .map(([id, name, key, released, genre, album, artists]) => [id, name === null ? null : name.replace(/\s+/g, ' ').trim().slice(0, 240), key ?? null,
      released ?? '', (genre ?? '').replace(/\s+/g, ' ').trim().slice(0, 80), id.startsWith('n:') && album ? album : '', artists ? albumArtists(artists)! : []]);
  return `(() => {
  ${guard}
  const root = document.documentElement, key = Symbol.for('el-music.playlist-labels');
  const store = root[key] ||= new Map(), links = root[Symbol.for('el-music.playlist-label-links')] ||= new Map(), info = root[Symbol.for('el-music.playlist-info')] ||= new Map();
  for (const [id, name, link, released, genre, album, artists] of ${JSON.stringify(clean)}) {
    store.set(id, name); if (link) links.set(id, link); else links.delete(id);
    if (released || genre || album || artists.length) info.set(id, { released, genre, album, artists }); else if (name !== null) info.delete(id);
  }
  if (store.size > ${playlistLabelLimits.known}) for (const id of [...store.keys()].slice(0, store.size - ${playlistLabelLimits.known})) { store.delete(id); links.delete(id); info.delete(id); }
  document.dispatchEvent(new Event('el-music-playlist-labels'));
  return true;
})()`;
}

type Diagnostic = (event: string, fields: Record<string, boolean | number>) => void;
export interface AlbumDetails { released?: string; genre?: string; artists?: AlbumArtist[] }
// Fecha, género y artistas que trajo el catálogo para un álbum (artistas sólo si vinieron: las búsquedas no los traen).
const detailsOf = (album: CatalogAlbum | undefined): AlbumDetails => ({ ...(album?.released ? { released: album.released } : {}),
  ...(album?.genre ? { genre: clean(album.genre) } : {}), ...(album?.artists ? { artists: album.artists } : {}) });
// Álbumes que la columna ya sabe que son de un sello (por nombre base, también «℗ …» y sellos de MusicBrainz separados por
// coma) para el panel del sello, que así muestra al menos los de la biblioteca: IDs de catálogo y, para las
// claves por nombre guardadas antes de que la caché llevara ID, el artista y el álbum de la fila para buscarlos.
export interface KnownLabelAlbums { ids: string[]; named: Array<{ artist: string; title: string }> }
export interface PlaylistLabels { albumsOfLabel(name: string): KnownLabelAlbums }
export function installPlaylistLabels(contents: WebContents, onFailure: () => void, diagnostic?: Diagnostic, cacheFile?: string): PlaylistLabels {
  // Caché en disco si main pasa el archivo; si está ilegible o no es nuestra, se sigue sólo en memoria y no se pisa.
  let known = new Map<string, CachedLabel>(); let persist = !!cacheFile;
  if (cacheFile) {
    try { known = readLabelCache(cacheFile); diagnostic?.('Sellos de lista: caché cargada', { sellos: known.size }); }
    catch { persist = false; diagnostic?.('Sellos de lista: caché ilegible, sólo en memoria', { guardar: false }); }
  }
  const failed = new Map<string, number>();
  const inflight = new Set<string>();
  // Sellos ya en caché pero sin fecha ni género (caché anterior a la versión 5): se piden sólo esos datos al catálogo, por
  // ID, sin cambiar el sello visible; una vez por sesión y por álbum (detailsTried, que se marca al terminar: lo cancelado
  // por un cambio de página se vuelve a pedir al regresar), con el mismo presupuesto del catálogo.
  const detailsKeys = new Set<string>(), detailsTried = new Set<string>();
  // Discos de la lista (0.1.50): temas de la playlist de biblioteca y alias de la página → ID de catálogo, por página.
  // Mientras se leen los temas (hasta waitMs), las filas sin enlace esperan en lugar de gastar búsquedas.
  const index = new AlbumIndex();
  let tracks: { playlist: string; state: 'loading' | 'done' | 'failed'; started: number } | undefined;
  const tracksPending = (): boolean => tracks?.state === 'loading' && Date.now() - tracks.started < playlistTrackLimits.waitMs;
  // Filas que esperan los temas para saber su ID.
  const waiting = new Map<string, PlaylistRef>();
  // Filas a la vista en el último sondeo: sus pedidos van primero en todas las colas.
  let hot = new Set<string>();
  // Tras un 429 de la búsqueda de Apple se prueba con una sola búsqueda; los cuatro buscadores vuelven cuando ésa sale bien.
  let probing = false;
  let catalog: PlaylistRef[] = [], search: PlaylistRef[] = [];
  let musicBrainz: Array<{ key: string; id: string; fallback: string; fallbackLink?: LabelLink; details: AlbumDetails }> = [];
  let catalogBudget: number = playlistLabelLimits.catalogPerPage, searchBudget: number = playlistLabelLimits.searchPerPage;
  let musicBrainzBudget: number = playlistLabelLimits.musicBrainzPerPage;
  let pagePath = ''; let controller = new AbortController(); let stopped = false; let polling = false;
  let catalogWorkers = 0; let searchWorkers = 0; let saveTimer: NodeJS.Timeout | undefined; let dirty = false; let saveFailures = 0; let mbRunning = false; let notReadyUntil = 0;
  let pending: PlaylistLabelEntry[] = []; let flushTimer: NodeJS.Timeout | undefined; let lastFailure = 0;
  // Rastro de cada sondeo que encuentra filas sin resolver: se registra sólo cuando cambia y hasta 20
  // veces por página; y una vez por página si la página no pudo determinar el país (sin él no hay búsqueda por nombre).
  let lastPoll = '', pollLogs = 0, droppedReported = false;
  // Resumen de las búsquedas de esta página, al vaciarse la cola: cuántas, cuántas con álbum y cuántos errores.
  let searched = 0, matched = 0, noResults = 0, noMatch = 0, errors = 0, lastStatus = 0;
  const attempts = new Map<string, number>(); let backoff = 2000;
  // Tope de búsquedas de Apple (429, ~100 seguidas): se pausa sólo la búsqueda, sin gastar intentos ni marcar error, y se
  // vuelve a probar a los 1, 2, 4… hasta 15 min. Es global (no se reinicia al cambiar de página); el catálogo por ID sigue.
  let searchPausedUntil = 0, searchPause = 60000;
  // Buscador iTunes (ver runItunes): pausa propia ante errores y, por página, las filas que ya probó.
  let itunesRunning = false, itunesPausedUntil = 0, itunesPause = 60000, itunesSearched = 0, itunesMatched = 0, itunesErrors = 0;
  const itunesTried = new Set<string>(), itunesAlbumOnly = new Set<string>(), itunesFailures = new Map<string, number>();
  const searchOpen = (): boolean => Date.now() >= notReadyUntil && Date.now() >= searchPausedUntil;
  const pauseSearch = (ref: PlaylistRef, owner: AbortController): void => {
    if (owner.signal.aborted) return;
    search.unshift(ref);
    if (Date.now() < searchPausedUntil) return;
    diagnostic?.('Sellos de lista: tope de búsquedas de Apple', { esperaMs: searchPause, pendientes: search.length });
    searchPausedUntil = Date.now() + searchPause; searchPause = Math.min(searchPause * 2, 15 * 60000); probing = true;
  };
  // Resumen por página para el log: desde el primer sondeo hasta que no queda nada pendiente, cuántos vinieron de la caché.
  let pageStarted = 0, fromCache = 0, consulted = 0, reported = false;
  const live = (): boolean => !stopped && !contents.isDestroyed() && isMusicPage(contents.getURL());
  const run = (script: string): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([contents.mainFrame.executeJavaScript(script),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PLAYLIST_LABELS_TIMEOUT')), playlistLabelLimits.timeoutMs); })])
      .finally(() => clearTimeout(timer));
  };
  const save = (): void => {
    saveTimer = undefined;
    if (!persist || !dirty || !cacheFile) return;
    try { saveLabelCache(cacheFile, known); dirty = false; saveFailures = 0; }
    catch {
      // Un antivirus o el indexador pueden trabar el archivo un momento: se reintenta y sólo al tercer fallo seguido se deja.
      saveFailures++; diagnostic?.('Sellos de lista: no se pudo guardar la caché', { sellos: known.size, intento: saveFailures });
      if (saveFailures >= 3) persist = false; else saveTimer = setTimeout(save, playlistLabelLimits.saveDelayMs);
    }
  };
  // Las claves por nombre guardan también el ID del álbum encontrado (album); todas, su fecha de lanzamiento y género.
  const remember = (key: string, name: string, link?: LabelLink, album?: string, details: AlbumDetails = {}): void => {
    known.delete(key);
    if (known.size >= labelCacheLimits.entries) known.delete(known.keys().next().value!);
    const text = name.slice(0, labelCacheLimits.name), id = key.startsWith('n:') && album && /^\d{1,20}$/.test(album) ? album : undefined;
    known.set(key, { name: text, ...(link ? { link } : {}), saved: Date.now(), ...(id ? { id } : {}), ...details }); failed.delete(key);
    dirty = true; if (persist && !saveTimer) saveTimer = setTimeout(save, playlistLabelLimits.saveDelayMs);
  };
  const flush = (): void => {
    flushTimer = undefined;
    if (!pending.length || !live()) { pending = []; return; }
    const batch = pending; pending = [];
    try {
      for (let start = 0; start < batch.length; start += 500)
        void contents.mainFrame.executeJavaScript(playlistLabelsScript(batch.slice(start, start + 500))).catch(onFailure);
    } catch { onFailure(); /* Frame destruido entre el chequeo y el envío. */ }
  };
  // La clave opaca del sello se publica de nuevo en cada uso, así sigue en la lista de record-labels aunque haya rotado.
  const publish = (key: string, name: string | null, link?: LabelLink, details: AlbumDetails = {}, album?: string): void => {
    const linkKey = link ? labelLinkKey(link) : undefined, catalog = album ?? known.get(key)?.id;
    pending.push([key, name, linkKey, details.released, details.genre, key.startsWith('n:') && catalog && /^\d{1,20}$/.test(catalog) ? catalog : undefined, details.artists]);
    // Lo que llega de la red se agrupa 120 ms (antes 400); lo de la caché sale al final del mismo sondeo (flushNow).
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  };
  const flushNow = (): void => { if (flushTimer) clearTimeout(flushTimer); flush(); };
  const done = (key: string, owner: AbortController): void => { if (controller === owner) inflight.delete(key); };
  const fail = (key: string, owner: AbortController): void => {
    if (owner.signal.aborted) return;
    // Un pedido sólo de fecha y género que falla deja el sello de la caché como está.
    if (detailsKeys.has(key)) { detailsKeys.delete(key); detailsTried.add(key); done(key, owner); return; }
    failed.set(key, Date.now()); publish(key, null); done(key, owner);
  };
  const names = (labels: Array<{ name: string }>): string => [...new Set(labels.map(label => label.name))].join(', ');
  // Enlace del primer sello confirmado por MusicBrainz o, si no, del nombre a identificar (catálogo de Apple al hacer clic).
  const linkOf = (labels: RecordLabel[], name?: string): LabelLink | undefined => {
    const first = labels[0];
    const text = (first?.name || name || '').replace(/\s+/g, ' ').trim().slice(0, 120).trim();
    if (!text) return;
    return first?.source === 'MusicBrainz' && isMbid(first.id) ? { kind: 'mb', id: first.id, name: text } : { kind: 'name', name: text };
  };
  const resolve = (ref: PlaylistRef, album: CatalogAlbum | undefined, owner: AbortController): void => {
    if (owner.signal.aborted) return;
    attempts.delete(ref.key);
    // Un ID de la lista (temas o alias) que el catálogo de esta región no da no acredita «sin dato»: la fila se busca por nombre.
    if (!album && ref.byIndex && ref.artist && ref.album) {
      index.forget(ref.artist, ref.album, ref.id!);
      if (searchBudget > 0) { searchBudget--; search.push({ key: ref.key, country: ref.country, artist: ref.artist, album: ref.album, ...(ref.shown ? { shown: true } : {}) }); startWorkers(); return; }
    }
    if (!album) { remember(ref.key, ''); publish(ref.key, ''); done(ref.key, owner); return; }
    const label = clean(album.label), details = detailsOf(album);
    // El catálogo acaba de responder sin fecha ni género: no tiene sentido volver a pedirlos en esta sesión.
    if (!details.released && !details.genre) detailsTried.add(ref.key);
    if (label) { const link = linkOf([], label); remember(ref.key, label, link, album.id, details); publish(ref.key, label, link, details); done(ref.key, owner); return; }
    const holder = phonographicHolder(album.copyright), fallback = holder ? '℗ ' + holder : '', fallbackLink = holder ? linkOf([], holder) : undefined;
    if (musicBrainzBudget <= 0) { remember(ref.key, fallback, fallbackLink, album.id, details); publish(ref.key, fallback, fallbackLink, details); done(ref.key, owner); return; }
    if (fallback) publish(ref.key, fallback, fallbackLink, details, album.id);
    musicBrainzBudget--; musicBrainz.push({ key: ref.key, id: album.id, fallback, fallbackLink, details }); void runMusicBrainz();
  };
  // Respuesta del catálogo para un sello ya conocido: se agregan fecha, género y artistas y se vuelve a publicar con el mismo
  // sello. Lo que el catálogo no trae esta vez (por ejemplo, la fecha) se conserva de la caché.
  const resolveDetails = (ref: PlaylistRef, album: CatalogAlbum | undefined, owner: AbortController): void => {
    if (owner.signal.aborted) return;
    detailsKeys.delete(ref.key); detailsTried.add(ref.key); attempts.delete(ref.key);
    const cached = known.get(ref.key), found = detailsOf(album);
    const details: AlbumDetails = { ...(cached?.released ? { released: cached.released } : {}), ...(cached?.genre ? { genre: cached.genre } : {}),
      ...(cached?.artists ? { artists: cached.artists } : {}), ...found };
    // También sin fecha ni género, el ID encontrado para una clave por nombre se guarda (enlace de álbum propio de la fila).
    if (cached && (found.released || found.genre || found.artists || (!cached.id && album?.id))) { remember(ref.key, cached.name, cached.link, cached.id ?? album?.id, details); publish(ref.key, cached.name, cached.link, details); }
    done(ref.key, owner);
  };
  const runMusicBrainz = async (): Promise<void> => {
    if (mbRunning) return; mbRunning = true;
    try {
      while (musicBrainz.length && live()) {
        const item = musicBrainz.shift()!; const owner = controller;
        try {
          const labels = await findEditionLabels(item.id, owner.signal);
          const name = names(labels) || item.fallback, link = labels.length ? linkOf(labels) : item.fallbackLink;
          remember(item.key, name, link, item.id, item.details); publish(item.key, name, link, item.details); done(item.key, owner);
        } catch {
          // Con ℗ provisional ya visible, un fallo de MusicBrainz lo deja como está.
          if (item.fallback && !owner.signal.aborted) { remember(item.key, item.fallback, item.fallbackLink, item.id, item.details); done(item.key, owner); }
          else fail(item.key, owner);
        }
      }
    } finally { mbRunning = false; }
  };
  // Error del catálogo: 404 en un pedido por IDs es «ninguno disponible en esta región»; el resto se reintenta más tarde.
  const statusOf = (value: unknown): number | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('error' in value)) return;
    const status = Number((value as { error: unknown }).error); return Number.isInteger(status) ? status : 0;
  };
  // Error pasajero (sin respuesta, 401/403/429 o 5xx): los álbumes vuelven a la cola y se espera 2, 4, 8… hasta 60 s antes de
  // seguir; al tercer intento quedan con error, reintentable pasado retryMs. Los demás errores se marcan al instante.
  const transient = (status: number): boolean => status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
  const retryLater = (refs: PlaylistRef[], owner: AbortController, status: number): PlaylistRef[] => {
    if (owner.signal.aborted) return [];
    const again = refs.filter(ref => {
      const count = (attempts.get(ref.key) ?? 0) + 1;
      if (count < 3) { attempts.set(ref.key, count); return true; }
      attempts.delete(ref.key); fail(ref.key, owner); return false;
    });
    diagnostic?.('Sellos de lista: error pasajero del catálogo', { álbumes: refs.length, estado: status, esperaMs: backoff });
    notReadyUntil = Date.now() + backoff; backoff = Math.min(backoff * 2, 60000);
    return again;
  };
  // Hasta tres pedidos de catálogo a la vez, cada uno con hasta 100 álbumes.
  const runCatalog = async (): Promise<void> => {
    catalogWorkers++;
    try {
      while (catalog.length && live() && Date.now() >= notReadyUntil) {
        const country = catalog[0].country;
        const batch = catalog.filter(ref => ref.country === country).slice(0, playlistLabelLimits.catalogBatch);
        catalog = catalog.filter(ref => !batch.includes(ref));
        const owner = controller, started = Date.now();
        let result: unknown;
        try { result = await run(catalogAlbumsScript(country, batch.map(ref => ref.id!))); }
        catch { catalog.unshift(...retryLater(batch, owner, 0)); continue; }
        if (owner.signal.aborted) continue;
        // MusicKit todavía no está listo: se vuelve a intentar en el próximo sondeo, sin marcar error.
        if (result === null) { catalog.unshift(...batch); notReadyUntil = Date.now() + 2000; break; }
        const status = statusOf(result);
        if (status !== undefined && status !== 404) {
          if (transient(status)) catalog.unshift(...retryLater(batch, owner, status));
          else { for (const ref of batch) fail(ref.key, owner); diagnostic?.('Sellos de lista: error del catálogo', { álbumes: batch.length, estado: status }); }
          continue;
        }
        backoff = 2000;
        // Sólo una lista real acredita «este álbum no está»; un 404 o una respuesta con otra forma quedan como error reintentable.
        if (!Array.isArray(result)) { for (const ref of batch) fail(ref.key, owner); continue; }
        const byId = new Map(catalogAlbums(result).map(album => [album.id, album]));
        for (const ref of batch) (detailsKeys.has(ref.key) ? resolveDetails : resolve)(ref, byId.get(ref.id!), owner);
        diagnostic?.('Sellos de lista: catálogo', { álbumes: batch.length, encontrados: byId.size, ms: Date.now() - started });
      }
    } finally { catalogWorkers--; }
  };
  const runSearch = async (): Promise<void> => {
    searchWorkers++;
    try {
      while (search.length && live() && searchOpen()) {
        const ref = search.shift()!; const owner = controller;
        let result: unknown;
        try { result = await run(catalogSearchScript(ref.country, primaryArtist(ref.artist!) + ' ' + ref.album!)); }
        catch { if (!owner.signal.aborted) { errors++; search.unshift(...retryLater([ref], owner, 0)); } continue; }
        if (owner.signal.aborted) continue;
        if (result === null) { search.unshift(ref); notReadyUntil = Date.now() + 2000; break; }
        const status = statusOf(result);
        if (status === 429) { lastStatus = status; pauseSearch(ref, owner); break; }
        if (status !== undefined && status !== 404) {
          errors++; lastStatus = status;
          if (transient(status)) search.unshift(...retryLater([ref], owner, status)); else fail(ref.key, owner);
          continue;
        }
        backoff = 2000;
        if (!Array.isArray(result)) { errors++; fail(ref.key, owner); continue; }
        let album = pickSearchedAlbum(result, ref.artist!, ref.album!), empty = !result.length;
        if (!album) {
          // Segundo intento sólo con el nombre del álbum: recopilatorios y créditos de álbum distintos del de la canción.
          let second: unknown;
          try { second = await run(catalogSearchScript(ref.country, ref.album!, 25)); } catch { second = undefined; }
          if (owner.signal.aborted) continue;
          if (statusOf(second) === 429) { lastStatus = 429; pauseSearch(ref, owner); break; }
          if (!Array.isArray(second)) { errors++; fail(ref.key, owner); continue; }
          album = pickSearchedAlbum(second, ref.artist!, ref.album!); empty &&= !second.length;
        }
        searchPause = 60000;
        if (probing) { probing = false; startWorkers(); }
        searched++; if (album) matched++; else if (empty) noResults++; else noMatch++;
        (detailsKeys.has(ref.key) ? resolveDetails : resolve)(ref, album, owner);
      }
    } finally {
      // Lo registra el último buscador en terminar.
      searchWorkers--;
      if (!searchWorkers && !search.length && searched + errors) {
        diagnostic?.('Sellos de lista: búsqueda por nombre', { buscados: searched, encontrados: matched, sinResultados: noResults, sinCoincidencia: noMatch,
          errores: errors, ultimoEstado: lastStatus });
        searched = matched = noResults = noMatch = errors = lastStatus = 0;
      }
    }
  };
  // Con la búsqueda de MusicKit en pausa, un solo buscador iTunes encuentra el ID del álbum y lo pasa al catálogo por ID, que
  // da el sello. Va en segundo plano respecto de Related (itunesIdle); lo que iTunes no encuentra vuelve a la búsqueda de
  // MusicKit, que lo intenta al terminar la pausa. Un error de iTunes pausa sólo este buscador (1, 2, 4… hasta 15 min).
  const itunesOpen = (): boolean => Date.now() < searchPausedUntil && Date.now() >= itunesPausedUntil;
  // Un ID distinto por edición como «sello»: un recopilatorio con varias ediciones queda ambiguo y no se elige.
  const pickItunes = (ref: PlaylistRef, found: AppleAlbumMatch[]): CatalogAlbum | undefined =>
    pickSearchedAlbum(found.map(item => ({ ...item, label: item.id, copyright: '' })), ref.artist!, ref.album!);
  const runItunes = async (): Promise<void> => {
    if (itunesRunning) return; itunesRunning = true;
    let busy = false;
    try {
      while (live() && itunesOpen()) {
        const index = search.findIndex(ref => !itunesTried.has(ref.key));
        if (index < 0) break;
        // Related u otro pedido iTunes en curso: se cede el turno antes de cada búsqueda y se vuelve a probar en el próximo sondeo.
        if (!itunesIdle()) { busy = true; break; }
        // Una búsqueda por vuelta: primero artista principal + álbum; sin coincidencia, sólo el álbum (itunesAlbumOnly).
        const [ref] = search.splice(index, 1); const owner = controller, second = itunesAlbumOnly.has(ref.key);
        let found: AppleAlbumMatch[];
        try { found = await searchAppleAlbums(second ? ref.album! : primaryArtist(ref.artist!) + ' ' + ref.album!, ref.country, owner.signal, second ? 25 : 10); }
        catch {
          if (owner.signal.aborted) continue;
          // Al segundo error seguido con la misma fila, ésta pasa a MusicKit para no trabar a las demás.
          itunesErrors++; const count = (itunesFailures.get(ref.key) ?? 0) + 1;
          if (count >= 2) { itunesFailures.delete(ref.key); itunesTried.add(ref.key); search.push(ref); } else { itunesFailures.set(ref.key, count); search.unshift(ref); }
          diagnostic?.('Sellos de lista: error de iTunes', { esperaMs: itunesPause });
          itunesPausedUntil = Date.now() + itunesPause; itunesPause = Math.min(itunesPause * 2, 15 * 60000);
          break;
        }
        if (owner.signal.aborted) continue;
        itunesPause = 60000; itunesFailures.delete(ref.key);
        const album = pickItunes(ref, found);
        if (!album && !second) { itunesAlbumOnly.add(ref.key); search.unshift(ref); continue; }
        itunesSearched++; itunesTried.add(ref.key); itunesAlbumOnly.delete(ref.key);
        if (album) { itunesMatched++; catalog.push({ ...ref, id: album.id }); startWorkers(); }
        else search.push(ref);
      }
    } finally {
      itunesRunning = false;
      if (!busy && itunesSearched + itunesErrors) {
        diagnostic?.('Sellos de lista: búsqueda iTunes', { buscados: itunesSearched, encontrados: itunesMatched, errores: itunesErrors });
        itunesSearched = itunesMatched = itunesErrors = 0;
      }
    }
  };
  const startWorkers = (): void => {
    if (!live()) return;
    while (catalogWorkers < playlistLabelLimits.catalogWorkers && catalog.length && Date.now() >= notReadyUntil) void runCatalog();
    while (searchWorkers < (probing ? 1 : playlistLabelLimits.searchWorkers) && search.length && searchOpen()) {
      void runSearch();
    }
    if (!itunesRunning && search.length && itunesOpen()) void runItunes();
  };
  // Orden de las colas en cada sondeo: primero lo visible sin sello, después lo visible que sólo espera
  // fecha y género, después lo demás sin sello y al final lo demás de fecha y género. Orden estable dentro de cada grupo.
  const rank = (key: string): number => (hot.has(key) ? 0 : 2) + (detailsKeys.has(key) ? 1 : 0);
  const byRank = <T extends { key: string }>(queue: T[]): T[] => queue.map((item, order) => ({ item, order, rank: rank(item.key) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order).map(entry => entry.item);
  const prioritize = (): void => { catalog = byRank(catalog); search = byRank(search); musicBrainz = byRank(musicBrainz); };
  // Temas de la playlist de biblioteca: la primera página sola y, con el total, las
  // demás de a tres a la vez. Cada tema da artista + álbum → ID al índice; al terminar, el sondeo encola por ID lo que
  // esperaba. Un error o una respuesta rara deja la lectura como fallida y las filas siguen con la búsqueda por nombre.
  const loadTracks = async (playlist: string, owner: AbortController): Promise<void> => {
    const started = Date.now(); tracks = { playlist, state: 'loading', started }; tracksTries++;
    let read = 0, linked = 0, status: number | undefined, notReady = false;
    const page = async (offset: number): Promise<PlaylistTracksPage | undefined> => {
      let result: PlaylistTracksPage | number | undefined;
      try { const raw = await run(playlistTracksScript(playlist, offset)); notReady ||= raw === null; result = playlistTracksPage(raw); } catch { result = 0; }
      if (typeof result === 'number') { status = result; return; }
      if (!result || owner.signal.aborted) return;
      read += result.count; linked += result.items.length;
      for (const [artist, album, id] of result.items) index.add(artist, album, id);
      return result;
    };
    const first = await page(0);
    if (first && first.count === playlistTrackLimits.page) {
      if (first.total > first.count) {
        const offsets: number[] = [];
        for (let offset = playlistTrackLimits.page; offset < Math.min(first.total, playlistTrackLimits.page * playlistTrackLimits.pages); offset += playlistTrackLimits.page) offsets.push(offset);
        for (let start = 0; start < offsets.length && !owner.signal.aborted; start += playlistTrackLimits.parallel)
          await Promise.all(offsets.slice(start, start + playlistTrackLimits.parallel).map(page));
      } else if (first.next) {
        for (let offset = playlistTrackLimits.page, last: PlaylistTracksPage | undefined = first; last?.next && last.count === playlistTrackLimits.page && offset < playlistTrackLimits.page * playlistTrackLimits.pages && !owner.signal.aborted; offset += playlistTrackLimits.page)
          last = await page(offset);
      }
    }
    if (owner.signal.aborted || tracks?.playlist !== playlist || controller !== owner) return;
    // MusicKit todavía sin cuenta o sin cargar: se vuelve a probar en el próximo sondeo, hasta cinco veces por página.
    if (!first && notReady && tracksTries < 5) { tracks = undefined; return; }
    tracks = { playlist, state: first ? 'done' : 'failed', started };
    diagnostic?.('Sellos de lista: temas de la playlist', { temas: read, conCatalogo: linked, discos: index.size, ms: Date.now() - started, ...(status !== undefined ? { estado: status } : {}) });
    pollNow();
  };
  // Sondeo a pedido (0.1.50): la página avisa por consola cuando aparecen filas sin sello o hace scroll con datos
  // pendientes; un aviso durante un sondeo deja otro para el final, con 100 ms como mínimo entre uno y otro. El intervalo
  // de 5 s queda de respaldo (antes era la única vía, cada 2 s).
  let again = false, againNow = false, lastPollAt = 0, tracksTries = 0, wakeTimer: NodeJS.Timeout | undefined, waitTimer: NodeJS.Timeout | undefined;
  const requestPoll = (): void => {
    if (stopped) return;
    if (polling) { again = true; return; }
    if (!wakeTimer) wakeTimer = setTimeout(() => { wakeTimer = undefined; void poll(); }, Math.max(0, lastPollAt + 100 - Date.now()));
  };
  // Al terminar la lectura de temas se sondea enseguida, sin el mínimo entre avisos de la página.
  const pollNow = (): void => { if (stopped) return; if (polling) againNow = true; else void poll(); };
  const poll = async (): Promise<void> => {
    if (polling || !live()) return;
    polling = true; lastPollAt = Date.now();
    try {
      const url = contents.getURL(), path = new URL(url).pathname;
      if (path !== pagePath) {
        // Otra página: se descarta lo pendiente; lo ya resuelto queda en caché por clave.
        controller.abort(); controller = new AbortController(); catalog = []; search = []; musicBrainz = []; inflight.clear(); detailsKeys.clear();
        catalogBudget = playlistLabelLimits.catalogPerPage; searchBudget = playlistLabelLimits.searchPerPage;
        musicBrainzBudget = playlistLabelLimits.musicBrainzPerPage; pagePath = path; searched = matched = noResults = noMatch = errors = lastStatus = 0;
        attempts.clear(); backoff = 2000; notReadyUntil = 0; itunesTried.clear(); itunesAlbumOnly.clear(); itunesFailures.clear(); itunesSearched = itunesMatched = itunesErrors = 0;
        pageStarted = Date.now(); fromCache = consulted = 0; reported = false; lastPoll = ''; pollLogs = 0; droppedReported = false;
        index.clear(); tracks = undefined; tracksTries = 0; waiting.clear(); hot = new Set();
      }
      const raw = await run(playlistAlbumsScript), refs = playlistAlbums(raw);
      if (contents.getURL() !== url) return;
      const dropped = Array.isArray(raw) ? Number((raw.find(item => item && typeof item === 'object' && 'dropped' in item) as { dropped?: unknown } | undefined)?.dropped) : 0;
      if (dropped > 0 && !droppedReported) { droppedReported = true; diagnostic?.('Sellos de lista: filas sin país, sin búsqueda por nombre', { filas: dropped }); }
      for (const [artist, album, id] of playlistAliases(raw)) index.add(artist, album, id);
      const playlist = libraryPlaylistOf(url);
      if (playlist && !tracks && tracksTries < 5) void loadTracks(playlist, controller);
      hot = new Set(refs.filter(ref => ref.shown).map(ref => ref.key));
      // Lo que esperaba los temas se vuelve a mirar junto con lo que mandó la página (ésta manda la versión vigente).
      const rows = new Map(refs.map(ref => [ref.key, ref]));
      for (const [key, ref] of waiting) if (!rows.has(key)) rows.set(key, ref);
      waiting.clear();
      const listed = (ref: PlaylistRef): string | undefined => ref.artist && ref.album ? index.find(ref.artist, ref.album) : undefined;
      let byId = 0, byName = 0, byList = 0, byDetails = 0, cacheNow = 0, busy = 0, erred = 0, noBudget = 0;
      for (const ref of rows.values()) {
        const cached = known.get(ref.key);
        if (cached && labelFresh(cached)) {
          known.delete(ref.key); known.set(ref.key, cached);
          // Lo que la página ya muestra no se vuelve a mandar (las filas visibles vienen en cada sondeo, marcadas stored).
          if (!ref.stored) { publish(ref.key, cached.name, cached.link, cached); fromCache++; cacheNow++; }
          // Sin fecha ni género (caché anterior a la versión 5) o sin artistas (anterior a la 7).
          const noDates = !cached.released && !cached.genre, noArtists = cached.artists === undefined;
          if (cached.name && (noDates || noArtists) && !inflight.has(ref.key) && !detailsTried.has(ref.key)) {
            if (detailsTried.size >= 5000) detailsTried.clear();
            // Con ID (de la fila, de la caché o de la lista), por catálogo. Las claves por nombre guardadas antes de que la
            // caché llevara el ID del álbum sin ID en la lista se buscan por nombre como una fila nueva, pero al
            // llegar sólo se agregan el ID, la fecha y el género; el sello visible no cambia. Los artistas
            // sólo se piden por ID: no justifican gastar una búsqueda.
            const own = ref.id ?? cached.id ?? (/^\d{1,20}$/.test(ref.key) ? ref.key : undefined), id = own ?? listed(ref);
            if (id && catalogBudget > 0) { catalogBudget--; detailsKeys.add(ref.key); inflight.add(ref.key); catalog.push({ ...ref, id, ...(own ? {} : { byIndex: true }) }); byDetails++; }
            else if (!id && noDates && ref.key.startsWith('n:') && ref.artist && ref.album) {
              if (tracksPending()) waiting.set(ref.key, ref);
              else if (searchBudget > 0) { searchBudget--; detailsKeys.add(ref.key); inflight.add(ref.key); search.push(ref); byDetails++; }
            }
          }
          continue;
        }
        if (inflight.has(ref.key)) { busy++; continue; }
        if (Date.now() - (failed.get(ref.key) ?? -Infinity) < playlistLabelLimits.retryMs) { erred++; continue; }
        if (ref.id) { if (catalogBudget <= 0) { noBudget++; continue; } catalogBudget--; catalog.push(ref); byId++; }
        else {
          const id = listed(ref);
          if (id) { if (catalogBudget <= 0) { noBudget++; continue; } catalogBudget--; catalog.push({ ...ref, id, byIndex: true }); byList++; }
          // Mientras se leen los temas de la playlist, la fila espera su ID en vez de gastar una búsqueda.
          else if (tracksPending()) { waiting.set(ref.key, ref); continue; }
          else { if (searchBudget <= 0) { noBudget++; continue; } searchBudget--; search.push(ref); byName++; }
        }
        inflight.add(ref.key); consulted++;
      }
      prioritize();
      if (cacheNow) flushNow();
      if (byId || byName || byList || byDetails) diagnostic?.('Sellos de lista: álbumes en cola', { porId: byId, porNombre: byName, ...(byList ? { porLista: byList } : {}), ...(byDetails ? { soloFechaYGenero: byDetails } : {}) });
      if (refs.length && pollLogs < 20) {
        const summary = [refs.length, cacheNow, busy, erred, noBudget, waiting.size].join(',');
        if (summary !== lastPoll) { lastPoll = summary; pollLogs++; diagnostic?.('Sellos de lista: sondeo', { filas: refs.length, desdeCache: cacheNow, enCola: byId + byName + byList, enVuelo: busy, conError: erred, sinPresupuesto: noBudget, esperanTemas: waiting.size, visibles: hot.size }); }
      }
      startWorkers();
      if (!reported && (fromCache || consulted) && !inflight.size && !waiting.size && !catalog.length && !search.length && !musicBrainz.length) {
        reported = true;
        diagnostic?.('Sellos de lista: columna completa', { ms: Date.now() - pageStarted, desdeCache: fromCache, consultados: consulted });
      }
    } catch {
      // Una navegación en curso puede rechazar el sondeo: un aviso por minuto como máximo.
      if (Date.now() - lastFailure > 60000) { lastFailure = Date.now(); onFailure(); }
    }
    finally {
      polling = false;
      if (againNow) { againNow = again = false; void poll(); }
      else if (again) { again = false; requestPoll(); }
      // Filas que esperan los temas: se vuelven a mirar cuando terminan (loadTracks) o al vencer la espera.
      else if (waiting.size && tracks?.state === 'loading' && !waitTimer)
        waitTimer = setTimeout(() => { waitTimer = undefined; requestPoll(); }, Math.max(100, tracks.started + playlistTrackLimits.waitMs - Date.now() + 50));
    }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === playlistLabelsWakeMessage && details.frame === contents.mainFrame) requestPoll();
  };
  contents.on('console-message', wake);
  const timer = setInterval(() => void poll(), 5000);
  contents.once('destroyed', () => {
    stopped = true; clearInterval(timer); if (flushTimer) clearTimeout(flushTimer); if (wakeTimer) clearTimeout(wakeTimer); if (waitTimer) clearTimeout(waitTimer); controller.abort();
    contents.removeListener('console-message', wake);
    if (saveTimer) clearTimeout(saveTimer); save();
  });
  return {
    albumsOfLabel(name: string): KnownLabelAlbums {
      const wanted = labelBaseName(name), ids = new Set<string>(), named = new Map<string, { artist: string; title: string }>();
      if (!wanted) return { ids: [], named: [] };
      for (const [key, entry] of known) {
        if (!entry.name.replace(/^℗ /, '').split(', ').some(part => labelBaseName(part) === wanted)) continue;
        const id = /^\d{1,20}$/.test(key) ? key : entry.id;
        if (id) { ids.add(id); continue; }
        const [artist, title] = key.slice(2).split('\u0001');
        if (artist && title) named.set(key, { artist, title });
      }
      return { ids: [...ids].slice(-200), named: [...named.values()].slice(-50) };
    }
  };
}
