import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';
import { pickSearchedAlbum, primaryArtist } from './album-match';

// Enlaces pegados.
// Con la vista musical en foco, pegar un enlace de Apple Music abre ese disco, tema, artista o playlist con el enrutador de
// Apple (pushState + popstate, como los enlaces propios), en el país de la cuenta. Un enlace de Spotify se resuelve:
// main lee la página pública embed de ese tema, disco o artista (sin cuenta, cookies ni clave) y busca el equivalente en el
// catálogo de Apple con el MusicKit que configuró la página (sólo lectura). Sin coincidencia exacta abre la búsqueda de
// Apple con el título y el artista. La página sólo detecta el pegado y deja el enlace en un dataset; main lo valida con
// reglas cerradas, decide y navega. Nada de biblioteca, cola, reproducción automática, tokens ni historial.

export type AppleKind = 'album' | 'song' | 'artist' | 'playlist' | 'music-video' | 'station' | 'curator' | 'label';
export type SpotifyKind = 'track' | 'album' | 'artist' | 'playlist' | 'episode' | 'show';
export interface AppleLink { source: 'apple'; kind: AppleKind; id: string; slug?: string; song?: string; country?: string }
export interface SpotifyLink { source: 'spotify'; kind: SpotifyKind; id: string }
export interface SpotifyShortLink { source: 'spotify-short'; url: string }
export type SharedLink = AppleLink | SpotifyLink | SpotifyShortLink;

const appleHosts = new Set(['music.apple.com', 'geo.music.apple.com', 'embed.music.apple.com', 'itunes.apple.com']);
const appleKinds: readonly AppleKind[] = ['album', 'song', 'artist', 'playlist', 'music-video', 'station', 'curator', 'label'];
const numericKinds = new Set<AppleKind>(['album', 'song', 'artist', 'music-video', 'curator', 'label']);
const spotifyKinds: readonly SpotifyKind[] = ['track', 'album', 'artist', 'playlist', 'episode', 'show'];
const country = /^[a-z]{2}$/;
const spotifyId = /^[A-Za-z0-9]{22}$/;

export function parseSharedLink(value: unknown): SharedLink | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text || text.length > 2048 || /[\u0000- \u007f]/.test(text)) return;
  const uri = text.match(/^spotify:(track|album|artist|playlist|episode|show):([A-Za-z0-9]{22})$/);
  if (uri) return { source: 'spotify', kind: uri[1] as SpotifyKind, id: uri[2] };
  let url: URL;
  try { url = new URL(text); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) return;
  const host = url.hostname.toLowerCase();
  if (appleHosts.has(host)) {
    const parts = url.pathname.split('/').filter(Boolean);
    const linkCountry = parts[0] && /^[a-z]{2}$/i.test(parts[0]) ? parts.shift()!.toLowerCase() : undefined;
    const kind = parts[0]?.toLowerCase() as AppleKind;
    if (!appleKinds.includes(kind) || parts.length < 2 || parts.length > 3) return;
    const raw = parts[parts.length - 1];
    const id = numericKinds.has(kind) ? raw.match(/^(?:id)?([1-9]\d{0,19})$/)?.[1]
      : raw.match(kind === 'playlist' ? /^(pl\.[A-Za-z0-9._-]{1,120})$/ : /^(ra\.[A-Za-z0-9._-]{1,120})$/)?.[1];
    if (!id) return;
    const slug = parts.length === 3 && /^[A-Za-z0-9%._~!$&'()*+,;=:@-]{1,240}$/.test(parts[1]) ? parts[1] : undefined;
    const song = kind === 'album' && url.searchParams.getAll('i').length === 1 ? url.searchParams.get('i')!.match(/^[1-9]\d{0,19}$/)?.[0] : undefined;
    return { source: 'apple', kind, id, ...(slug ? { slug } : {}), ...(song ? { song } : {}), ...(linkCountry ? { country: linkCountry } : {}) };
  }
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const match = url.pathname.match(/^(?:\/intl-[a-z]{2}(?:-[a-z]{2,4})?)?(?:\/embed)?\/([a-z]+)\/([A-Za-z0-9]{22})\/?$/i);
    const kind = match?.[1].toLowerCase() as SpotifyKind;
    return match && spotifyKinds.includes(kind) ? { source: 'spotify', kind, id: match[2] } : undefined;
  }
  if ((host === 'spotify.link' || host === 'spoti.fi') && /^\/[A-Za-z0-9]{1,40}\/?$/.test(url.pathname))
    return { source: 'spotify-short', url: `https://${host}${url.pathname.replace(/\/$/, '')}` };
}

