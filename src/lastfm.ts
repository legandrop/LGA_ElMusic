import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withNetworkRetries } from './network-retry';
import { recommendationLimits } from './recommendation-types';
import type { LastFmCandidates, RecommendationCandidate, RecommendationMode, RecommendationSeed } from './recommendation-types';

type PublicData = Record<string, unknown>;
type Method = 'track.getSimilar' | 'artist.getSimilar' | 'artist.getTopTracks';
const endpoint = 'https://ws.audioscrobbler.com/2.0/';
const userAgent = 'ElMusic (personal music client; https://github.com/legandrop)';
const mbidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const cache = new Map<string, { result: LastFmCandidates; expires: number; bytes: number }>();
let cacheBytes = 0;
let queue: Promise<unknown> = Promise.resolve();
let lastStarted = -Infinity;
let pausedUntil = 0;

function object(value: unknown): PublicData { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PublicData : {}; }
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 240 || /[\u0000-\u001f\u007f]/.test(trimmed)) return '';
  try { encodeURIComponent(trimmed); return trimmed; } catch { return ''; }
}
function rows(value: unknown, limit: number): PublicData[] { return (Array.isArray(value) ? value.slice(0, limit) : value ? [value] : []).map(object); }
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function editorialSeedTitle(title: string): string {
  // Sólo amplía la consulta editorial de semilla; nunca modifica versiones ni valida identidad de grabación.
  return title.replace(/\s*(?:\((?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?\)|\[(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?\]|\s-\s(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:19|20)\d{2})?)$/i, '').trim();
}
function scope(value: unknown, artist: string, title?: string): void {
  const attributes = object(object(value)['@attr']);
  for (const [name, expected] of [['artist', artist], ['track', title]] as const) {
    if (expected === undefined || attributes[name] === undefined) continue;
    const actual = text(attributes[name]);
    if (!actual || normalized(actual) !== normalized(expected)) throw new Error('LASTFM_RESPONSE_INVALID');
  }
}
function mbid(value: unknown): string | undefined { return typeof value === 'string' && mbidPattern.test(value) ? value : undefined; }
function cancelled(): DOMException { return new DOMException('Consulta de recomendaciones cancelada.', 'AbortError'); }
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function expiry(headers: Headers): number {
  const control = headers.get('cache-control');
  if (!control || /(?:^|,)\s*(?:no-store|no-cache)(?:\s*(?:=|,|$))/i.test(control)) return 0;
  const match = control.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/i);
  if (!match) return 0;
  const age = Number(headers.get('age') ?? '0');
  if (!Number.isFinite(age) || age < 0) return 0;
  const remaining = Number(match[1]) - age;
  return remaining > 0 ? Date.now() + Math.min(remaining * 1000, 15 * 60 * 1000) : 0;
}
function pause(headers: Headers): void {
  const retry = headers.get('retry-after');
  const seconds = retry !== null && /^\d+$/.test(retry) ? Number(retry) * 1000 : NaN;
  const dateDelay = retry !== null ? Date.parse(retry) - Date.now() : NaN;
  // Espera local conservadora si el servidor no indica plazo; no es una cuota oficial.
  const wait = Number.isFinite(seconds) ? seconds : Number.isFinite(dateDelay) ? dateDelay : 10000;
  pausedUntil = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(1000, wait));
}
// Una falla de red (fetch rechaza con TypeError) se reintenta 3 veces cada 5 s (network-retry.ts); una cancelación o el
// tope de 10 s de cada intento no.
function request(method: Method, parameters: Record<string, string>, apiKey: string, signal?: AbortSignal): Promise<{ data: PublicData; expires: number }> {
  return withNetworkRetries(() => requestOnce(method, parameters, apiKey, signal), error => error instanceof TypeError, { signal });
}
async function requestOnce(method: Method, parameters: Record<string, string>, apiKey: string, signal?: AbortSignal): Promise<{ data: PublicData; expires: number }> {
  if (signal?.aborted) throw cancelled();
  const operation = queue.catch(() => {}).then(async () => {
    if (signal?.aborted) throw cancelled();
    if (Date.now() < pausedUntil) throw new Error('LASTFM_UNAVAILABLE');
    const wait = Math.max(0, 1100 - (performance.now() - lastStarted));
    if (wait) await delay(wait, undefined, { signal });
    if (signal?.aborted) throw cancelled();
    if (Date.now() < pausedUntil) throw new Error('LASTFM_UNAVAILABLE');
    lastStarted = performance.now();
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries({ ...parameters, method, api_key: apiKey, format: 'json', autocorrect: '0' })) url.searchParams.set(name, value);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), 10000);
    let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      response = await abortable(fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: combined,
        headers: { 'User-Agent': userAgent, Accept: 'application/json' } }), combined);
      if (response.status === 429) pause(response.headers);
      // Nunca seguir un redirect que pueda transportar la API key a otro destino.
      if (!response.body) throw new Error('LASTFM_UNAVAILABLE');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await abortable(reader.read(), combined); if (done) break;
        size += value.length; if (size > 5 * 1024 * 1024) throw new Error('LASTFM_BODY_TOO_LARGE'); chunks.push(value);
      }
      const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (data.error !== undefined) {
        if (Number(data.error) === 29) pause(response.headers);
        if ([10, 26].includes(Number(data.error))) throw new Error('LASTFM_KEY_REJECTED');
        throw new Error('LASTFM_UNAVAILABLE');
      }
      if (!response.ok) throw new Error('LASTFM_UNAVAILABLE');
      return { data, expires: expiry(response.headers) };
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* La cancelación ya cierra la lectura. */ } }
      else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  });
  queue = operation;
  return abortable(operation, signal);
}
export async function validateLastFmKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  if (!/^[a-f\d]{32}$/i.test(apiKey)) throw new Error('LASTFM_KEY_REJECTED');
  try {
    const { data } = await request('artist.getTopTracks', { artist: 'Cher', limit: '1' }, apiKey, signal);
    if (!data.toptracks || typeof data.toptracks !== 'object' || Array.isArray(data.toptracks)) throw new Error('LASTFM_UNAVAILABLE');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw cancelled();
    throw new Error(error instanceof Error && error.message === 'LASTFM_KEY_REJECTED' ? 'LASTFM_KEY_REJECTED' : 'LASTFM_UNAVAILABLE');
  }
}

