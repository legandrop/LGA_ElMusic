import { createHash } from 'node:crypto';
import { albumRef, isMbid, musicBrainz, publicAlbum, PublicMetadataError } from './labels';
import { lastFmCandidates } from './lastfm';
import { withNetworkRetries } from './network-retry';
import { ApplePublicArtistPage, ApplePublicArtistSong, parseArtistPage } from './apple-public-artists';
import { ApplePublicSearchSong, parseSearchPage } from './apple-public-search';
import { RecommendationCandidate, RecommendationCard, RecommendationDiagnostic, RecommendationMatchDiagnostic, recommendationLimits, RecommendationMode, RecommendationResult, RecommendationSeed } from './recommendation-types';

type Data = Record<string, any>; // Sólo metadatos públicos; la salida hacia la UI tiene campos cerrados.
interface AppleSong { id: string; albumId: string; title: string; artist: string; album: string; durationMs?: number; artworkUrl?: string; artistId?: string; catalogQuery?: string; catalogOrdinal?: number }
interface Candidate extends RecommendationCandidate { appleRows?: AppleSong[] }
interface Match { status: 'matched' | 'missing' | 'ambiguous'; song?: AppleSong; alternativeIds: string[] }
type Diagnostic = ((event: RecommendationDiagnostic) => void) | undefined;
const numeric = /^\d{1,20}$/;
const countryCode = /^[a-z]{2}$/;
const recordingAlgorithm = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30';
const artistAlgorithm = 'session_based_days_7500_session_300_contribution_3_threshold_10_limit_100_filter_True_skip_30';
const durationToleranceMs = 2000; // Parámetro experimental v1: compatibilidad de metadata, nunca identidad acústica.
const userAgent = 'ElMusic (personal music client; https://github.com/legandrop)';
let itunesQueue: Promise<unknown> = Promise.resolve();
let lastItunesRequest = 0;
// Una sola cola iTunes para todo (cuota de 3100 ms). Las búsquedas de la columna Label van en segundo plano: sólo entran
// con la cola vacía y sin pedidos de Related ni del panel de sellos en los últimos 10 s, para no demorarlos.
let itunesPending = 0, lastForegroundItunes = 0;
function itunesTurn<T>(task: () => Promise<T>, background = false): Promise<T> {
  if (!background) lastForegroundItunes = Date.now();
  itunesPending++;
  const operation = itunesQueue.catch(() => {}).then(task).finally(() => { itunesPending--; });
  itunesQueue = operation; return operation;
}
export function itunesIdle(): boolean { return itunesPending === 0 && Date.now() - lastForegroundItunes >= 10000; }
// Cuánto falta para que iTunes vuelva a aceptar pedidos tras un 429 (0 si no hay espera): el panel de un sello espera eso.
export function itunesCooldownMs(): number { return Math.max(0, (cooldowns.get('itunes.apple.com') ?? 0) - Date.now()); }
let labsQueue: Promise<unknown> = Promise.resolve();
let lastLabsRequest = 0;
const cooldowns = new Map<string, number>();
const cache = new Map<string, { result: RecommendationResult; expires: number }>();
interface MetadataCacheEntry { expires: number; bytes: number }
const appleSearchCache = new Map<string, MetadataCacheEntry & { country: string; rows: AppleSong[]; lookup?: true }>();
interface SongPage { canonical: string; albumId?: string; albumUrl?: string; artistId?: string; artistUrl?: string }
const applePageCache = new Map<string, MetadataCacheEntry & SongPage>();
const recordingDurations = new Map<string, MetadataCacheEntry & { milliseconds: number }>();
interface ArtistSeed { id: string; name: string; url: string }
const appleArtistSeeds = new Map<string, MetadataCacheEntry & ArtistSeed>();
const appleArtistPages = new Map<string, MetadataCacheEntry & { page: ApplePublicArtistPage }>();
const applePublicSearchCache = new Map<string, MetadataCacheEntry & { songs: ApplePublicSearchSong[] }>();
const metadataCaches: Map<string, MetadataCacheEntry>[] = [appleSearchCache, applePageCache, recordingDurations, appleArtistSeeds, appleArtistPages, applePublicSearchCache];
let metadataCacheBytes = 0;
const cacheLifetime = 15 * 60 * 1000;
function removeMetadata<T extends MetadataCacheEntry>(entries: Map<string, T>, key: string): void {
  const entry = entries.get(key); if (entry) { metadataCacheBytes -= entry.bytes; entries.delete(key); }
}
function storeMetadata<T extends MetadataCacheEntry>(entries: Map<string, T>, key: string, value: Omit<T, 'bytes' | 'expires'>): void {
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
  removeMetadata(entries, key);
  if (bytes > 100 * 1024 * 1024) return;
  while (entries.size >= 100) removeMetadata(entries, entries.keys().next().value!);
  while (metadataCacheBytes + bytes > 100 * 1024 * 1024) {
    const oldest = metadataCaches.find(entry => entry.size);
    if (!oldest) break;
    removeMetadata(oldest, oldest.keys().next().value!);
  }
  entries.set(key, { ...value, bytes, expires: Date.now() + cacheLifetime } as T); metadataCacheBytes += bytes;
}
function getMetadata<T extends MetadataCacheEntry>(entries: Map<string, T>, key: string): T | undefined {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.expires <= Date.now()) { removeMetadata(entries, key); return; }
  entries.delete(key); entries.set(key, entry); return entry;
}
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > 240 || /[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  try { encodeURIComponent(trimmed); return trimmed; } catch { return ''; }
}
const duration = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 * 60 * 1000 ? value : undefined;
const quoted = (value: string): string => value.replace(/[\\"]/g, '\\$&');
function creditName(item: Data): string {
  if (!Array.isArray(item['artist-credit']) || !item['artist-credit'].length) return '';
  const parts = item['artist-credit'].map((credit: Data): string | undefined => {
    if (!credit || typeof credit !== 'object' || Array.isArray(credit)) return;
    const name = text(Object.hasOwn(credit, 'name') ? credit.name : credit.artist?.name);
    if (!name || credit.joinphrase !== undefined && typeof credit.joinphrase !== 'string') return;
    return name + (credit.joinphrase ?? '');
  });
  return parts.includes(undefined) ? '' : text(parts.join(''));
}
function editorialAlbum(value: string): string {
  return normalized(value).replace(/\s+\((?:deluxe(?: edition| version)?|expanded(?: edition| version)?|bonus tracks?(?: edition| version)?)\)$/, '');
}
function performanceQualifier(value = ''): boolean {
  return /(?:\(|\[)\s*(?:live|acoustic|unplugged|remix(?:ed|es)?|instrumental|karaoke|demo|re[- ]recorded)\b|\b(?:live|acoustic|unplugged|remix(?:es)?|instrumental|karaoke|demo|re[- ]recorded)\s*(?:[\])]|$)|\b(?:live|unplugged|acoustic)\s+(?:at|from|in|on)\b|\bin concert\b/i.test(value);
}
function requestedVersion(candidate: Pick<RecommendationCandidate, 'title' | 'album'>): boolean {
  return performanceQualifier(candidate.title) || performanceQualifier(candidate.album) || /(?:\(|\[|\s-\s)[^\])]*\bremaster(?:ed)?\b/i.test(candidate.title);
}
function sameCandidateSong(candidate: RecommendationCandidate, row: { title: string; artist: string; album?: string }): boolean {
  if (normalized(row.artist) !== normalized(candidate.artist) || normalized(row.title) !== normalized(candidate.title)) return false;
  return requestedVersion(candidate) ? !candidate.album || !row.album || editorialAlbum(row.album) === editorialAlbum(candidate.album) : !performanceQualifier(row.album);
}
function compatibleEditions(rows: AppleSong[], strict: boolean): boolean {
  const unique = [...new Map(rows.map(row => [row.id, row])).values()];
  if (unique.length <= 1) return true;
  if (strict) return new Set(unique.map(row => JSON.stringify([editorialAlbum(row.album), row.durationMs ?? `unknown/${row.id}`]))).size === 1;
  const durations = unique.map(row => row.durationMs);
  return durations.every((value): value is number => value !== undefined) && Math.max(...durations) - Math.min(...durations) <= durationToleranceMs;
}
function empty(): RecommendationResult {
  return { items: [], cards: [], experimental: true, partial: false, lastFmConfigured: false, artistFallback: false, rejected: 0, unresolved: 0, providerUnavailable: false };
}
function appleRef(url: string, country: string, id: string, kind: 'song' | 'artist'): boolean {
  if (url.length > 2048 || !countryCode.test(country) || !numeric.test(id)) return false;
  try {
    const value = new URL(url);
    return value.protocol === 'https:' && value.hostname === 'music.apple.com' && !value.port && !value.username && !value.password && !value.search && !value.hash &&
      new RegExp(`^/${country}/${kind}/(?:[^/]+/)?${id}/?$`).test(value.pathname);
  } catch { return false; }
}
const songRef = (url: string, country: string, id: string): boolean => appleRef(url, country, id, 'song');
export function appleArtworkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'is1-ssl.mzstatic.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/image\/thumb\/Music\d{1,3}\/v4\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/[A-Za-z\d._-]{1,240}\.(?:jpg|png)\/100x100bb\.(?:jpg|png)$/.test(url.pathname)) return;
    return url.href;
  } catch { return; }
}
export function appleArtistId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['music.apple.com', 'itunes.apple.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return;
    return url.pathname.match(/^\/[a-z]{2}\/artist\/(?:[^/]+\/)?(?:id)?(\d{1,20})\/?$/)?.[1];
  } catch { return; }
}
export function seedAlbumsOnArtist(html: string, country: string, id: string, seed: RecommendationSeed): { country: string; id: string }[] {
  const match = html.match(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('PUBLIC_ARTIST_DATA_MISSING');
  const page = JSON.parse(match[1]).data?.[0], descriptor = page?.intent?.contentDescriptor;
  const header = page?.data?.sections?.[0]?.items?.[0];
  if (page?.intent?.$kind !== 'ArtistDetailPageIntent' || descriptor?.kind !== 'artist' || String(descriptor.identifiers?.storeAdamID) !== id || descriptor.locale?.storefront !== country ||
    header?.contentDescriptor?.kind !== 'artist' || String(header.contentDescriptor.identifiers?.storeAdamID) !== id || normalized(text(header.title)) !== normalized(seed.artist) ||
    !appleRef(page.data?.canonicalURL ?? '', country, id, 'artist')) throw new Error('PUBLIC_ARTIST_METADATA_MISMATCH');
  const albums = (Array.isArray(page.data.sections) ? page.data.sections.slice(1, 26) : []).flatMap((section: Data) => Array.isArray(section.items) ? section.items.slice(0, 100) : [])
    .filter((item: Data) => item.contentDescriptor?.kind === 'album' && normalized(text(item.titleLinks?.[0]?.title)) === normalized(seed.album))
    .map((item: Data) => { const ref = albumRef(item.contentDescriptor.url); return ref?.country === country && ref.id === String(item.contentDescriptor.identifiers?.storeAdamID) ? ref : undefined; })
    .filter((ref: { country: string; id: string } | undefined): ref is { country: string; id: string } => !!ref);
  return [...new Map(albums.map((ref: { country: string; id: string }) => [ref.id, ref])).values()].slice(0, 2) as { country: string; id: string }[];
}
async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function query<T>(operation: () => Promise<T>, provider: RecommendationDiagnostic['provider'], stage: RecommendationDiagnostic['stage'],
  signal: AbortSignal, diagnostic: Diagnostic): Promise<T> {
  const emit = (event: RecommendationDiagnostic): void => { try { diagnostic?.(event); } catch { /* Un diagnóstico no interrumpe la consulta musical. */ } };
  for (const attempt of [1, 2] as const) {
    signal.throwIfAborted();
    try {
      const value = await operation(); signal.throwIfAborted();
      emit({ provider, stage, failure: 'ninguno', attempt, outcome: 'respuesta' }); return value;
    } catch (error) {
      signal.throwIfAborted();
      const transport = error instanceof PublicMetadataError ? error : undefined;
      const httpStatus = transport?.kind === 'http' && Number.isInteger(transport.status) && transport.status! >= 100 && transport.status! <= 599 ? transport.status : undefined;
      const failure: RecommendationDiagnostic['failure'] = transport ? transport.kind === 'network' ? 'red' : transport.kind === 'timeout' ? 'tiempo-agotado' :
        transport.kind === 'limit' || httpStatus === 429 ? 'limite' : 'http' : error instanceof SyntaxError ? 'datos-invalidos' :
        error instanceof Error && error.message === 'RECOMMENDATION_RATE_LIMITED' ? 'limite' :
        error instanceof Error && error.message === 'INVALID_RECOMMENDATION_DATASET' ? 'datos-invalidos' :
        error instanceof Error && /^(PUBLIC_|RECOMMENDATION_|ARTIST_IDENTITY_|MB_)/.test(error.message) ? 'validacion' : 'desconocido';
      // Las fallas de red ya se reintentaron abajo (network-retry.ts): acá sólo un tiempo agotado o un 5xx.
      const retry = attempt === 1 && !!transport && (transport.kind === 'timeout' ||
        transport.kind === 'http' && httpStatus !== undefined && [500, 502, 503, 504].includes(httpStatus));
      emit({ provider, stage, ...(httpStatus === undefined ? {} : { httpStatus }), failure, attempt, outcome: retry ? 'reintento' : 'fallo' });
      if (!retry) throw error;
      // El retry conserva la cola del proveedor; MB vuelve a entrar por su única cola global.
      await wait(provider === 'iTunes' ? 3100 : 1100, signal);
    }
  }
  throw new Error('RECOMMENDATION_PROVIDER_UNAVAILABLE');
}
function queryRequest(endpoint: string, parameters: Record<string, string>, stage: RecommendationDiagnostic['stage'], signal: AbortSignal, diagnostic: Diagnostic): Promise<Data> {
  return query(() => musicBrainz(endpoint, parameters, signal), 'MusicBrainz', stage, signal, diagnostic);
}
// Una falla de red se reintenta 3 veces cada 5 s (network-retry.ts); cada intento con su propio tope de 10 s.
function read(url: URL, signal: AbortSignal, body?: string): Promise<string> {
  return withNetworkRetries(() => readOnce(url, signal, body), error => error instanceof PublicMetadataError && error.kind === 'network', { signal });
}
async function readOnce(url: URL, signal: AbortSignal, body?: string): Promise<string> {
  const publicSearch = /^\/(ar|us)\/search$/.test(url.pathname) && [...url.searchParams.keys()].join(',') === 'term' &&
    !!url.searchParams.get('term')?.trim() && url.searchParams.get('term')!.length <= 481 && !/[\u0000-\u001f\u007f]/.test(url.searchParams.get('term')!);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !((url.hostname === 'labs.api.listenbrainz.org' && (body === undefined ? /^\/(?:similar-recordings|similar-artists)\/json$/.test(url.pathname) : url.pathname === '/apple-music-id-from-metadata/json' && !url.search && Buffer.byteLength(body) <= 5 * 1024 * 1024)) ||
      (body === undefined && url.hostname === 'itunes.apple.com' && ['/search', '/lookup'].includes(url.pathname)) ||
      (body === undefined && url.hostname === 'music.apple.com' && (publicSearch || /^\/[a-z]{2}\/(song|artist)\/(?:[^/]+\/)?\d{1,20}\/?$/.test(url.pathname) && !url.search)))) throw new Error('RECOMMENDATION_ENDPOINT_DENIED');
  if ((cooldowns.get(url.hostname) ?? 0) > Date.now()) throw new Error('RECOMMENDATION_RATE_LIMITED');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  let response: Response | undefined;
  try {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      try { response = await fetch(current.href, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body }), credentials: 'omit', redirect: 'manual',
        signal: AbortSignal.any([signal, controller.signal]), headers: { 'User-Agent': userAgent, Accept: url.hostname === 'music.apple.com' ? 'text/html' : 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }); }
      catch { signal.throwIfAborted(); throw new PublicMetadataError(controller.signal.aborted ? 'timeout' : 'network'); }
      if (url.hostname !== 'music.apple.com' || response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location'); const next = location ? new URL(location, current) : undefined;
      const match = url.pathname.match(/^\/([a-z]{2})\/(song|artist)\/(?:[^/]+\/)?(\d+)\/?$/);
      if (redirects >= 3 || !next || (publicSearch ? next.href !== url.href : !match || !appleRef(next.href, match[1], match[3], match[2] as 'song' | 'artist'))) throw new Error('RECOMMENDATION_REDIRECT_DENIED');
      await response.body?.cancel(); current = next;
    }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after'); const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
      const until = seconds === undefined ? retry ? Date.parse(retry) : NaN : Date.now() + seconds * 1000;
      cooldowns.set(url.hostname, Number.isFinite(until) ? Math.max(Date.now() + 1000, until) : Date.now() + 60000);
    }
    if (!response.ok) throw new PublicMetadataError('http', response.status);
    if (!response.body) throw new Error('RECOMMENDATION_PROVIDER_UNAVAILABLE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch { signal.throwIfAborted(); throw new PublicMetadataError(controller.signal.aborted ? 'timeout' : 'network'); }
      if (part.done) break;
      size += part.value.length; if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new PublicMetadataError('limit'); } chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); controller.abort(); try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* Abort cierra la lectura propia. */ } }
}
async function itunes(term: string, country: string, signal: AbortSignal, diagnostic: Diagnostic): Promise<AppleSong[]> {
  const key = JSON.stringify([country, normalized(term)]);
  const cached = getMetadata(appleSearchCache, key);
  if (cached) { signal.throwIfAborted(); return cached.rows.map(row => ({ ...row })); }
  return itunesTurn(async () => {
    const delay = Math.max(0, 3100 - (Date.now() - lastItunesRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastItunesRequest = Date.now();
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term, media: 'music', entity: 'song', country, limit: '50' }).toString();
    const data = await query(async () => { lastItunesRequest = Date.now(); return JSON.parse(await read(url, signal)); }, 'iTunes', 'busqueda-canciones', signal, diagnostic);
    const rows: AppleSong[] = (Array.isArray(data.results) ? data.results.slice(0, 50) : []).flatMap((item: Data, index: number): AppleSong[] => {
      const id = String(item.trackId); const albumId = String(item.collectionId);
      if (item.kind !== 'song' || item.isStreamable === false || !numeric.test(id) || !numeric.test(albumId) || !text(item.trackName) || !text(item.artistName) || !text(item.collectionName)) return [];
      return [{ id, albumId, title: text(item.trackName), artist: text(item.artistName), album: text(item.collectionName), durationMs: duration(item.trackTimeMillis), artworkUrl: appleArtworkUrl(item.artworkUrl100), catalogQuery: normalized(term), catalogOrdinal: index }];
    });
    signal.throwIfAborted();
    if (rows.length) {
      storeMetadata(appleSearchCache, key, { country, rows });
    }
    return rows.map(row => ({ ...row }));
  });
}
function cachedAppleRows(country: string, lookupOnly = false): AppleSong[] {
  const rows = new Map<string, AppleSong>();
  for (const [key, entry] of appleSearchCache) {
    if (entry.expires <= Date.now()) { removeMetadata(appleSearchCache, key); continue; }
    if (entry.country === country && (!lookupOnly || entry.lookup)) for (const row of entry.rows) rows.set(row.id, row);
  }
  return [...rows.values()];
}
async function lookupAppleIds(ids: string[] | (() => string[]), country: string, signal: AbortSignal): Promise<AppleSong[]> {
  // shortcut: el fastpath sólo conoce estos códigos ISO3 observados; otros países conservan Search hasta verificar su contrato.
  const expectedCountry = ({ ar: 'ARG', us: 'USA' } as Record<string, string>)[country];
  if (!expectedCountry) return [];
  return itunesTurn(async (): Promise<AppleSong[]> => {
    const delay = Math.max(0, 3100 - (Date.now() - lastItunesRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted();
    const requested = new Set((typeof ids === 'function' ? ids() : ids).filter(id => numeric.test(id)).slice(0, 200));
    if (!requested.size) return [];
    lastItunesRequest = Date.now();
    const url = new URL('https://itunes.apple.com/lookup');
    url.search = new URLSearchParams({ id: [...requested].join(','), entity: 'song', country, limit: '200' }).toString();
    // Opcional: un único intento, sin retrasar la búsqueda de respaldo con retries.
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
    let data: Data;
    try { data = JSON.parse(await read(url, AbortSignal.any([signal, controller.signal]))); }
    finally { clearTimeout(timer); controller.abort(); }
    signal.throwIfAborted();
    if (!Array.isArray(data.results) || data.results.length > 200) return [];
    return data.results.flatMap((item: Data): AppleSong[] => {
      const id = String(item.trackId), albumId = String(item.collectionId);
      if (!requested.has(id) || item.kind !== 'song' || item.isStreamable !== true || item.country !== expectedCountry || !numeric.test(albumId) ||
        !text(item.trackName) || !text(item.artistName) || !text(item.collectionName) || duration(item.trackTimeMillis) === undefined) return [];
      return [{ id, albumId, title: text(item.trackName), artist: text(item.artistName), album: text(item.collectionName), durationMs: duration(item.trackTimeMillis), artworkUrl: appleArtworkUrl(item.artworkUrl100) }];
    });
  });
}
export interface AppleAlbum { id: string; title: string; artist: string; url: string; artworkUrl?: string; released?: string; genre?: string }
// Disponibilidad regional de hasta 200 álbumes en un solo pedido Lookup (sellos). Misma cola y cuota que
// Related; sólo IDs numéricos y país; la URL del álbum se arma con el ID y el país pedidos, no con la que devuelve Apple.
export async function lookupAppleAlbums(ids: readonly string[], country: string, signal: AbortSignal): Promise<AppleAlbum[]> {
  if (!/^[a-z]{2}$/.test(country)) throw new Error('INVALID_COUNTRY');
  const requested = new Set(ids.filter(id => numeric.test(id)).slice(0, 200));
  if (!requested.size) return [];
  return itunesTurn(async (): Promise<AppleAlbum[]> => {
    const delay = Math.max(0, 3100 - (Date.now() - lastItunesRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastItunesRequest = Date.now();
    const url = new URL('https://itunes.apple.com/lookup');
    url.search = new URLSearchParams({ id: [...requested].join(','), entity: 'album', country, limit: '200' }).toString();
    const data = JSON.parse(await read(url, signal)) as Data;
    signal.throwIfAborted();
    if (!Array.isArray(data.results)) return [];
    const found = new Map<string, AppleAlbum>();
    for (const item of data.results.slice(0, 400)) {
      const id = String(item.collectionId);
      if (item.wrapperType !== 'collection' || !requested.has(id) || found.has(id) || !text(item.collectionName) || !text(item.artistName)) continue;
      const released = typeof item.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.releaseDate) ? item.releaseDate.slice(0, 10) : undefined;
      const genre = text(item.primaryGenreName).slice(0, 80);
      found.set(id, { id, title: text(item.collectionName), artist: text(item.artistName), url: `https://music.apple.com/${country}/album/${id}`,
        artworkUrl: appleArtworkUrl(item.artworkUrl100), released, ...(genre ? { genre } : {}) });
    }
    return [...found.values()];
  });
}
export interface AppleAlbumMatch { id: string; name: string; artist: string; artworkUrl?: string; released?: string; genre?: string }
// Búsqueda pública de álbumes para la columna Label: sólo mientras Apple tiene cortada la
// búsqueda de MusicKit. Devuelve ID, nombre y artista; el sello se lee después del catálogo por ID. También la usa el panel
// de un sello para los discos de MusicBrainz sin enlace a Apple, en primer plano y con portada y fecha.
export async function searchAppleAlbums(term: string, country: string, signal: AbortSignal, limit = 10, background = true): Promise<AppleAlbumMatch[]> {
  const value = term.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  if (!countryCode.test(country) || !value || !Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('INVALID_ALBUM_SEARCH');
  return itunesTurn(async (): Promise<AppleAlbumMatch[]> => {
    const delay = Math.max(0, 3100 - (Date.now() - lastItunesRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastItunesRequest = Date.now();
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: value, media: 'music', entity: 'album', country, limit: String(limit) }).toString();
    const data = JSON.parse(await read(url, signal)) as Data;
    signal.throwIfAborted();
    if (!Array.isArray(data?.results)) return [];
    const found = new Map<string, AppleAlbumMatch>();
    for (const item of data.results.slice(0, limit) as Data[]) {
      const id = String(item?.collectionId);
      if (item?.wrapperType !== 'collection' || !numeric.test(id) || found.has(id) || !text(item.collectionName) || !text(item.artistName)) continue;
      const released = typeof item.releaseDate === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.releaseDate) ? item.releaseDate.slice(0, 10) : undefined;
      const artworkUrl = appleArtworkUrl(item.artworkUrl100), genre = text(item.primaryGenreName).slice(0, 80);
      found.set(id, { id, name: text(item.collectionName), artist: text(item.artistName), ...(artworkUrl ? { artworkUrl } : {}), ...(released ? { released } : {}), ...(genre ? { genre } : {}) });
    }
    return [...found.values()];
  }, background);
}
async function publicSearchSongs(candidate: Candidate, country: string, signal: AbortSignal, diagnostic: Diagnostic): Promise<ApplePublicSearchSong[]> {
  const term = `${candidate.artist} ${candidate.title}`, key = JSON.stringify([country, normalized(term)]);
  const cached = getMetadata(applePublicSearchCache, key);
  if (cached) { signal.throwIfAborted(); return structuredClone(cached.songs); }
  const url = new URL(`https://music.apple.com/${country}/search`); url.searchParams.set('term', term);
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  const combined = AbortSignal.any([signal, controller.signal]);
  try {
    const page = await query(async () => parseSearchPage(await read(url, combined), country, term), 'Apple Music', 'busqueda-canciones', combined, diagnostic);
    signal.throwIfAborted();
    if (page.songs.length) storeMetadata(applePublicSearchCache, key, { songs: structuredClone(page.songs) });
    return page.songs;
  } finally { clearTimeout(timer); controller.abort(); }
}
function publicSearchPlan(country: string, external: AbortSignal, diagnostic: Diagnostic, lookupIds: Set<string>, update: (candidate: Candidate, rows: AppleSong[] | undefined) => void) {
  interface Job { candidate: Candidate; rows: ApplePublicSearchSong[]; done: boolean; complete: () => void }
  const controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]);
  const queued: Job[] = [], waiting = new Set<Job>(), all = new Set<Job>(), completions: Promise<void>[] = [];
  const requests = new Set<Promise<void>>(), batches = new Set<Promise<void>>();
  const metadata = new Map<string, ApplePublicSearchSong>(), conflicted = new Set<string>(), submitted = new Set<string>();
  const pendingIds = new Set<string>(), lookedUp = new Set<string>(), found = new Map<string, AppleSong>();
  const cached = new Map(cachedAppleRows(country, true).map(row => [row.id, row]));
  let searching = 0, outstanding = 0, batchTimer: ReturnType<typeof setTimeout> | undefined, batchActive = false;
  const same = (a: AppleSong, b: ApplePublicSearchSong): boolean => a.id === b.id && a.albumId === b.albumId &&
    normalized(a.title) === normalized(b.title) && normalized(a.artist) === normalized(b.artist) && (!b.album || normalized(a.album) === normalized(b.album));
  const finish = (job: Job, rows?: AppleSong[]): void => {
    if (job.done) return;
    job.done = true; outstanding--; waiting.delete(job);
    try { if (!signal.aborted) update(job.candidate, rows?.length ? rows.map(row => ({ ...row })) : undefined); }
    finally { job.complete(); }
  };
  const resolveWaiting = (): void => {
    for (const job of [...waiting]) if (job.rows.every(row => lookedUp.has(row.id) || conflicted.has(row.id))) {
      const songs = job.rows.flatMap((row, index) => {
        const song = found.get(row.id);
        return !conflicted.has(row.id) && song && same(song, row) && song.durationMs !== undefined ? [{ ...song, artistId: row.artistId, catalogQuery: normalized(`${job.candidate.artist} ${job.candidate.title}`), catalogOrdinal: index }] : [];
      });
      finish(job, songs);
    }
  };
  const flush = (): void => {
    batchTimer = undefined;
    if (signal.aborted || batchActive || !pendingIds.size) return;
    let ids: string[] = []; batchActive = true;
    const operation = (async (): Promise<void> => {
      try {
        const songs = await lookupAppleIds(() => {
          ids = [...pendingIds]; pendingIds.clear(); ids.forEach(id => submitted.add(id)); return ids;
        }, country, signal); signal.throwIfAborted();
        for (const song of songs) {
          const source = metadata.get(song.id);
          if (!source || conflicted.has(song.id) || !same(song, source) || song.durationMs === undefined) continue;
          const bound = { ...song, artistId: source.artistId }; found.set(song.id, bound);
          storeMetadata(appleSearchCache, JSON.stringify([country, 'public-lookup', song.id]), { country, rows: [bound], lookup: true });
        }
      } catch { /* El respaldo por candidata conserva Search si falla este lote opcional. */ }
      finally {
        ids.forEach(id => lookedUp.add(id)); batchActive = false;
        resolveWaiting(); if (!signal.aborted && pendingIds.size) batchTimer = setTimeout(flush, 50);
      }
    })();
    batches.add(operation); void operation.catch(() => {}).finally(() => batches.delete(operation));
  };
  const enqueueLookup = (job: Job, rows: ApplePublicSearchSong[]): void => {
    for (const row of rows) {
      const prior = metadata.get(row.id);
      if (prior && (prior.albumId !== row.albumId || normalized(prior.title) !== normalized(row.title) || normalized(prior.artist) !== normalized(row.artist) ||
        prior.album && row.album && normalized(prior.album) !== normalized(row.album) || prior.artistId !== row.artistId)) { conflicted.add(row.id); found.delete(row.id); continue; }
      if (!lookupIds.has(row.id) && lookupIds.size >= 200) continue;
      lookupIds.add(row.id);
      metadata.set(row.id, row); job.rows.push(row);
      const known = cached.get(row.id);
      if (known && same(known, row) && known.durationMs !== undefined) { found.set(row.id, known); lookedUp.add(row.id); }
      else if (!lookedUp.has(row.id) && !submitted.has(row.id)) pendingIds.add(row.id);
    }
    if (!job.rows.length) { finish(job); return; }
    waiting.add(job); resolveWaiting();
    if (!signal.aborted && pendingIds.size && !batchActive && batchTimer === undefined) batchTimer = setTimeout(flush, 50);
  };
  const pump = (): void => {
    while (!signal.aborted && searching < 3 && queued.length) {
      const job = queued.shift()!; searching++;
      const operation = (async (): Promise<void> => {
        try {
          const rows = await publicSearchSongs(job.candidate, country, signal, diagnostic); signal.throwIfAborted();
          const compatible = rows.filter(row => sameCandidateSong(job.candidate, row));
          enqueueLookup(job, compatible);
        } catch { finish(job); }
        finally { searching--; pump(); }
      })();
      requests.add(operation); void operation.catch(() => {}).finally(() => requests.delete(operation));
    }
  };
  const abort = (): void => {
    if (batchTimer !== undefined) clearTimeout(batchTimer); batchTimer = undefined; pendingIds.clear(); queued.length = 0;
    for (const job of all) finish(job);
  };
  signal.addEventListener('abort', abort, { once: true });
  return {
    add(candidates: Candidate[]): void {
      signal.throwIfAborted();
      for (const candidate of candidates.filter(value => !value.appleRows)) {
        let complete!: () => void; completions.push(new Promise<void>(resolve => { complete = resolve; }));
        const job = { candidate, rows: [], done: false, complete }; all.add(job); queued.push(job); outstanding++;
      }
      pump();
    },
    pending: (): boolean => outstanding > 0,
    async settle(): Promise<void> { await Promise.allSettled(completions); await Promise.allSettled([...requests, ...batches]); },
    close(): void { controller.abort(); signal.removeEventListener('abort', abort); }
  };
}
const metadataKey = (artist: string, title: string, album = ''): string => JSON.stringify([normalized(artist), normalized(title), normalized(album)]);
async function mappedAppleIds(candidates: Candidate[], signal: AbortSignal): Promise<Map<string, string[]>> {
  const inputs = candidates.slice(0, recommendationLimits.candidates).map(candidate => ({ artist_name: candidate.artist, release_name: candidate.album ?? '', track_name: candidate.title }));
  const requested = new Set(inputs.map(item => metadataKey(item.artist_name, item.track_name, item.release_name)));
  const operation = labsQueue.catch(() => {}).then(async (): Promise<Map<string, string[]>> => {
    const delay = Math.max(0, 1100 - (Date.now() - lastLabsRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastLabsRequest = Date.now();
    const data = JSON.parse(await read(new URL('https://labs.api.listenbrainz.org/apple-music-id-from-metadata/json'), signal, JSON.stringify(inputs)));
    signal.throwIfAborted(); const mapped = new Map<string, string[]>();
    if (!Array.isArray(data) || data.length > recommendationLimits.candidates) return mapped;
    for (const item of data) {
      if (!item || !text(item.artist_name) || !text(item.track_name) || typeof item.release_name !== 'string' || item.release_name && !text(item.release_name)) continue;
      const key = metadataKey(item.artist_name, item.track_name, item.release_name);
      if (!requested.has(key) || !Array.isArray(item.apple_music_track_ids)) continue;
      const ids = item.apple_music_track_ids.slice(0, 200).filter((id: unknown): id is string => typeof id === 'string' && numeric.test(id));
      mapped.set(key, [...new Set([...(mapped.get(key) ?? []), ...ids])].slice(0, 200));
    }
    return mapped;
  });
  labsQueue = operation; return operation;
}
export function selectAppleMatch(candidate: RecommendationCandidate, rows: AppleSong[]): Match {
  const candidateDuration = duration(candidate.durationMs);
  const catalog = candidate.source === 'Last.fm' && !requestedVersion(candidate);
  if (candidate.durationMs !== undefined && candidateDuration === undefined) return { status: 'missing', alternativeIds: [] };
  const matches = rows.filter(row => sameCandidateSong(candidate, row) &&
    (catalog ? duration(row.durationMs) !== undefined : candidateDuration === undefined || duration(row.durationMs) !== undefined && Math.abs(row.durationMs! - candidateDuration) <= durationToleranceMs));
  const ids = [...new Map(matches.map(row => [row.id, row])).values()];
  if (!ids.length) return { status: 'missing', alternativeIds: [] };
  const strict = requestedVersion(candidate), clusters: AppleSong[][] = [];
  for (const row of ids.sort((a, b) => (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity) || a.id.localeCompare(b.id))) {
    const cluster = clusters.at(-1);
    if (cluster && compatibleEditions([...cluster, row], strict)) cluster.push(row);
    else clusters.push([row]);
  }
  let group = clusters[0];
  const metadataPreference = (a: AppleSong, b: AppleSong): number => Number(!!candidate.album && normalized(b.album) === normalized(candidate.album)) - Number(!!candidate.album && normalized(a.album) === normalized(candidate.album)) ||
    Number(!!candidate.album && editorialAlbum(b.album) === editorialAlbum(candidate.album)) - Number(!!candidate.album && editorialAlbum(a.album) === editorialAlbum(candidate.album));
  const stableId = (a: AppleSong, b: AppleSong): number => a.id.length - b.id.length || a.id.localeCompare(b.id);
  const ordinal = (row: AppleSong): number => {
    if (!Number.isInteger(row.catalogOrdinal) || row.catalogOrdinal! < 0 || row.catalogOrdinal! >= 200) return 1000;
    return row.catalogQuery === normalized(`${candidate.artist} ${candidate.title}`) ? row.catalogOrdinal! : row.catalogQuery === normalized(candidate.artist) ? 200 + row.catalogOrdinal! : 1000;
  };
  const catalogPreference = (a: AppleSong, b: AppleSong): number => metadataPreference(a, b) ||
    Number(normalized(a.album) !== editorialAlbum(a.album)) - Number(normalized(b.album) !== editorialAlbum(b.album)) || ordinal(a) - ordinal(b) || stableId(a, b);
  if (catalog) {
    // La recomendación LF identifica metadata; su MBID no acredita la edición acústica del catálogo.
    const preferred = [...ids].sort(catalogPreference)[0]; group = clusters.find(cluster => cluster.includes(preferred))!;
  } else if (clusters.length > 1) {
    if (strict || candidateDuration === undefined) return { status: 'ambiguous', alternativeIds: [] };
    const distance = (rows: AppleSong[]): number => Math.min(...rows.map(row => Math.abs(row.durationMs! - candidateDuration)));
    clusters.sort((a, b) => distance(a) - distance(b));
    if (distance(clusters[1]) - distance(clusters[0]) < 1000) return { status: 'ambiguous', alternativeIds: [] };
    group = clusters[0];
  }
  group.sort(catalog ? catalogPreference : (a, b) => metadataPreference(a, b) ||
    (candidateDuration === undefined ? 0 : Math.abs((a.durationMs ?? Infinity) - candidateDuration) - Math.abs((b.durationMs ?? Infinity) - candidateDuration)) ||
    Number(normalized(a.album) !== editorialAlbum(a.album)) - Number(normalized(b.album) !== editorialAlbum(b.album)) || stableId(a, b));
  return { status: 'matched', song: group[0], alternativeIds: group.slice(1).map(row => row.id) };
}
function songPage(html: string, country: string, song: AppleSong): SongPage {
  const match = html.match(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('PUBLIC_SONG_DATA_MISSING');
  const page = JSON.parse(match[1]).data?.[0]; const descriptor = page?.intent?.contentDescriptor; const header = page?.data?.sections?.[0]?.items?.[0];
  const artists = Array.isArray(header?.artistLinks) ? header.artistLinks.map((link: Data) => text(link.title)) : [];
  const artistNames = [text(header?.artists), artists.join(' & '), artists.join(', ')].filter(Boolean);
  if (page?.intent?.$kind !== 'SongDetailPageIntent' || descriptor?.kind !== 'song' || String(descriptor.identifiers?.storeAdamID) !== song.id || descriptor.locale?.storefront !== country ||
    header?.contentDescriptor?.kind !== 'song' || String(header.contentDescriptor.identifiers?.storeAdamID) !== song.id || String(header.contentDescriptor.albumID) !== song.albumId ||
    normalized(text(header.title)) !== normalized(song.title) || !artistNames.some(name => normalized(name) === normalized(song.artist)) || normalized(text(header.album)) !== normalized(song.album) ||
    typeof page.data?.canonicalURL !== 'string' || !songRef(page.data.canonicalURL, country, song.id)) throw new Error('PUBLIC_SONG_METADATA_MISMATCH');
  const linked = (kind: 'artist' | 'album', links: unknown, expectedName: string, expectedId?: string): { id: string; url: string } | undefined => {
    const valid = (Array.isArray(links) ? links.slice(0, 20) : []).flatMap((link: Data) => {
      const descriptor = link?.segue?.destination?.contentDescriptor, id = String(descriptor?.identifiers?.storeAdamID);
      if (descriptor?.kind !== kind || !numeric.test(id) || expectedId && expectedId !== id || normalized(text(link.title)) !== normalized(expectedName)) return [];
      const url = typeof descriptor.url === 'string' ? descriptor.url : '';
      const ref = kind === 'album' ? albumRef(url) : undefined;
      if (kind === 'album' ? ref?.country !== country || ref.id !== id || !!new URL(url).search : !appleRef(url, country, id, 'artist')) return [];
      return [{ id, url }];
    });
    const unique = [...new Map(valid.map(value => [value.id, value])).values()];
    return unique.length === 1 ? unique[0] : undefined;
  };
  const artist = linked('artist', header.artistLinks, song.artist), album = linked('album', header.albumLinks, song.album, song.albumId);
  return { canonical: page.data.canonicalURL, ...(artist ? { artistId: artist.id, artistUrl: artist.url } : {}), ...(album ? { albumId: album.id, albumUrl: album.url } : {}) };
}
export function parsePublicSong(html: string, country: string, song: AppleSong): string { return songPage(html, country, song).canonical; }
async function labs(kind: 'recordings' | 'artists', input: string | string[], signal: AbortSignal, diagnostic: Diagnostic): Promise<Data[]> {
  const ids = [...new Set(Array.isArray(input) ? input : [input])];
  if (!ids.length || ids.length > (kind === 'recordings' ? 10 : 1) || ids.some(id => !isMbid(id))) throw new Error('INVALID_RECOMMENDATION_MBID');
  const operation = labsQueue.catch(() => {}).then(async () => {
    const delay = Math.max(0, 1100 - (Date.now() - lastLabsRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastLabsRequest = Date.now();
    const url = new URL(`https://labs.api.listenbrainz.org/similar-${kind}/json`);
    url.searchParams.set('algorithm', kind === 'recordings' ? recordingAlgorithm : artistAlgorithm);
    for (const id of ids) url.searchParams.append(kind === 'recordings' ? 'recording_mbids' : 'artist_mbids', id);
    return query(async () => {
      lastLabsRequest = Date.now();
      const data = JSON.parse(await read(url, signal));
      if (!Array.isArray(data)) throw new Error('INVALID_RECOMMENDATION_DATASET');
      return data.slice(0, 1000).filter((item: Data) => item && typeof item === 'object' && ids.includes(item.reference_mbid));
    }, 'ListenBrainz', kind === 'recordings' ? 'similares-grabaciones' : 'similares-artistas', signal, diagnostic);
  });
  labsQueue = operation; return operation;
}
async function listenBrainzCandidates(seed: RecommendationSeed, mode: RecommendationMode, signal: AbortSignal, result: RecommendationResult, diagnostic: Diagnostic,
  onCandidates: (candidates: Candidate[]) => Promise<void>): Promise<Candidate[]> {
  if (mode === 'track') {
    const query = `recording:"${quoted(seed.title)}" AND artist:"${quoted(seed.artist)}"${seed.album ? ` AND release:"${quoted(seed.album)}"` : ''}`;
    const data = await queryRequest('recording', { query, limit: '10' }, 'semilla-grabacion', signal, diagnostic);
    const matches: Data[] = (Array.isArray(data.recordings) ? data.recordings.slice(0, 10) : []).filter((item: Data) => isMbid(item.id) && normalized(text(item.title)) === normalized(seed.title) &&
      normalized(creditName(item)) === normalized(seed.artist) &&
      (!seed.album || Array.isArray(item.releases) && item.releases.some((release: Data) => normalized(text(release.title)) === normalized(seed.album))));
    const seedIds = [...new Set(matches.map(item => item.id))] as string[];
    if (Number.isSafeInteger(data.count) && data.count <= 10 && Array.isArray(data.recordings) && data.recordings.length === data.count && seedIds.length) {
      const rows = await labs('recordings', seedIds, signal, diagnostic);
      const candidates: Candidate[] = rows.flatMap((item, rank): Candidate[] => isMbid(item.recording_mbid) && !seedIds.includes(item.recording_mbid) && text(item.recording_name) && text(item.artist_credit_name) ?
        [{ title: text(item.recording_name), artist: text(item.artist_credit_name), album: text(item.release_name) || undefined, recordingMbid: item.recording_mbid,
          source: 'ListenBrainz', signal: 'track', rank, sourceUrl: 'https://labs.api.listenbrainz.org/similar-recordings', algorithm: recordingAlgorithm }] : [])
        .filter((candidate, index, all) => all.findIndex(value => value.recordingMbid === candidate.recordingMbid) === index);
      if (candidates.length) { await onCandidates(candidates); return candidates; }
    }
    result.artistFallback = true;
  }
  const data = await queryRequest('artist', { query: `artist:"${quoted(seed.artist)}"`, limit: '25' }, 'semilla-artista', signal, diagnostic);
  const artists: Data[] = [...new Map((Array.isArray(data.artists) ? data.artists.slice(0, 25) : []).filter((item: Data) => isMbid(item.id) && normalized(text(item.name)) === normalized(seed.artist)).map((item: Data) => [item.id, item])).values()];
  if (!Number.isSafeInteger(data.count) || data.count > 25 || !Array.isArray(data.artists) || data.artists.length !== data.count || !artists.length || artists.length > 3) { result.emptyReason = 'unresolved-seed'; return []; }
  let artistId: string | undefined = artists.length === 1 ? artists[0].id : undefined;
  if (!artistId && seed.album) {
    const corroborated: string[] = [];
    for (const artist of artists) {
      const identity = await query(async () => {
        const identity = await musicBrainz(`artist/${artist.id}`, { inc: 'url-rels' }, signal);
        if (identity.id !== artist.id || normalized(text(identity.name)) !== normalized(seed.artist)) throw new Error('ARTIST_IDENTITY_MISMATCH');
        return identity;
      }, 'MusicBrainz', 'identidad-artista', signal, diagnostic);
      const ids = [...new Set((Array.isArray(identity.relations) ? identity.relations.slice(0, 100) : []).map((relation: Data) => appleArtistId(relation.url?.resource)).filter((id: unknown): id is string => typeof id === 'string'))];
      if (ids.length > 2) { result.emptyReason = 'unresolved-seed'; return []; }
      for (const id of ids) {
        const refs = await query(async () => seedAlbumsOnArtist(await read(new URL(`https://music.apple.com/${seed.country}/artist/${id}`), signal), seed.country, id, seed), 'Apple Music', 'pagina-artista', signal, diagnostic);
        for (const ref of refs) {
          const album = await query(() => publicAlbum(ref, false, signal), 'Apple Music', 'album-semilla', signal, diagnostic);
          if (normalized(album.title) === normalized(seed.album) && normalized(album.artist) === normalized(seed.artist) && album.artistIds.length === 1 && album.artistIds[0] === id) corroborated.push(artist.id);
        }
      }
    }
    if (new Set(corroborated).size === 1) artistId = corroborated[0];
  }
  if (!artistId) { result.emptyReason = 'unresolved-seed'; return []; }
  const related = (await labs('artists', artistId, signal, diagnostic)).filter(item => isMbid(item.artist_mbid) && item.artist_mbid !== artistId && text(item.name))
    .filter((item, index, all) => all.findIndex(other => other.artist_mbid === item.artist_mbid) === index).slice(0, 8);
  const candidates: Candidate[] = [];
  for (const [rank, artist] of related.entries()) {
    try {
      const rows = (await itunes(text(artist.name), seed.country, signal, diagnostic)).filter(row => normalized(row.artist) === normalized(text(artist.name)));
      const titles = [...new Set(rows.map(row => normalized(row.title)))].slice(0, 4);
      for (const title of titles) {
        const matches = rows.filter(row => normalized(row.title) === title);
        candidates.push({ title: matches[0].title, artist: text(artist.name), artistMbid: artist.artist_mbid, appleRows: matches,
          source: 'ListenBrainz', signal: 'artist', rank, sourceUrl: 'https://labs.api.listenbrainz.org/similar-artists', algorithm: artistAlgorithm });
      }
      if (candidates.length) await onCandidates(candidates);
    } catch { signal.throwIfAborted(); result.providerUnavailable = true; }
  }
  return candidates;
}
async function artistSeed(seed: RecommendationSeed, signal: AbortSignal, diagnostic: Diagnostic): Promise<ArtistSeed> {
  return itunesTurn(async (): Promise<ArtistSeed> => {
    const delay = Math.max(0, 3100 - (Date.now() - lastItunesRequest)); if (delay) await wait(delay, signal);
    signal.throwIfAborted(); lastItunesRequest = Date.now();
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({ term: seed.artist, media: 'music', entity: 'musicArtist', country: seed.country, limit: '25' }).toString();
    const data = await query(async () => { lastItunesRequest = Date.now(); return JSON.parse(await read(url, signal)); }, 'iTunes', 'semilla-artista', signal, diagnostic);
    if (!Array.isArray(data.results) || !Number.isSafeInteger(data.resultCount) || data.resultCount !== data.results.length || data.resultCount >= 25) throw new Error('ARTIST_IDENTITY_UNRESOLVED');
    const found = new Map<string, ArtistSeed>();
    for (const row of data.results as Data[]) {
      if (normalized(text(row?.artistName)) !== normalized(seed.artist)) continue;
      const id = String(row.artistId);
      if (row.wrapperType !== 'artist' || row.artistType !== 'Artist' || !numeric.test(id) || id === '0' || typeof row.artistLinkUrl !== 'string' || row.artistLinkUrl.length > 2048) throw new Error('ARTIST_IDENTITY_UNRESOLVED');
      const link = new URL(row.artistLinkUrl);
      if (link.protocol !== 'https:' || !['music.apple.com', 'itunes.apple.com'].includes(link.hostname) || link.username || link.password || link.port || link.hash ||
        [...link.searchParams.keys()].some(key => key !== 'uo') || link.searchParams.has('uo') && (link.searchParams.getAll('uo').length !== 1 || link.searchParams.get('uo') !== '4')) throw new Error('ARTIST_IDENTITY_UNRESOLVED');
      link.search = '';
      if (appleArtistId(link.href) !== id || !new RegExp(`^/${seed.country}/artist/(?:[^/]+/)?(?:id)?${id}/?$`).test(link.pathname)) throw new Error('ARTIST_IDENTITY_UNRESOLVED');
      found.set(id, { id, name: text(row.artistName), url: link.href });
    }
    if (found.size !== 1) throw new Error('ARTIST_IDENTITY_UNRESOLVED');
    return [...found.values()][0];
  });
}
async function artistPage(country: string, artist: ArtistSeed, signal: AbortSignal, diagnostic: Diagnostic): Promise<ApplePublicArtistPage> {
  const key = JSON.stringify([country, artist.id, normalized(artist.name)]), cached = getMetadata(appleArtistPages, key);
  if (cached) { signal.throwIfAborted(); return structuredClone(cached.page); }
  const url = new URL(`https://music.apple.com/${country}/artist/${artist.id}`);
  const page = await query(async () => parseArtistPage(await read(url, signal), country, artist.id, artist.name), 'Apple Music', 'pagina-artista', signal, diagnostic);
  signal.throwIfAborted(); storeMetadata(appleArtistPages, key, { page: structuredClone(page) }); return page;
}
async function appleArtistRecommendations(seed: RecommendationSeed, external: AbortSignal, configured: boolean,
  onProgress: ((result: RecommendationResult) => void) | undefined, diagnostic: Diagnostic): Promise<RecommendationResult | undefined> {
  const controller = new AbortController(), signal = AbortSignal.any([external, controller.signal]);
  let accepting = true, failed = false, progressError: unknown, sourceUrl = '';
  const timer = setTimeout(() => { accepting = false; failed = true; controller.abort(); }, 8000);
  const result = empty(); result.lastFmConfigured = configured;
  type Entry = { song: ApplePublicArtistSong; card: RecommendationCard; item?: RecommendationResult['items'][number] };
  const entries: Entry[] = [], pending: Entry[] = [], active = new Set<Promise<void>>(), seen = new Set<string>();
  let producers: Promise<void>[] = [];
  const publish = (final = false): void => {
    external.throwIfAborted(); if (!accepting && !final) return;
    result.items = entries.flatMap(entry => entry.item ? [entry.item] : []); result.cards = entries.map(entry => ({ ...entry.card }));
    result.unresolved = entries.filter(entry => entry.card.verificationStatus === 'unavailable').length;
    result.providerUnavailable = failed; result.partial = failed || entries.some(entry => entry.card.verificationStatus !== 'verified');
    // Sin un verificado, la primaria es interna y puede descartarse sin mezclar sus previews con el fallback.
    if (result.items.length) try { onProgress?.(structuredClone(result)); } catch (error) { progressError = error; accepting = false; controller.abort(); }
  };
  const pump = (): void => {
    if (!accepting || signal.aborted) return;
    while (pending.length && active.size < 6) {
      const entry = pending.shift()!; entry.card.verificationStatus = 'checking';
      const operation = (async (): Promise<void> => {
        try {
          const song = entry.song;
          if (selectAppleMatch({ ...song, source: 'Apple Music', signal: 'artist', rank: 0, sourceUrl, algorithm: 'public-catalog' }, [song]).status !== 'matched') throw new Error('PUBLIC_SONG_METADATA_MISMATCH');
          const pageKey = JSON.stringify([seed.country, song.id, song.albumId, song.title, song.artist, song.album, song.durationMs]);
          let page: SongPage | undefined = getMetadata(applePageCache, pageKey);
          if (!page) {
            const url = new URL(`https://music.apple.com/${seed.country}/song/${song.id}`);
            page = await query(async () => songPage(await read(url, signal), seed.country, song), 'Apple Music', 'pagina-cancion', signal, diagnostic);
            signal.throwIfAborted();
            if (page.artistId !== song.artistId) throw new Error('PUBLIC_SONG_ARTIST_MISMATCH');
            storeMetadata(applePageCache, pageKey, page);
          }
          signal.throwIfAborted(); if (!accepting) return;
          if (page.artistId !== song.artistId) throw new Error('PUBLIC_SONG_ARTIST_MISMATCH');
          entry.item = { id: song.id, url: page.canonical, title: song.title, artist: song.artist, album: song.album, artworkUrl: song.artworkUrl,
            artistId: page.artistId, artistUrl: page.artistUrl, albumId: page.albumId, albumUrl: page.albumUrl, candidateKey: entry.card.key,
            source: 'Apple Music', signal: 'artist', sourceUrl, matchMethod: 'public-catalog', recordingIdentityVerified: false, editionStatus: 'single', alternativeIds: [] };
          entry.card.verificationStatus = 'verified'; entry.card.verifiedId = song.id;
        } catch {
          if (signal.aborted || !accepting) return;
          failed = true; entry.card.verificationStatus = 'unavailable'; entry.card.reason = 'provider-unavailable';
        }
        if (accepting && !signal.aborted) publish();
      })().finally(() => { active.delete(operation); pump(); });
      active.add(operation); void operation.catch(error => { progressError = error; accepting = false; controller.abort(); });
    }
  };
  try {
    const seedKey = JSON.stringify([seed.country, normalized(seed.artist)]), cached = getMetadata(appleArtistSeeds, seedKey);
    const artist = cached ? { id: cached.id, name: cached.name, url: cached.url } : await artistSeed(seed, signal, diagnostic);
    const page = await artistPage(seed.country, artist, signal, diagnostic); signal.throwIfAborted();
    storeMetadata(appleArtistSeeds, seedKey, artist); sourceUrl = page.canonical;
    const related = page.related.filter(value => value.id !== artist.id).slice(0, 6); let index = 0;
    const worker = async (): Promise<void> => {
      while (index < related.length && accepting && !signal.aborted) {
        const context = related[index++];
        try {
          const data = await artistPage(seed.country, { id: context.id, name: context.name, url: context.url }, signal, diagnostic); signal.throwIfAborted();
          for (const song of data.songs.slice(0, 4)) {
            if (seen.has(song.id) || entries.length >= 24) continue;
            seen.add(song.id);
            const card: RecommendationCard = { key: createHash('sha256').update(JSON.stringify(['public-catalog', seed.country, song.artistId, song.id])).digest('hex').slice(0, 32),
              title: song.title, artist: song.artist, album: song.album, artworkUrl: song.artworkUrl, source: 'Apple Music', signal: 'artist', sourceUrl, verificationStatus: 'pending' };
            const entry: Entry = { song: { ...song }, card }; entries.push(entry); pending.push(entry);
          }
          pump(); publish();
        } catch { if (signal.aborted || !accepting) return; failed = true; }
      }
    };
    producers = Array.from({ length: Math.min(3, related.length) }, worker);
    await Promise.all(producers);
    while (active.size && accepting && !signal.aborted) await Promise.race(active);
  } catch { external.throwIfAborted(); failed = true; }
  finally {
    accepting = false; clearTimeout(timer); controller.abort();
    await Promise.allSettled([...producers, ...active]);
  }
  external.throwIfAborted(); if (progressError !== undefined) throw progressError;
  for (const entry of entries) if (!entry.item) { entry.card.verificationStatus = 'unavailable'; entry.card.reason ??= 'provider-unavailable'; }
  publish(true); if (progressError !== undefined) throw progressError;
  return result.items.length ? structuredClone(result) : undefined;
}
export async function recommendations(seed: RecommendationSeed, mode: RecommendationMode, signal: AbortSignal,
  onProgress?: (result: RecommendationResult) => void, apiKey?: string, onDiagnostic?: (event: RecommendationDiagnostic) => void,
  onMatchDiagnostic?: (event: RecommendationMatchDiagnostic) => void): Promise<RecommendationResult> {
  signal.throwIfAborted();
  if (!seed || !['title', 'artist', 'album'].every(key => typeof seed[key as keyof RecommendationSeed] === 'string' && seed[key as keyof RecommendationSeed].length <= 240) ||
    !text(seed.title) || !text(seed.artist) || seed.album && !text(seed.album) || !countryCode.test(seed.country) || !['track', 'artist'].includes(mode)) throw new Error('INVALID_RECOMMENDATION_SEED');
  const configured = typeof apiKey === 'string' && /^[a-f\d]{32}$/i.test(apiKey);
  const key = JSON.stringify([seed.country, mode, normalized(seed.title), normalized(seed.artist), normalized(seed.album), configured ? createHash('sha256').update(apiKey!).digest('hex') : 'no-key']);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) { cache.delete(key); cache.set(key, existing); const value = structuredClone(existing.result); onProgress?.(structuredClone(value)); return value; }
  if (existing) cache.delete(key);
  if (mode === 'artist') {
    const primary = await appleArtistRecommendations(seed, signal, configured, onProgress, onDiagnostic);
    signal.throwIfAborted();
    if (primary) {
      if (!primary.partial) { if (cache.size >= 100) cache.delete(cache.keys().next().value!); cache.set(key, { result: structuredClone(primary), expires: Date.now() + cacheLifetime }); }
      return primary;
    }
  }
  const result = empty(); result.lastFmConfigured = configured; let lastFmExpires = 0;
  const budget = recommendationLimits.candidates;
  const lists: Candidate[][] = [[], []]; const complete = [false, !result.lastFmConfigured];
  const candidateKey = (candidate: Candidate): string => JSON.stringify([candidate.recordingMbid ?? '', normalized(candidate.artist), normalized(candidate.title)]);
  const cardKey = (candidate: Candidate): string => createHash('sha256').update(candidateKey(candidate)).digest('hex').slice(0, 32);
  const roster: Candidate[] = []; const rosterSources = new Map<string, number>(); const ready = new Set<string>();
  type Outcome = { item?: RecommendationResult['items'][number]; group?: string; rejected?: boolean; unresolved?: boolean; reason?: RecommendationCard['reason'] };
  const outcomes = new Map<string, Outcome>(); const attempted = new Set<string>(); const pending: Candidate[] = [];
  const active = new Set<Promise<void>>(); const groups = new Map<string, Promise<void>>();
  const editionGroups = new Map<string, { rows: AppleSong[]; strict: boolean }>();
  const publicRows = new Map<string, AppleSong[] | undefined>();
  const mbHydrated = new Set<string>(), diagnosed = new Set<string>();
  const observedRows = new Map<string, Map<string, AppleSong>>();
  const observe = (key: string, rows: AppleSong[] | undefined): void => {
    if (!onMatchDiagnostic || !rows?.length) return;
    const observed = observedRows.get(key) ?? new Map<string, AppleSong>();
    for (const row of rows) observed.set(row.id, row);
    observedRows.set(key, observed);
  };
  const diagnose = (candidate: Candidate, status: Match['status']): void => {
    const key = candidateKey(candidate);
    if (!onMatchDiagnostic || signal.aborted || diagnosed.has(key)) return;
    diagnosed.add(key);
    const rows = [...(observedRows.get(key)?.values() ?? [])]; observedRows.delete(key);
    const exact = rows.filter(row => normalized(row.title) === normalized(candidate.title) && normalized(row.artist) === normalized(candidate.artist));
    const safe = exact.filter(row => sameCandidateSong(candidate, row));
    const milliseconds = mbHydrated.has(key) ? duration(candidate.durationMs) : undefined;
    const durations = exact.map(row => duration(row.durationMs)).filter((value): value is number => value !== undefined);
    const event: RecommendationMatchDiagnostic = {
      candidateIndex: roster.indexOf(candidate), hasMbid: isMbid(candidate.recordingMbid), durationSource: milliseconds === undefined ? 0 : 1,
      ...(milliseconds === undefined ? {} : { mbDurationMs: milliseconds }), rowCount: rows.length, exactRowCount: exact.length,
      versionSafeRowCount: safe.length, durationRowCount: safe.filter(row => milliseconds === undefined || row.durationMs !== undefined && Math.abs(row.durationMs - milliseconds) <= durationToleranceMs).length,
      ...(durations.length ? { minAppleDurationMs: Math.min(...durations), maxAppleDurationMs: Math.max(...durations) } : {}),
      status: status === 'missing' ? 0 : status === 'ambiguous' ? 1 : 2,
      selectionPolicy: candidate.source === 'Last.fm' && !requestedVersion(candidate) ? 1 : 0
    };
    try { onMatchDiagnostic(event); } catch { /* El diagnóstico no cambia el resultado musical. */ }
  };
  const lookupIds = new Set<string>();
  const publicPlan = mode === 'track' && ['ar', 'us'].includes(seed.country) ? publicSearchPlan(seed.country, signal, onDiagnostic, lookupIds, (candidate, rows) => {
    observe(candidateKey(candidate), rows);
    publicRows.set(candidateKey(candidate), rows);
    if (!publicPlan?.pending() && !candidates().some(value => directRows(value))) prepareFirstLegacy();
    schedule();
  }) : undefined;
  const directRows = (candidate: Candidate): AppleSong[] | undefined => {
    const rows = publicRows.get(candidateKey(candidate));
    return rows?.length && selectAppleMatch(candidate, rows).status !== 'missing' ? rows : undefined;
  };
  const exactFallback = new Set<string>();
  const preparedSearches = new Map<string, Promise<AppleSong[]>>(); let prefetched = false, firstExactTried = false;
  let firstExactKey: string | undefined;
  const searchRows = (term: string): Promise<AppleSong[]> => {
    const key = normalized(term); let operation = preparedSearches.get(key);
    if (!operation) { operation = itunes(term, seed.country, signal, onDiagnostic); preparedSearches.set(key, operation); void operation.catch(() => {}); }
    return operation;
  };
  const prepareFirstLegacy = (): void => {
    const first = roster.find(candidate => candidateKey(candidate) === firstExactKey && !candidate.appleRows && isMbid(candidate.recordingMbid) && candidate.durationMs === undefined);
    if (!prefetched && first) { prefetched = true; void searchRows(`${first.artist} ${first.title}`).catch(() => {}); }
  };
  const hydrating = new Set<Promise<void>>();
  const mappingStop = new AbortController(); let mappingStarted = false, lookupStarted = false;
  let mappedIds: Map<string, string[]> | undefined; let mappedRows: AppleSong[] = [];
  let draining: Promise<void> | undefined; let drainError: unknown;
  const candidates = (): Candidate[] => roster;
  const publish = (): void => {
    signal.throwIfAborted(); result.items = []; result.cards = []; result.rejected = 0; result.unresolved = 0;
    const found = new Set<string>();
    for (const candidate of candidates()) {
      const outcome = outcomes.get(candidateKey(candidate));
      const card: RecommendationCard = { key: cardKey(candidate), title: candidate.title, artist: candidate.artist, album: candidate.album,
        source: candidate.source, signal: candidate.signal, sourceUrl: candidate.sourceUrl,
        verificationStatus: attempted.has(candidateKey(candidate)) ? 'checking' : 'pending' };
      result.cards.push(card);
      if (!outcome) continue;
      if (outcome.rejected) result.rejected++;
      if (outcome.unresolved) result.unresolved++;
      if (!outcome.item) { card.verificationStatus = 'unavailable'; card.reason = outcome.reason ?? (outcome.rejected ? 'ambiguous' : 'missing'); continue; }
      const item = outcome.item;
      if (found.has(outcome.group!) || result.items.some(value => value.id === item.id)) { result.rejected++; card.verificationStatus = 'unavailable'; card.reason = 'duplicate'; continue; }
      if (result.items.length >= recommendationLimits.verified) { card.verificationStatus = 'unavailable'; card.reason = 'limit'; continue; }
      result.items.push(item); found.add(outcome.group!); card.verificationStatus = 'verified'; card.verifiedId = item.id;
      card.artworkUrl = item.artworkUrl; card.album = item.album;
    }
    if (candidates().length) delete result.emptyReason;
    result.partial = result.providerUnavailable || result.rejected > 0 || result.unresolved > 0 || result.artistFallback || result.cards.some(card => card.verificationStatus === 'unavailable');
    onProgress?.(structuredClone(result));
  };
  const hydrate = async (list: Candidate[]): Promise<void> => {
    const selected = list.slice(0, budget);
    for (const candidate of selected) {
      if (!isMbid(candidate.recordingMbid) || candidate.durationMs !== undefined) continue;
      const entry = getMetadata(recordingDurations, candidateKey(candidate));
      if (entry) { candidate.durationMs = entry.milliseconds; mbHydrated.add(candidateKey(candidate)); }
    }
    const mbids = [...new Set(selected.filter(candidate => candidate.durationMs === undefined).map(candidate => candidate.recordingMbid).filter(isMbid))];
    if (!mbids.length) return;
    try {
      const data = await queryRequest('recording', { query: `rid:(${mbids.join(' OR ')})`, limit: String(mbids.length) }, 'duraciones', signal, onDiagnostic);
      for (const item of (Array.isArray(data.recordings) ? data.recordings : []).slice(0, budget)) for (const candidate of selected) {
        const milliseconds = duration(item.length);
        if (milliseconds !== undefined && candidate.recordingMbid === item.id && normalized(text(item.title)) === normalized(candidate.title) && normalized(creditName(item)) === normalized(candidate.artist)) {
          candidate.durationMs ??= milliseconds; mbHydrated.add(candidateKey(candidate)); signal.throwIfAborted(); storeMetadata(recordingDurations, candidateKey(candidate), { milliseconds });
        }
      }
    } catch { signal.throwIfAborted(); result.providerUnavailable = true; }
  };
  const drain = async (): Promise<void> => {
    while (pending.length) {
      signal.throwIfAborted();
      if (active.size >= 6) await Promise.race(active);
      const candidate = pending.shift()!; const key = candidateKey(candidate);
      if (result.items.length >= recommendationLimits.verified) { outcomes.set(key, { reason: 'limit' }); publish(); continue; }
      try {
        let rows = candidate.appleRows ?? directRows(candidate);
        observe(key, rows);
        if (!rows) {
          const needsExact = (match: Match): boolean => match.status === 'missing' || !candidate.album && !!match.song && normalized(match.song.album) !== editorialAlbum(match.song.album);
          rows = cachedAppleRows(seed.country);
          observe(key, rows);
          if (key === firstExactKey && prefetched && needsExact(selectAppleMatch(candidate, rows))) {
            rows = await searchRows(`${candidate.artist} ${candidate.title}`); signal.throwIfAborted();
            observe(key, rows);
          }
          if (needsExact(selectAppleMatch(candidate, rows)) && mappedIds) {
            if (!lookupStarted) {
              lookupStarted = true;
              const ids = [...new Set([...mappedIds.values()].flat())].filter(id => {
                if (lookupIds.has(id)) return false;
                if (lookupIds.size >= 200) return false;
                lookupIds.add(id); return true;
              }).slice(0, 200);
              if (ids.length >= 2) try { mappedRows = await lookupAppleIds(ids, seed.country, signal); } catch { signal.throwIfAborted(); /* Search conserva su camino normal si falla el batch opcional. */ }
            }
            const allowed = new Set(mappedIds.get(metadataKey(candidate.artist, candidate.title, candidate.album)) ?? []);
            const mapped = mappedRows.filter(row => allowed.has(row.id));
            observe(key, mapped);
            if (selectAppleMatch(candidate, mapped).status !== 'missing') rows = mapped;
          }
          if (needsExact(selectAppleMatch(candidate, rows))) {
            const grouped = candidates().filter(value => normalized(value.artist) === normalized(candidate.artist)).length >= 2;
            const initialExact = key === firstExactKey && !firstExactTried;
            if (initialExact) firstExactTried = true;
            const broad = !initialExact && !exactFallback.has(key) && grouped;
            if (broad) {
              rows = await searchRows(candidate.artist); signal.throwIfAborted();
            } else rows = await searchRows(`${candidate.artist} ${candidate.title}`);
            observe(key, rows);
            if ((broad || initialExact && grouped) && needsExact(selectAppleMatch(candidate, rows))) {
              // Los otros títulos ya presentes no esperan el fallback exacto de éste.
              if (broad) exactFallback.add(key); pending.push(candidate); continue;
            }
          }
        }
        const match = selectAppleMatch(candidate, rows);
        signal.throwIfAborted(); diagnose(candidate, match.status); signal.throwIfAborted();
        if (match.status !== 'matched' || !match.song) { outcomes.set(key, match.status === 'ambiguous' ? { rejected: true, reason: 'ambiguous' } : { unresolved: true, reason: 'missing' }); publish(); continue; }
        const song = match.song;
        const members = rows.filter(row => row.id === song.id || match.alternativeIds.includes(row.id)), strict = requestedVersion(candidate);
        let group = [...editionGroups].find(([, value]) => value.strict === strict && value.rows.every(row => normalized(row.artist) === normalized(song.artist) && normalized(row.title) === normalized(song.title) && selectAppleMatch(candidate, [row]).status === 'matched') &&
          compatibleEditions([...value.rows, ...members], strict))?.[0];
        if (group === undefined) { group = String(editionGroups.size); editionGroups.set(group, { rows: members, strict }); }
        else editionGroups.get(group)!.rows.push(...members);
        const earlier = groups.get(group);
        if (earlier) await earlier;
        signal.throwIfAborted();
        const known = [...outcomes].find(([, value]) => value.item && value.group === group);
        const ordered = candidates(); const currentPosition = ordered.findIndex(value => candidateKey(value) === key);
        const knownPosition = known ? ordered.findIndex(value => candidateKey(value) === known[0]) : -1;
        if (known && knownPosition >= 0 && knownPosition < currentPosition) {
          outcomes.set(key, { group: known[1].group, item: { ...known[1].item!, source: candidate.source, signal: candidate.signal, sourceUrl: candidate.sourceUrl } }); publish(); continue;
        }
        const task = (async (): Promise<void> => {
          try {
            const pageKey = JSON.stringify([seed.country, song.id, song.albumId, song.title, song.artist, song.album, song.durationMs]);
            let page: SongPage | undefined = getMetadata(applePageCache, pageKey);
            if (!page) {
              const url = new URL(`https://music.apple.com/${seed.country}/song/${song.id}`);
              page = await query(async () => songPage(await read(url, signal), seed.country, song), 'Apple Music', 'pagina-cancion', signal, onDiagnostic);
              signal.throwIfAborted(); storeMetadata(applePageCache, pageKey, page);
            }
            if (song.artistId && page.artistId !== song.artistId) throw new Error('PUBLIC_SONG_ARTIST_MISMATCH');
            signal.throwIfAborted();
            outcomes.set(key, { group, item: { id: song.id, url: page.canonical, title: song.title, artist: song.artist, album: song.album, artworkUrl: song.artworkUrl, candidateKey: cardKey(candidate),
              ...(page.artistId && page.artistUrl ? { artistId: page.artistId, artistUrl: page.artistUrl } : {}), ...(page.albumId && page.albumUrl ? { albumId: page.albumId, albumUrl: page.albumUrl } : {}),
              source: candidate.source, signal: candidate.signal, sourceUrl: candidate.sourceUrl, matchMethod: candidate.source === 'Last.fm' && !requestedVersion(candidate) ? 'public-catalog' : 'metadata', recordingIdentityVerified: false,
              editionStatus: match.alternativeIds.length ? 'compatible-editions' : 'single', alternativeIds: match.alternativeIds } });
          } catch { signal.throwIfAborted(); outcomes.set(key, { unresolved: true, reason: 'provider-unavailable' }); result.providerUnavailable = true; }
          publish();
        })();
        active.add(task); groups.set(group, task);
        void task.catch(error => { drainError = error; }).finally(() => active.delete(task));
      } catch { signal.throwIfAborted(); outcomes.set(key, { unresolved: true, reason: 'provider-unavailable' }); result.providerUnavailable = true; publish(); }
    }
  };
  const schedule = (): void => {
    signal.throwIfAborted();
    for (const candidate of candidates()) {
      const key = candidateKey(candidate);
      if (!ready.has(key) || attempted.has(key) || attempted.size >= budget) continue;
      if (publicPlan && !candidate.appleRows) {
        if (!publicRows.has(key)) continue;
        if (!directRows(candidate) && (publicPlan.pending() || candidates().some(value => directRows(value) && !ready.has(candidateKey(value))))) continue;
      }
      attempted.add(key); pending.push(candidate);
    }
    // Una duración tardía recupera su prioridad visible; la consulta que ya tomó drain sigue en vuelo.
    const positions = new Map(candidates().map((candidate, index) => [candidateKey(candidate), index]));
    pending.sort((a, b) => Number(!!directRows(b)) - Number(!!directRows(a)) || positions.get(candidateKey(a))! - positions.get(candidateKey(b))!);
    if (!draining && pending.length) {
      draining = drain().finally(() => { draining = undefined; if (!signal.aborted && pending.length) schedule(); });
      void draining.catch(error => { drainError = error; });
    }
    publish();
  };
  const admit = (): void => {
    signal.throwIfAborted(); const added: Candidate[] = [];
    for (const source of [0, 1]) {
      const byArtist = new Map<string, Candidate[]>();
      for (const candidate of lists[source]) {
        if (!text(candidate.title) || !text(candidate.artist) || normalized(candidate.title) === normalized(seed.title) && normalized(candidate.artist) === normalized(seed.artist)) continue;
        const artist = normalized(candidate.artist); byArtist.set(artist, [...(byArtist.get(artist) ?? []), candidate]);
      }
      const buckets = [...byArtist.values()];
      for (let round = 0; round < budget && roster.length < budget && buckets.some(bucket => round < bucket.length); round++) for (const bucket of buckets) {
        const candidate = bucket[round]; if (!candidate || roster.length >= budget) continue;
        if (!complete[1 - source] && [...rosterSources.values()].filter(value => value === source).length >= budget / 2) break;
        if (roster.some(value => candidateKey(value) === candidateKey(candidate) || normalized(value.title) === normalized(candidate.title) && normalized(value.artist) === normalized(candidate.artist))) continue;
        roster.push(candidate); firstExactKey ??= candidateKey(candidate); rosterSources.set(candidateKey(candidate), source); added.push(candidate);
      }
    }
    // El roster se publica antes de MB/iTunes; ninguna tarjeta provisional autoriza Play ni enlaces Apple.
    publish();
    const unmapped = roster.filter(candidate => !candidate.appleRows);
    if (!mappingStarted && unmapped.length >= 2 && ['ar', 'us'].includes(seed.country)) {
      mappingStarted = true;
      const timer = setTimeout(() => mappingStop.abort(), 2500);
      void mappedAppleIds(unmapped, AbortSignal.any([signal, mappingStop.signal])).then(value => {
        if (!signal.aborted && !mappingStop.signal.aborted) mappedIds = value;
      }).catch(() => {}).finally(() => { clearTimeout(timer); mappingStop.abort(); });
    }
    if (added.length) {
      if (result.items.length >= recommendationLimits.verified) { for (const candidate of added) outcomes.set(candidateKey(candidate), { reason: 'limit' }); publish(); return; }
      const hydration = hydrate(added);
      const operation = hydration.then(() => { signal.throwIfAborted(); for (const candidate of added) ready.add(candidateKey(candidate)); schedule(); });
      hydrating.add(operation); void operation.catch(error => { drainError = error; }).finally(() => hydrating.delete(operation));
      if (!publicPlan) prepareFirstLegacy();
      publicPlan?.add(added);
      for (const candidate of added) if (!isMbid(candidate.recordingMbid) || candidate.durationMs !== undefined || candidate.source === 'Last.fm' && !requestedVersion(candidate)) ready.add(candidateKey(candidate));
      schedule();
    }
  };
  let releaseListenBrainz = (): void => {};
  const update = (source: number, values: Candidate[]): Promise<void> => {
    lists[source] = values.slice(0, 100).map(candidate => ({ ...candidate })); admit();
    if (source === 1 && [...rosterSources.values()].includes(1)) releaseListenBrainz();
    return Promise.resolve();
  };
  const source = async (index: number): Promise<void> => {
    try {
      if (index === 0) await listenBrainzCandidates(seed, mode, signal, result, onDiagnostic, values => update(0, values));
      else {
        const response = await lastFmCandidates(seed, mode, apiKey, signal, value => {
          result.artistFallback ||= mode === 'track' && value.candidates.some(candidate => candidate.signal === 'artist');
          void update(1, value.candidates);
        });
        lastFmExpires = response.cacheForMs > 0 ? Date.now() + response.cacheForMs : 0;
        result.providerUnavailable ||= response.unavailable; result.lastFmConfigured = response.configured;
        result.artistFallback ||= mode === 'track' && response.candidates.some(candidate => candidate.signal === 'artist');
        await update(1, response.candidates);
      }
    } catch { signal.throwIfAborted(); result.providerUnavailable = true; }
    finally { if (index === 1) releaseListenBrainz(); if (!signal.aborted) { complete[index] = true; admit(); } }
  };
  // Las fuentes pueden producir y validar canciones antes de que finalice la otra.
  try {
  if (mode === 'track' && configured) {
    let open!: () => void, released = false;
    const gate = new Promise<void>(resolve => { open = resolve; });
    const timer = setTimeout(() => releaseListenBrainz(), 2500);
    releaseListenBrainz = (): void => {
      if (released) return;
      released = true; clearTimeout(timer); signal.removeEventListener('abort', releaseListenBrainz); open();
    };
    signal.addEventListener('abort', releaseListenBrainz, { once: true });
    const lastFm = source(1);
    const listenBrainz = gate.then(() => { signal.throwIfAborted(); return source(0); });
    try { await Promise.all([lastFm, listenBrainz]); }
    finally { releaseListenBrainz(); await Promise.allSettled([lastFm, listenBrainz]); }
  } else await Promise.all([source(0), result.lastFmConfigured ? source(1) : Promise.resolve()]);
  signal.throwIfAborted();
  await publicPlan?.settle(); signal.throwIfAborted();
  await Promise.all(hydrating); signal.throwIfAborted();
  while (draining || pending.length) { if (!draining) schedule(); if (draining) await draining; }
  await Promise.all(active); signal.throwIfAborted(); if (drainError) throw drainError;
  mappingStop.abort();
  publish();
  if (!result.items.length) result.emptyReason = candidates().length ? 'no-apple-matches' : result.emptyReason ?? 'no-candidates';
  const expires = configured ? Math.min(Date.now() + cacheLifetime, lastFmExpires) : Date.now() + cacheLifetime;
  if (expires > Date.now() && result.items.length && !result.providerUnavailable) {
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { result: structuredClone(result), expires });
  }
  return structuredClone(result);
  } finally { mappingStop.abort(); publicPlan?.close(); await publicPlan?.settle(); }
}