// Destino dentro de la vista musical: siempre music.apple.com, con el país de la cuenta y sin la query del enlace (salvo ?i=).
export function appleTarget(link: AppleLink, storefront: string): string {
  if (!country.test(storefront)) throw new Error('INVALID_STOREFRONT');
  return `https://music.apple.com/${storefront}/${link.kind}/${link.slug ? link.slug + '/' : ''}${link.id}${link.song ? '?i=' + link.song : ''}`;
}
// URL de catálogo que devuelve Apple (attributes.url): se acepta sólo si es del país pedido, del mismo tipo y del mismo ID.
export function catalogTarget(value: unknown, storefront: string, kind: AppleKind, id: string, song?: string): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  const link = parseSharedLink(value);
  if (!link || link.source !== 'apple' || link.country !== storefront || !value.startsWith('https://music.apple.com/')) return;
  if (link.kind === kind && link.id === id && (song === undefined || link.song === song)) return appleTarget(link, storefront);
  // Un tema de catálogo vuelve como álbum con ?i=: vale si el ID del tema coincide.
  if (kind === 'song' && link.kind === 'album' && link.song === id) return appleTarget(link, storefront);
}
export function searchTarget(term: string, storefront: string): string {
  if (!country.test(storefront)) throw new Error('INVALID_STOREFRONT');
  return `https://music.apple.com/${storefront}/search?term=${encodeURIComponent([...term.replace(/\s+/g, ' ').trim()].slice(0, 200).join(''))}`;
}