function candidate(row: PublicData, signal: RecommendationMode, rank: number, artistName?: string): RecommendationCandidate | undefined {
  const title = text(row.name); const returnedArtist = text(object(row.artist).name);
  if (artistName && returnedArtist && returnedArtist.normalize('NFKC').toLowerCase() !== artistName.normalize('NFKC').toLowerCase()) return;
  const artist = artistName || returnedArtist;
  if (!title || !artist || [title, artist].some(value => value === '.' || value === '..')) return;
  // Construir sólo enlaces de catálogo públicos; no reenviar URLs arbitrarias del proveedor.
  const sourceUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(title)}`;
  if (sourceUrl.length > 2048) return;
  return { title, artist, recordingMbid: mbid(row.mbid), artistMbid: mbid(object(row.artist).mbid), source: 'Last.fm', signal, rank,
    sourceUrl, algorithm: signal === 'track' ? 'track.getSimilar' : 'artist.getSimilar + artist.getTopTracks' };
}
function removeCache(key: string): void { const entry = cache.get(key); if (entry) { cacheBytes -= entry.bytes; cache.delete(key); } }
function clone(result: LastFmCandidates, cacheForMs: number): LastFmCandidates { return { ...result, cacheForMs, candidates: result.candidates.map(item => ({ ...item })) }; }

export async function lastFmCandidates(seed: RecommendationSeed, mode: RecommendationMode, apiKey: string | undefined, signal?: AbortSignal,
  onCandidates?: (result: LastFmCandidates) => void): Promise<LastFmCandidates> {
  if (signal?.aborted) throw cancelled();
  if (typeof apiKey !== 'string' || !/^[a-f\d]{32}$/i.test(apiKey)) return { candidates: [], configured: false, unavailable: false, cacheForMs: 0 };
  const title = text(seed.title); const artist = text(seed.artist);
  if (!artist || (mode === 'track' && !title) || (mode !== 'track' && mode !== 'artist')) return { candidates: [], configured: true, unavailable: false, cacheForMs: 0 };
  const key = createHash('sha256').update(apiKey).digest('hex') + JSON.stringify([artist, mode === 'track' ? title : '', mode]);
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) { cache.delete(key); cache.set(key, existing); const result = clone(existing.result, existing.expires - Date.now()); onCandidates?.(clone(result, result.cacheForMs)); return result; }
  removeCache(key);
  const candidates: RecommendationCandidate[] = []; const expiries: number[] = []; let unavailable = false;
  const publish = (): void => {
    if (signal?.aborted) throw cancelled();
    const safe = candidates.filter(item => ![item.title, item.artist, item.sourceUrl].some(value => value.toLowerCase().includes(apiKey.toLowerCase())));
    onCandidates?.({ candidates: safe.map(item => ({ ...item })), configured: true, unavailable: false, cacheForMs: 0 });
  };
  try {
    if (mode === 'track') {
      const base = editorialSeedTitle(title);
      for (const queryTitle of [...new Set([title, ...(base && base !== title ? [base] : [])])]) {
        const response = await request('track.getSimilar', { artist, track: queryTitle, limit: String(recommendationLimits.candidates) }, apiKey, signal);
        if (!response.data.similartracks || typeof response.data.similartracks !== 'object' || Array.isArray(response.data.similartracks)) throw new Error('LASTFM_RESPONSE_INVALID');
        scope(response.data.similartracks, artist, queryTitle); expiries.push(response.expires);
        rows(object(response.data.similartracks).track, recommendationLimits.candidates).forEach((row, index) => { const item = candidate(row, 'track', index + 1); if (item) candidates.push(item); });
        if (candidates.length) break;
      }
      if (candidates.length) publish();
    }
    if (!candidates.length) {
      const response = await request('artist.getSimilar', { artist, limit: '8' }, apiKey, signal);
      if (!response.data.similarartists || typeof response.data.similarartists !== 'object' || Array.isArray(response.data.similarartists)) throw new Error('LASTFM_RESPONSE_INVALID');
      scope(response.data.similarartists, artist);
      expiries.push(response.expires);
      const artists = rows(object(response.data.similarartists).artist, 8).filter(row => !!text(row.name));
      for (const related of artists) {
        try {
          const name = text(related.name);
          const top = await request('artist.getTopTracks', { artist: name, limit: '4' }, apiKey, signal);
          if (!top.data.toptracks || typeof top.data.toptracks !== 'object' || Array.isArray(top.data.toptracks)) throw new Error('LASTFM_RESPONSE_INVALID');
          scope(top.data.toptracks, name);
          expiries.push(top.expires);
          for (const row of rows(object(top.data.toptracks).track, 4)) {
            const item = candidate(row, 'artist', candidates.length + 1, name);
            if (item) { item.artistMbid = mbid(related.mbid); candidates.push(item); }
          }
          if (candidates.length) publish();
        } catch (error) {
          if (signal?.aborted) throw cancelled();
          if (error instanceof Error && error.message === 'LASTFM_KEY_REJECTED') throw error;
          unavailable = true;
        }
      }
    }
  } catch {
    if (signal?.aborted) throw cancelled();
    unavailable = true;
  }
  if (signal?.aborted) throw cancelled();
  const expires = unavailable || !expiries.length || expiries.includes(0) ? 0 : Math.min(...expiries);
  const safeCandidates = candidates.filter(item => ![item.title, item.artist, item.sourceUrl].some(value => value.toLowerCase().includes(apiKey.toLowerCase())));
  const result = { candidates: safeCandidates, configured: true, unavailable, cacheForMs: Math.max(0, expires - Date.now()) };
  if (result.cacheForMs > 0) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    while (cache.size >= 100 || (cache.size && cacheBytes + bytes > 100 * 1024 * 1024)) removeCache(cache.keys().next().value!);
    if (bytes <= 100 * 1024 * 1024) { cache.set(key, { result, expires, bytes }); cacheBytes += bytes; }
  }
  return clone(result, result.cacheForMs);
}