// --- Spotify: datos públicos de la página embed (__NEXT_DATA__) -------------------------------------------------------
type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
function text(value: unknown, max = 240): string {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
export interface SpotifyItem { kind: 'track' | 'album' | 'artist'; name: string; artist: string; artists: string[]; duration: number; year?: string }
export function spotifyEmbedItem(html: unknown, kind: SpotifyKind, id: string): SpotifyItem | undefined {
  if (typeof html !== 'string' || html.length > 4 * 1024 * 1024 || !['track', 'album', 'artist'].includes(kind) || !spotifyId.test(id)) return;
  const scripts = [...html.matchAll(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) return;
  let entity: Data;
  try { entity = object(object(object(object(object(JSON.parse(scripts[0][1])).props).pageProps).state).data).entity as Data; }
  catch { return; }
  entity = object(entity);
  if (entity.type !== kind || (entity.id !== id && entity.uri !== `spotify:${kind}:${id}`)) return;
  const name = text(entity.name) || text(entity.title);
  if (!name) return;
  const listed = Array.isArray(entity.artists) ? entity.artists.slice(0, 10).map(artist => text(object(artist).name)).filter(Boolean) : [];
  const artists = kind === 'artist' ? [name] : listed.length ? listed : text(entity.subtitle) ? [text(entity.subtitle)] : [];
  if (!artists.length) return;
  const duration = kind === 'track' && typeof entity.duration === 'number' && Number.isFinite(entity.duration) && entity.duration > 0 && entity.duration < 36e6 ? Math.round(entity.duration) : 0;
  const year = text(object(entity.releaseDate).isoString).match(/^(\d{4})-/)?.[1];
  return { kind: kind as SpotifyItem['kind'], name, artist: artists.join(', '), artists, duration, ...(year ? { year } : {}) };
}
// Enlace corto (spotify.link / spoti.fi): una redirección a open.spotify.com o, en una página intermedia, un único enlace a
// tema, disco, artista o playlist en el cuerpo.
export function spotifyLinkInBody(html: string): SpotifyLink | undefined {
  const found = new Set([...html.slice(0, 1024 * 1024).matchAll(/https:\/\/open\.spotify\.com\/(track|album|artist|playlist|episode|show)\/([A-Za-z0-9]{22})/g)].map(match => match[1] + '/' + match[2]));
  if (found.size !== 1) return;
  const [kind, id] = [...found][0].split('/');
  return { source: 'spotify', kind: kind as SpotifyKind, id };
}

// --- Elección en el catálogo de Apple ------------------------------------------------------------------------------
export interface AppleCandidate { id: string; name: string; artist: string; album: string; duration: number; url: string }
// Sin acentos, apóstrofos tipográficos ni mayúsculas, como el matcher de álbumes.
const plain = (value: string): string => value.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[‘’´`]/g, '\'').replace(/[“”]/g, '"')
  .toLowerCase().replace(/[\s·,&]+/g, ' ').trim();
const featuring = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi;
// Título completo: sin «(feat. …)» y con el agregado de Spotify « - 2022 Remaster» escrito como Apple, «(2022 Remaster)».
export function fullTitle(value: string): string {
  return plain(value.replace(featuring, '').replace(/\s+-\s+([^-]+)$/, ' ($1)')).replace(/\s+/g, ' ').trim();
}
// Título base: sin ningún agregado entre paréntesis o corchetes (remasters, versiones).
export function coreTitle(value: string): string {
  return fullTitle(value).replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+/g, ' ').trim();
}
// El mismo título base, con su escritura original, para el término de búsqueda.
function searchTitle(value: string): string {
  return value.replace(featuring, '').replace(/\s+-\s+[^-]+$/, '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+/g, ' ').trim() || value;
}
// Artista compartido: el crédito de Apple contiene entero, palabra por palabra, a alguno de los artistas del tema (o al revés).
function sharesArtist(appleArtist: string, artists: readonly string[]): boolean {
  const owner = ` ${plain(appleArtist)} `;
  const parts = artists.map(plain).filter(part => part.length > 1);
  return parts.some(part => owner.includes(` ${part} `) || ` ${part} `.includes(owner));
}
export function appleCandidates(value: unknown): AppleCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 25).filter((item): item is AppleCandidate => !!item && typeof item === 'object' && /^(?:\d{1,20}|pl\.[A-Za-z0-9._-]{1,120})$/.test(String(item.id)) &&
    ['name', 'artist', 'album', 'url'].every(field => typeof item[field] === 'string') && typeof item.duration === 'number' && Number.isFinite(item.duration) && !!item.name.trim());
}
// Tema: mismo título completo y un artista compartido, con duración a 3 s o menos; si no, mismo título base a 2 s o menos.
// Entre varios, la duración más cercana y, a igual distancia, el orden de relevancia de la búsqueda de Apple.
export function pickSong(value: unknown, wanted: { name: string; artists: readonly string[]; duration: number }): AppleCandidate | undefined {
  const candidates = appleCandidates(value).filter(item => sharesArtist(item.artist, wanted.artists));
  const distance = (item: AppleCandidate): number => wanted.duration && item.duration ? Math.abs(item.duration - wanted.duration) : Number.POSITIVE_INFINITY;
  const best = (items: AppleCandidate[]): AppleCandidate | undefined => items.reduce<AppleCandidate | undefined>((chosen, item) => !chosen || distance(item) < distance(chosen) ? item : chosen, undefined);
  const full = fullTitle(wanted.name), core = coreTitle(wanted.name);
  const exact = candidates.filter(item => fullTitle(item.name) === full && (!wanted.duration || !item.duration || distance(item) <= 3000));
  if (exact.length) return best(exact);
  return best(candidates.filter(item => coreTitle(item.name) === core && distance(item) <= 2000));
}
// Disco: la misma elección que la columna Label (nombre exacto o sin «- Single»/«(Deluxe…)», artista compartido); el ID
// como «sello» hace que dos ediciones de un mismo recopilatorio queden ambiguas.
export function pickAlbum(value: unknown, wanted: { name: string; artist: string }): AppleCandidate | undefined {
  const candidates = appleCandidates(value);
  const found = pickSearchedAlbum(candidates.map(item => ({ id: item.id, name: item.name, artist: item.artist, label: item.id, copyright: '' })), wanted.artist, wanted.name);
  if (!found) return;
  // Un recopilatorio pedido como «Various Artists» con dos ediciones del mismo nombre también queda ambiguo.
  const various = (value: string): boolean => /^(?:various artists|varios artistas|artistas varios)$/.test(plain(value));
  if (various(found.artist) && candidates.filter(item => various(item.artist) && plain(item.name) === plain(found.name)).length > 1) return;
  return candidates.find(item => item.id === found.id);
}
// Artista: un único resultado con el mismo nombre; con homónimos queda ambiguo y se abre la búsqueda.
export function pickArtist(value: unknown, name: string): AppleCandidate | undefined {
  const same = appleCandidates(value).filter(item => plain(item.name) === plain(name));
  return same.length === 1 ? same[0] : undefined;
}

// --- Scripts de la página -------------------------------------------------------------------------------------------
const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
export const wakeMessage = 'elMusic.links.ready';
// Pegado: fuera de un campo de texto (o en el buscador de Apple, donde un enlace no sirve) se toma el primer enlace de
// Apple Music o Spotify a un contenido (disco, tema, artista…) del texto pegado, se evita que se pegue y se avisa a main.
// Un campo de texto común no se toca. Cada pegado lleva un número (seq): un pedido anterior ya no navega ni toca el aviso.
export const pasteListenerScript = `(() => {
  ${guard}
  const root = document.documentElement, key = Symbol.for('el-music.shared-links');
  if (root[key]) return true;
  root[key] = true;
  const pattern = /(?:https?:\\/\\/(?:(?:(?:geo\\.|embed\\.)?music\\.apple\\.com|itunes\\.apple\\.com)\\/(?:[a-z]{2}\\/)?(?:album|song|artist|playlist|music-video|station|curator|label)\\/|(?:open|play)\\.spotify\\.com\\/(?:intl-[a-z-]{2,8}\\/)?(?:embed\\/)?(?:track|album|artist|playlist|episode|show)\\/|spotify\\.link\\/|spoti\\.fi\\/)[^\\s<>"'\`]+|spotify:(?:track|album|artist|playlist|episode|show):[A-Za-z0-9]{22})/i;
  document.addEventListener('paste', event => {
    const pasted = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    if (!pasted || pasted.length > 4000) return;
    const match = pasted.match(pattern);
    if (!match) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] instanceof Element ? path[0] : event.target instanceof Element ? event.target : null;
    const field = target ? target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') : null;
    const search = field && field.tagName === 'INPUT' && (field.type === 'search' || !!field.closest('[role="search"], [class*="search"]'));
    if (field && !search) return;
    event.preventDefault(); event.stopImmediatePropagation();
    root.dataset.elMusicSharedLinkSeq = String((Number(root.dataset.elMusicSharedLinkSeq) || 0) % 1e9 + 1);
    root.dataset.elMusicSharedLink = match[0].replace(/[).,;:!?\\]]+$/, '').slice(0, 2048);
    console.debug(${JSON.stringify(wakeMessage)});
    // Respuesta inmediata: el aviso con un anillo y la línea de carga salen acá, sin esperar a main. Main los reemplaza con
    // el resultado; si nunca contesta, el aviso se retira solo a los 120 s (Spotify con reintentos puede tardar).
    const seq = root.dataset.elMusicSharedLinkSeq, spotify = !/apple\\.com/i.test(match[0]);
    document.getElementById('el-music-toast')?.remove();
    const box = document.createElement('div'); box.id = 'el-music-toast'; box.className = 'el-music-toast'; box.setAttribute('role', 'status');
    box.dataset.elMusicOwner = 'shared-link:' + seq; box.dataset.elMusicWorking = '1';
    const row = document.createElement('div'), ring = document.createElement('span'); ring.className = 'el-music-toast__spinner'; ring.setAttribute('aria-hidden', 'true');
    row.append(ring, spotify ? 'Finding it on Apple Music…' : 'Opening the Apple Music link…');
    const detail = document.createElement('div'); detail.className = 'el-music-toast__detail'; detail.textContent = spotify ? 'Spotify link' : 'Apple Music link';
    box.append(row, detail); document.body.appendChild(box);
    setTimeout(() => { if (box.isConnected && box.dataset.elMusicWorking === '1') box.remove(); }, 120000);
    dispatchEvent(new CustomEvent('el-music:busy', { detail: { op: 'start', kind: 'paste', owner: 'paste:' + seq, limit: 120000 } }));
  }, true);
  return true;
})()`;
// Toma y consume el enlace. País de la cuenta: la propiedad pública storefrontCountryCode del MusicKit de la página, sólo con
// sesión iniciada (sin sesión vale «us» aunque la página sea /ar/); si no, los enlaces públicos de la
// barra lateral y, por último, la URL.
export const takeLinkScript = `(() => {
  ${guard}
  const root = document.documentElement, link = root.dataset.elMusicSharedLink;
  if (link === undefined) return null;
  delete root.dataset.elMusicSharedLink;
  let storefront = null;
  try {
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    const value = music?.isAuthorized === true ? music.storefrontCountryCode : undefined;
    if (typeof value === 'string' && /^[a-z]{2}$/i.test(value)) storefront = value.toLowerCase();
  } catch { /* Sin MusicKit: queda la barra lateral. */ }
  const sidebar = [...document.querySelectorAll('.navigation a[href]')].map(item => item.getAttribute('href') || '')
    .map(href => href.match(/^(?:https:\\/\\/music\\.apple\\.com)?\\/([a-z]{2})\\/(?:home|new|radio|search|browse)(?:[\\/?#]|$)/)?.[1]).find(Boolean);
  return { link: typeof link === 'string' && link.length <= 2048 ? link : null, storefront: storefront || sidebar || location.pathname.match(/^\\/([a-z]{2})(?:\\/|$)/)?.[1] || null,
    page: location.href, seq: root.dataset.elMusicSharedLinkSeq || null };
})()`;
// Corte por caracteres completos: un emoji partido deja un sustituto suelto y encodeURIComponent lanza.
const cut = (value: string, max: number): string => [...value.replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
const sequence = /^[1-9]\d{0,9}$/;
const kit = `let music;
    try { const kit = globalThis.MusicKit; music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined; } catch { return null; }
    if (typeof music?.api?.music !== 'function') return null;`;
// MusicKit no siempre lanza ante un error: un 429 de búsqueda vuelve como respuesta con status/errors.
const refused = `const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
      if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) return { error: Number.isInteger(code) && code >= 400 ? code : refusal };`;
const failure = `catch (error) { const status = Number(error?.status ?? error?.response?.status ?? error?.errorCode); return { error: Number.isInteger(status) ? status : 0 }; }`;
const fields = `item => ({ id: String(item?.id), name: String(item?.attributes?.name ?? '').slice(0, 240), artist: String(item?.attributes?.artistName ?? '').slice(0, 240),
      album: String(item?.attributes?.albumName ?? '').slice(0, 240), duration: Number(item?.attributes?.durationInMillis) || 0, url: String(item?.attributes?.url ?? '').slice(0, 2048) })`;
const catalogTypes: Partial<Record<AppleKind, string>> = { album: 'albums', song: 'songs', artist: 'artists', playlist: 'playlists', 'music-video': 'music-videos' };
// Un ítem del catálogo (sólo lectura): confirma que existe en el país de la cuenta y da nombre, artista y URL canónica.
export function catalogItemScript(storefront: string, kind: AppleKind, id: string): string {
  const type = catalogTypes[kind];
  if (!country.test(storefront) || !type || !(numericKinds.has(kind) ? /^[1-9]\d{0,19}$/ : /^pl\.[A-Za-z0-9._-]{1,120}$/).test(id)) throw new Error('INVALID_CATALOG_ITEM');
  return `(async () => {
    ${guard}
    ${kit}
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${storefront}/${type}/${id}`)});
      ${refused}
      const data = response?.data?.data;
      return Array.isArray(data) && data.length ? (${fields})(data[0]) : { error: 404 };
    } ${failure}
  })()`;
}
export function catalogSearchScript(storefront: string, term: string, type: 'songs' | 'albums' | 'artists'): string {
  const clean = cut(term, 200);
  if (!country.test(storefront) || !clean || !['songs', 'albums', 'artists'].includes(type)) throw new Error('INVALID_SEARCH');
  const limit = type === 'artists' ? 10 : 25;
  return `(async () => {
    ${guard}
    ${kit}
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${storefront}/search`)}, { term: ${JSON.stringify(clean)}, types: '${type}', limit: ${limit} });
      ${refused}
      const data = response?.data?.results?.${type}?.data;
      return Array.isArray(data) ? data.slice(0, ${limit}).map(${fields}) : [];
    } ${failure}
  })()`;
}
// Navega con el enrutador de Apple sólo si la página sigue donde estaba al pegar y no hubo otro pegado después; cierra
// antes los paneles propios.
export function navigateScript(target: string, expected: string, seq: string): string {
  const link = parseSharedLink(target), search = /^https:\/\/music\.apple\.com\/[a-z]{2}\/search\?term=[^#\s]{1,2000}$/.test(target);
  if (!sequence.test(seq) || !search && !(link?.source === 'apple' && target.startsWith('https://music.apple.com/'))) throw new Error('INVALID_TARGET');
  return `(() => {
    ${guard}
    if (document.documentElement.dataset.elMusicSharedLinkSeq !== ${JSON.stringify(seq)}) return 'stale';
    if (location.href !== ${JSON.stringify(expected)}) return 'moved';
    document.querySelector('#el-music-recommendation-panel [data-close-recommendations]')?.click();
    document.querySelector('#el-music-label-panel:not(.el-music-panel--parked) [data-close-labels]')?.click();
    // El aviso «Opening…/Finding…» deja su lugar a la línea de carga, que sigue la navegación hasta la página nueva.
    const box = document.getElementById('el-music-toast');
    if (box?.dataset.elMusicOwner === ${JSON.stringify('shared-link:' + seq)} && box.dataset.elMusicWorking === '1') box.remove();
    history.pushState(null, '', ${JSON.stringify(target)}); dispatchEvent(new PopStateEvent('popstate', { state: null }));
    return 'opened';
  })()`;
}
// Aviso propio (el mismo del Stream Deck): textContent sin HTML; «hold» es un aviso de trabajo en curso, con anillo, que
// queda hasta el siguiente; si no, se desvanece. Sólo lo muestra el pegado más reciente, y queda marcado con su número
// para que sólo ese pedido lo retire.
export function toastScript(title: string, detail: string, hold: boolean, seq: string): string {
  if (!sequence.test(seq)) throw new Error('INVALID_TOAST');
  return `(() => {
    ${guard}
    if (document.documentElement.dataset.elMusicSharedLinkSeq !== ${JSON.stringify(seq)}) return false;
    document.getElementById('el-music-toast')?.remove();
    const box = document.createElement('div'); box.id = 'el-music-toast'; box.className = 'el-music-toast'; box.setAttribute('role', 'status'); box.dataset.elMusicOwner = ${JSON.stringify('shared-link:' + seq)};
    const row = document.createElement('div'); row.textContent = ${JSON.stringify(cut(title, 160))}; box.appendChild(row);
    ${hold ? `box.dataset.elMusicWorking = '1'; const ring = document.createElement('span'); ring.className = 'el-music-toast__spinner'; ring.setAttribute('aria-hidden', 'true'); row.prepend(ring);` : ''}
    const detail = document.createElement('div'); detail.className = 'el-music-toast__detail'; detail.textContent = ${JSON.stringify(cut(detail, 160))};
    if (detail.textContent) box.appendChild(detail);
    document.body.appendChild(box);
    ${hold ? '' : `setTimeout(() => box.classList.add('el-music-toast--hide'), 2800); setTimeout(() => box.remove(), 3600);`}
    return true;
  })()`;
}
// Retira sólo el aviso de trabajo en curso de ese pegado (nunca el resultado final) y apaga su línea de carga; si el pegado
// ya navegó, la línea es de la navegación y este aviso no la toca.
export function clearToastScript(seq: string): string {
  if (!sequence.test(seq)) throw new Error('INVALID_TOAST');
  return `(() => { ${guard} const box = document.getElementById('el-music-toast');
    if (box?.dataset.elMusicOwner === ${JSON.stringify('shared-link:' + seq)} && box.dataset.elMusicWorking === '1') box.remove();
    dispatchEvent(new CustomEvent('el-music:busy', { detail: { op: 'end', owner: ${JSON.stringify('paste:' + seq)} } })); return true; })()`;
}

// --- Lectura pública de Spotify ------------------------------------------------------------------------------------
const userAgent = 'ElMusic (personal music client; https://github.com/legandrop)';
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const wait = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, milliseconds);
  const stop = (): void => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});
class SpotifyError extends Error { constructor(readonly code: 'network' | 'timeout' | 'http' | 'limit' | 'redirect', readonly status = 0) { super(`SPOTIFY_${code.toUpperCase()}`); } }
// GET sin cookies ni credenciales, redirección manual, 10 s y 2 MB como tope. Un fallo de red se reintenta 3 veces cada 5 s
// (un firewall por aplicación puede bloquear el primer intento hacia un destino nuevo hasta que el usuario lo permite).
export async function readSpotify(url: string, signal: AbortSignal, fetcher: Fetcher = fetch, retryDelay = 5000): Promise<{ status: number; location: string | null; body: string }> {
  const value = new URL(url);
  if (value.protocol !== 'https:' || value.port || value.username || value.password || !['open.spotify.com', 'spotify.link', 'spoti.fi'].includes(value.hostname)) throw new Error('SPOTIFY_ENDPOINT_DENIED');
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    let response: Response | undefined;
    try {
      try { response = await fetcher(value.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([signal, controller.signal]),
        headers: { 'User-Agent': userAgent, Accept: 'text/html' } }); }
      catch { signal.throwIfAborted(); throw new SpotifyError(controller.signal.aborted ? 'timeout' : 'network'); }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (location !== null || !response.ok || !response.body) return { status: response.status, location, body: '' };
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await reader.read(); }
        catch { signal.throwIfAborted(); throw new SpotifyError(controller.signal.aborted ? 'timeout' : 'network'); }
        if (part.done) break;
        size += part.value.length; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new SpotifyError('limit'); } chunks.push(part.value);
      }
      return { status: response.status, location: null, body: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      if (signal.aborted || !(error instanceof SpotifyError) || error.code !== 'network' || attempt >= 3) throw error;
    } finally { clearTimeout(timer); controller.abort(); try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* Abort cierra la lectura propia. */ } }
    await wait(retryDelay, signal);
  }
}
// Enlace corto → tema, disco, artista o playlist: hasta tres saltos entre los hosts de Spotify.
export async function resolveSpotifyShort(url: string, signal: AbortSignal, fetcher: Fetcher = fetch, retryDelay = 5000): Promise<SpotifyLink | undefined> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const response = await readSpotify(current, signal, fetcher, retryDelay);
    if (response.location !== null) {
      let next: URL;
      try { next = new URL(response.location, current); } catch { return; }
      const link = parseSharedLink(next.href);
      if (link?.source === 'spotify') return link;
      if (next.protocol !== 'https:' || !['spotify.link', 'spoti.fi', 'open.spotify.com'].includes(next.hostname)) return;
      current = next.href; continue;
    }
    return response.status === 200 ? spotifyLinkInBody(response.body) : undefined;
  }
}
export async function readSpotifyItem(kind: SpotifyKind, id: string, signal: AbortSignal, fetcher: Fetcher = fetch, retryDelay = 5000): Promise<SpotifyItem | undefined> {
  if (!['track', 'album', 'artist'].includes(kind) || !spotifyId.test(id)) return;
  let url = `https://open.spotify.com/embed/${kind}/${id}`;
  for (let hop = 0; hop < 3; hop++) {
    const response = await readSpotify(url, signal, fetcher, retryDelay);
    if (response.location === null) {
      if (response.status !== 200) throw new SpotifyError('http', response.status);
      return spotifyEmbedItem(response.body, kind, id);
    }
    // Sólo se sigue una redirección a la misma página embed (por ejemplo, con prefijo de idioma).
    let next: URL;
    try { next = new URL(response.location, url); } catch { throw new SpotifyError('redirect'); }
    const link = parseSharedLink(next.href);
    if (next.hostname !== 'open.spotify.com' || !/\/embed\//.test(next.pathname) || link?.source !== 'spotify' || link.kind !== kind || link.id !== id) throw new SpotifyError('redirect');
    url = next.href;
  }
  throw new SpotifyError('redirect');
}

// --- Instalación en la vista musical -------------------------------------------------------------------------------
type Log = (event: string, fields?: Record<string, boolean | number>) => void;
const kindCode: Record<string, number> = { album: 1, song: 2, artist: 3, playlist: 4, 'music-video': 5, station: 6, curator: 7, label: 8, track: 2, episode: 9, show: 9 };
// Un pegado en curso: su número en la página, la página donde se pegó y si todavía está resolviendo (antes de navegar).
interface Request { signal: AbortSignal; seq: string; page: string; resolving: boolean }
export function installSharedLinks(contents: WebContents, log: Log, onFailure: () => void, fetcher: Fetcher = fetch, retryDelay = 5000): void {
  let controller: AbortController | undefined; let current: Request | undefined; let stopped = false; let polling = false; let pendingWake = false;
  const live = (): boolean => !stopped && !contents.isDestroyed() && isMusicPage(contents.getURL());
  const run = async <T>(script: string, milliseconds = 8000): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([contents.mainFrame.executeJavaScript(script) as Promise<T>,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PAGE_TIMEOUT')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  // Un pedido cancelado ya no muestra avisos; la página además rechaza los de un pegado que no es el último.
  const toast = async (request: Request, title: string, detail: string, hold = false): Promise<void> => {
    if (!request.signal.aborted && live()) await run(toastScript(title, detail, hold, request.seq)).catch(() => undefined);
  };
  const clearToast = async (request: Request): Promise<void> => { if (live()) await run(clearToastScript(request.seq)).catch(() => undefined); };
  const navigate = async (request: Request, target: string): Promise<boolean> => {
    if (request.signal.aborted || !live()) return false;
    request.resolving = false;
    const result = await run<string | null>(navigateScript(target, request.page, request.seq)).catch(() => null);
    if (result !== 'opened') { await clearToast(request); return false; }
    return true;
  };
  const search = async (storefront: string, term: string, type: 'songs' | 'albums' | 'artists'): Promise<unknown> => {
    const found = await run<unknown>(catalogSearchScript(storefront, term, type)).catch(() => null);
    return Array.isArray(found) ? found : undefined;
  };
  const describe = (item: AppleCandidate, kind: string): string => kind === 'artist' ? item.name : [item.artist, item.name].filter(Boolean).join(' – ');
  // Equivalente en el catálogo de la cuenta de un tema, disco o artista conocido por nombre (Spotify u otro país de Apple).
  const match = async (storefront: string, kind: 'track' | 'album' | 'artist', item: { name: string; artist: string; artists: readonly string[]; duration: number }, signal: AbortSignal): Promise<{ found?: AppleCandidate; term: string; answered: boolean }> => {
    const artist = primaryArtist(item.artist);
    if (kind === 'artist') {
      const found = await search(storefront, item.name, 'artists');
      return { found: pickArtist(found, item.name), term: item.name, answered: found !== undefined };
    }
    const title = kind === 'track' ? searchTitle(item.name) : item.name;
    const terms = [...new Set([`${title} ${artist}`, kind === 'track' ? `${item.name} ${artist}` : item.name])];
    let answered = false;
    for (const term of terms) {
      if (signal.aborted) break;
      const found = await search(storefront, term, kind === 'track' ? 'songs' : 'albums');
      if (found === undefined) continue;
      answered = true;
      const picked = kind === 'track' ? pickSong(found, item) : pickAlbum(found, item);
      if (picked) return { found: picked, term: terms[0], answered };
    }
    return { term: terms[0], answered };
  };
  const openApple = async (link: AppleLink, storefront: string, request: Request): Promise<number> => {
    const { signal } = request;
    let target = appleTarget(link, storefront);
    const kind: AppleKind = link.song ? 'song' : link.kind, id = link.song ?? link.id;
    if (!catalogTypes[kind]) return await navigate(request, target) ? 1 : 0;
    const item = await run<Record<string, unknown> | null>(catalogItemScript(storefront, kind, id), 5000).catch(() => null);
    if (signal.aborted) return 0;
    const known = appleCandidates(item ? [item] : [])[0];
    const canonical = known && catalogTarget(known.url, storefront, kind, id);
    if (canonical) target = kind === 'song' && link.kind === 'album' && !canonical.includes('?i=') ? appleTarget(link, storefront) : canonical;
    else if (item && item.error === 404 && link.country && link.country !== storefront) {
      // No está en el país de la cuenta: se busca el mismo tema o disco por nombre; si tampoco, se abre el del enlace.
      const original = appleCandidates([await run<unknown>(catalogItemScript(link.country, kind, id), 5000).catch(() => null)])[0];
      if (signal.aborted) return 0;
      const wanted = original && (kind === 'song' || kind === 'album') ? await match(storefront, kind === 'song' ? 'track' : 'album',
        { name: original.name, artist: original.artist, artists: [original.artist], duration: original.duration }, signal) : undefined;
      if (signal.aborted) return 0;
      const found = wanted?.found && catalogTarget(wanted.found.url, storefront, kind, wanted.found.id);
      if (found && await navigate(request, found)) { await toast(request, describe(wanted!.found!, kind), 'Opened the version available in your country'); return 3; }
      if (signal.aborted) return 0;
      if (await navigate(request, appleTarget(link, link.country))) { await toast(request, 'This may not play in your country', `It is not in the Apple Music catalog for ${storefront.toUpperCase()}`); return 4; }
      return 0;
    }
    if (!await navigate(request, target)) return 0;
    if (!canonical && item?.error === 404) { await toast(request, 'This may not play in your country', `It is not in the Apple Music catalog for ${storefront.toUpperCase()}`); return 10; }
    return canonical ? 1 : 2;
  };
  const openSpotify = async (link: SpotifyLink | SpotifyShortLink, storefront: string, request: Request): Promise<number> => {
    const { signal } = request;
    const unsupported = (kind: SpotifyKind): string | undefined => kind === 'playlist' ? 'Spotify playlists can’t be opened here'
      : kind === 'episode' || kind === 'show' ? 'Podcasts can’t be opened here' : undefined;
    if (link.source === 'spotify' && unsupported(link.kind)) { await toast(request, unsupported(link.kind)!, 'Paste the link to a song, album or artist'); return 6; }
    const resolved = link.source === 'spotify-short' ? await resolveSpotifyShort(link.url, signal, fetcher, retryDelay) : link;
    if (signal.aborted) return 0;
    if (!resolved) { await toast(request, 'This Spotify link could not be opened', 'Paste the link to a song, album or artist'); return 5; }
    if (unsupported(resolved.kind)) { await toast(request, unsupported(resolved.kind)!, 'Paste the link to a song, album or artist'); return 6; }
    const item = await readSpotifyItem(resolved.kind, resolved.id, signal, fetcher, retryDelay);
    if (signal.aborted) return 0;
    if (!item) { await toast(request, 'This Spotify link could not be read', 'Try again in a moment'); return 7; }
    const result = await match(storefront, item.kind, item, signal);
    if (signal.aborted) return 0;
    const target = result.found && catalogTarget(result.found.url, storefront, item.kind === 'track' ? 'song' : item.kind, result.found.id);
    if (target && await navigate(request, target)) { await toast(request, describe(result.found!, item.kind), 'Opened from a Spotify link'); return 1; }
    if (signal.aborted) return 0;
    if (await navigate(request, searchTarget(item.kind === 'artist' ? item.name : `${item.name} ${primaryArtist(item.artist)}`, storefront))) {
      await toast(request, result.answered ? 'No exact match on Apple Music' : 'Apple Music search is busy', 'Showing search results instead'); return result.answered ? 8 : 9;
    }
    return 0;
  };
  const handle = async (text: unknown, storefront: unknown, page: unknown, seq: unknown): Promise<void> => {
    const link = parseSharedLink(text);
    if (!link || typeof page !== 'string' || !isMusicPage(page) || typeof seq !== 'string' || !sequence.test(seq)) {
      log('Enlace pegado: no reconocido');
      // La página ya mostró «Opening…»: se reemplaza por el motivo (con un número válido) o se retira la espera.
      if (typeof seq === 'string' && sequence.test(seq) && live()) {
        await run(toastScript('This link could not be opened', 'Paste the link to a song, album or artist', false, seq)).catch(() => undefined);
        await run(clearToastScript(seq)).catch(() => undefined);
      }
      return;
    }
    controller?.abort(); const owner = controller = new AbortController(); const started = Date.now();
    const request: Request = { signal: owner.signal, seq, page, resolving: true }; current = request;
    const account = typeof storefront === 'string' && country.test(storefront) ? storefront : link.source === 'apple' && link.country ? link.country : 'us';
    const source = link.source === 'apple' ? 1 : 2, kind = link.source === 'spotify-short' ? 0 : kindCode[link.kind] ?? 0;
    try {
      const result = link.source === 'apple' ? await openApple(link, account, request) : await openSpotify(link, account, request);
      if (!owner.signal.aborted) log('Enlace pegado', { origen: source, tipo: kind, resultado: result, ms: Date.now() - started, paisDeCuenta: account === storefront });
    } catch (error) {
      if (owner.signal.aborted) return;
      const code = error instanceof SpotifyError ? { network: 1, timeout: 2, http: 3, limit: 4, redirect: 5 }[error.code] : 0;
      log('Enlace pegado: error', { origen: source, tipo: kind, código: code, estado: error instanceof SpotifyError ? error.status : 0 }); onFailure();
      await toast(request, link.source === 'apple' ? 'This link could not be opened' : 'This Spotify link could not be read', 'Try again in a moment');
    } finally {
      if (controller === owner) controller = undefined;
      if (current === request) current = undefined;
      // Siempre se retira el aviso de trabajo de este pegado si sigue en pantalla (un resultado final no se toca, ni el aviso
      // de un pegado más nuevo) y se apaga su línea de carga si no navegó.
      await clearToast(request);
    }
  };
  const poll = async (): Promise<void> => {
    if (polling) { pendingWake = true; return; }
    if (!live()) return;
    polling = true;
    try {
      const taken = await run<{ link: unknown; storefront: unknown; page: unknown; seq: unknown } | null>(takeLinkScript);
      if (taken) void handle(taken.link, taken.storefront, taken.page, taken.seq);
    } catch { /* Navegación en curso: el próximo aviso lo vuelve a leer. */ }
    finally { polling = false; if (pendingWake) { pendingWake = false; void poll(); } }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === wakeMessage && details.frame === contents.mainFrame && live()) void poll();
  };
  const install = (): void => { if (live()) void contents.mainFrame.executeJavaScript(pasteListenerScript).catch(() => log('Enlace pegado: no se pudo preparar el detector')); };
  // Cambiar de pantalla mientras se resuelve cancela el pedido (el enrutador de Apple no recarga el documento). Una vez que
  // el pedido navegó, el cambio de URL es el suyo y no cancela su aviso final.
  const inPage = (_event: Electron.Event, _url: string, isMainFrame: boolean): void => { if (isMainFrame && current?.resolving) controller?.abort(); };
  contents.on('dom-ready', install);
  contents.on('console-message', wake);
  contents.on('did-navigate-in-page', inPage);
  // Respaldo por si el aviso de consola se pierde: el dataset es la autoridad.
  const timer = setInterval(() => void poll(), 1500);
  contents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => { if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) controller?.abort(); });
  contents.once('destroyed', () => { stopped = true; clearInterval(timer); controller?.abort(); contents.removeListener('console-message', wake);
    contents.removeListener('dom-ready', install); contents.removeListener('did-navigate-in-page', inPage); });
}
