import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type { AppleAlbum } from './recommendations';

// Novedades de los artistas de la biblioteca: un panel propio «New releases» con los discos
// publicados en las últimas cuatro semanas por los artistas de su biblioteca, con ▶ para reproducirlos. Autorización
// acotada a «sin automatización de biblioteca»: se LEE la lista de artistas de la biblioteca con la API pública del
// singleton MusicKit que configuró la página oficial (/v1/me/library/artists, de a 100, con el ID de catálogo de cada uno)
// y después se pide al catálogo, por lotes de IDs, la vista pública latest-release de cada artista. Nada se escribe en la
// biblioteca; no se leen tokens, cookies ni propiedades privadas; sin otra instancia MusicKit. El resultado queda en
// new-releases.json (datos pesados) un día: los nombres de los artistas de la biblioteca no salen de la máquina.
// staleMs: una lista de hasta 7 días se muestra al instante mientras se actualiza. libraryInFlight: páginas de la biblioteca
// pedidas a la vez cuando Apple informa el total (meta.total); sin total se sigue el enlace «next» de a una.
export const newReleasesLimits = { artistsPerPage: 100, artistPages: 20, idsPerRequest: 25, inFlight: 3, libraryInFlight: 3, pacingMs: 150, windowDays: 28,
  cacheMs: 24 * 60 * 60 * 1000, staleMs: 7 * 24 * 60 * 60 * 1000, albums: 300, bytes: 2_000_000, timeoutMs: 20000 } as const;

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
const kit = `let music;
    try { const kit = globalThis.MusicKit; music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined; } catch { return null; }
    if (typeof music?.api?.music !== 'function') return null;`;
const refused = `const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
      if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) return { error: Number.isInteger(code) && code >= 400 ? code : refusal };`;
const failure = `catch (error) { const status = Number(error?.status ?? error?.response?.status ?? error?.errorCode); return { error: Number.isInteger(status) ? status : 0 }; }`;

// Una página de artistas de la biblioteca: nombre e ID de catálogo (relación pública «catalog»); more = hay otra página.
export function libraryArtistsScript(offset: number): string {
  if (!Number.isInteger(offset) || offset < 0 || offset > newReleasesLimits.artistsPerPage * newReleasesLimits.artistPages) throw new Error('INVALID_OFFSET');
  return `(async () => {
    ${guard}
    ${kit}
    try {
      const response = await music.api.music('/v1/me/library/artists', { limit: ${newReleasesLimits.artistsPerPage}, offset: ${offset}, include: 'catalog' });
      ${refused}
      const data = response?.data?.data;
      if (!Array.isArray(data)) return { more: false, artists: [] };
      const total = Number(response?.data?.meta?.total);
      return { more: typeof response?.data?.next === 'string', ...(Number.isInteger(total) && total >= 0 ? { total } : {}), artists: data.slice(0, ${newReleasesLimits.artistsPerPage}).map(item => ({
        name: String(item?.attributes?.name ?? '').slice(0, 240), id: String(item?.relationships?.catalog?.data?.[0]?.id ?? '') })) };
    } ${failure}
  })()`;
}
export interface LibraryArtist { id: string; name: string }
export function parseLibraryArtists(value: unknown): { artists: LibraryArtist[]; more: boolean; total?: number; error?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { artists: [], more: false };
  const root = value as { more?: unknown; artists?: unknown; error?: unknown; total?: unknown };
  if ('error' in root) return { artists: [], more: false, error: Number.isInteger(root.error) ? root.error as number : 0 };
  const artists: LibraryArtist[] = [], seen = new Set<string>();
  if (Array.isArray(root.artists)) {
    for (const item of root.artists.slice(0, newReleasesLimits.artistsPerPage)) {
      const artist = item as { id?: unknown; name?: unknown };
      if (!artist || typeof artist.id !== 'string' || !/^\d{1,20}$/.test(artist.id) || typeof artist.name !== 'string' || seen.has(artist.id)) continue;
      seen.add(artist.id); artists.push({ id: artist.id, name: artist.name.replace(/\s+/g, ' ').trim().slice(0, 240) });
    }
  }
  const total = Number.isInteger(root.total) && (root.total as number) >= 0 && (root.total as number) <= 1_000_000 ? root.total as number : undefined;
  return { artists, more: root.more === true, ...(total === undefined ? {} : { total }) };
}

// Último lanzamiento de un lote de artistas de catálogo (vista pública latest-release): sólo los campos del disco.
export function latestReleasesScript(country: string, ids: readonly string[]): string {
  if (!/^[a-z]{2}$/.test(country) || !ids.length || ids.length > newReleasesLimits.idsPerRequest || ids.some(id => !/^\d{1,20}$/.test(id))) throw new Error('INVALID_ARTISTS');
  return `(async () => {
    ${guard}
    ${kit}
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/artists`)}, { ids: ${JSON.stringify(ids.join(','))}, views: 'latest-release' });
      ${refused}
      const data = response?.data?.data;
      return Array.isArray(data) ? data.slice(0, ${newReleasesLimits.idsPerRequest}).map(artist => ({ artist: String(artist?.id),
        albums: (Array.isArray(artist?.views?.['latest-release']?.data) ? artist.views['latest-release'].data : []).slice(0, 3).map(album => ({
          id: String(album?.id), name: String(album?.attributes?.name ?? '').slice(0, 240), artist: String(album?.attributes?.artistName ?? '').slice(0, 240),
          released: String(album?.attributes?.releaseDate ?? ''), genre: (Array.isArray(album?.attributes?.genreNames) ? album.attributes.genreNames.map(String).find(name => !/^(?:music|música|musica|musique|musik)$/i.test(name)) : undefined)?.slice(0, 80),
          artwork: String(album?.attributes?.artwork?.url ?? '').slice(0, 400) })) })) : [];
    } ${failure}
  })()`;
}
const releasedPattern = /^\d{4}-\d{2}-\d{2}$/;
const artworkPattern = /^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\/[A-Za-z0-9._\-\/%]+\/\{w\}x\{h\}bb\.(?:jpg|png|webp)$/;
export function sinceDate(now = Date.now(), days: number = newReleasesLimits.windowDays): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
// Discos del lote publicados entre «since» y «until» (fechas ISO; una preventa con fecha futura no se puede reproducir), sin repetir, con enlace público y portada validada; o el error.
export function parseLatestReleases(value: unknown, country: string, since: string, until = '9999-12-31'): { albums: AppleAlbum[]; error?: number } {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) { const error = (value as { error: unknown }).error; return { albums: [], error: Number.isInteger(error) ? error as number : 0 }; }
  if (!Array.isArray(value) || !/^[a-z]{2}$/.test(country) || !releasedPattern.test(since) || !releasedPattern.test(until)) return { albums: [] };
  const albums: AppleAlbum[] = [], seen = new Set<string>();
  for (const item of value.slice(0, newReleasesLimits.idsPerRequest)) {
    const entry = item as { albums?: unknown };
    if (!entry || !Array.isArray(entry.albums)) continue;
    for (const raw of entry.albums.slice(0, 3)) {
      const album = raw as { id?: unknown; name?: unknown; artist?: unknown; released?: unknown; genre?: unknown; artwork?: unknown };
      if (!album || typeof album.id !== 'string' || !/^\d{1,20}$/.test(album.id) || typeof album.name !== 'string' || !album.name.trim() ||
        typeof album.artist !== 'string' || typeof album.released !== 'string' || !releasedPattern.test(album.released) || album.released < since || album.released > until || seen.has(album.id)) continue;
      seen.add(album.id);
      const artworkUrl = typeof album.artwork === 'string' && artworkPattern.test(album.artwork) ? album.artwork.replace('{w}x{h}bb', '100x100bb') : undefined;
      albums.push({ id: album.id, title: album.name.replace(/\s+/g, ' ').trim().slice(0, 240), artist: album.artist.replace(/\s+/g, ' ').trim().slice(0, 240),
        url: `https://music.apple.com/${country}/album/${album.id}`, released: album.released, ...(artworkUrl ? { artworkUrl } : {}),
        ...(typeof album.genre === 'string' && album.genre.trim() ? { genre: album.genre.replace(/\s+/g, ' ').trim().slice(0, 80) } : {}) });
    }
  }
  return { albums };
}

// Caché de un día en datos pesados: país, cuándo se comprobó, cuántos artistas y los discos (ya validados al leer).
export interface NewReleasesCache { checkedAt: number; country: string; artists: number; releases: AppleAlbum[] }
export function readNewReleasesCache(file: string, now = Date.now()): NewReleasesCache | undefined {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch { return; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > newReleasesLimits.bytes) return;
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const root = data as { version?: unknown; checkedAt?: unknown; country?: unknown; artists?: unknown; releases?: unknown };
  if (!root || typeof root !== 'object' || Array.isArray(root) || root.version !== 1 || typeof root.checkedAt !== 'number' || !Number.isFinite(root.checkedAt) ||
    root.checkedAt > now + 60000 || typeof root.country !== 'string' || !/^[a-z]{2}$/.test(root.country) || !Number.isInteger(root.artists) || !Array.isArray(root.releases)) return;
  const releases: AppleAlbum[] = [], seen = new Set<string>();
  for (const item of root.releases.slice(0, newReleasesLimits.albums)) {
    const album = item as Partial<AppleAlbum>;
    if (!album || typeof album.id !== 'string' || !/^\d{1,20}$/.test(album.id) || typeof album.title !== 'string' || typeof album.artist !== 'string' ||
      album.url !== `https://music.apple.com/${root.country}/album/${album.id}` || typeof album.released !== 'string' || !releasedPattern.test(album.released) ||
      (album.artworkUrl !== undefined && (typeof album.artworkUrl !== 'string' || !/^https:\/\/is\d-ssl\.mzstatic\.com\//.test(album.artworkUrl))) ||
      (album.genre !== undefined && typeof album.genre !== 'string') || seen.has(album.id)) return;
    seen.add(album.id);
    releases.push({ id: album.id, title: album.title.slice(0, 240), artist: album.artist.slice(0, 240), url: album.url, released: album.released,
      ...(album.artworkUrl ? { artworkUrl: album.artworkUrl } : {}), ...(album.genre ? { genre: album.genre.slice(0, 80) } : {}) });
  }
  return { checkedAt: root.checkedAt, country: root.country, artists: root.artists as number, releases };
}
export function saveNewReleasesCache(file: string, cache: NewReleasesCache): void {
  const text = JSON.stringify({ version: 1, checkedAt: cache.checkedAt, country: cache.country, artists: cache.artists, releases: cache.releases.slice(0, newReleasesLimits.albums) });
  if (Buffer.byteLength(text) > newReleasesLimits.bytes) throw new Error('NEW_RELEASES_CACHE_TOO_BIG');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch { /* ya renombrado */ } }
}

export interface NewReleasesResult { albums: AppleAlbum[]; artists: number; fromCache: boolean; checkedAt: number }
// Progreso para el panel: entradas de la biblioteca leídas (y el total, si Apple lo informa), artistas con ID de catálogo
// encontrados, cuántos ya se consultaron en el catálogo, si la biblioteca terminó y los discos hasta ahora, ya ordenados.
export interface NewReleasesProgress { read: number; total?: number; artists: number; checked: number; libraryDone: boolean; albums: AppleAlbum[] }
export class NewReleasesError extends Error { constructor(readonly stage: number, readonly status: number) { super('NEW_RELEASES_FAILED'); } }
const sortReleases = (albums: Iterable<AppleAlbum>): AppleAlbum[] =>
  [...albums].sort((a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.title.localeCompare(b.title)).slice(0, newReleasesLimits.albums);
// Recorrido completo: caché de menos de un día → directo; una de hasta 7 días se entrega enseguida por onStale y se
// actualiza igual. La biblioteca se lee por páginas (de a tres cuando la primera trae el total) y el catálogo se consulta
// mientras llegan los artistas, en lotes de 25 (hasta tres a la vez, con pausa): la espera total es la más larga de las
// dos, no la suma. Discos desde «since», del más nuevo al más viejo. Un error de la biblioteca (etapa 1) o del catálogo
// (etapa 2) corta con su estado; cancelación por signal entre pedidos.
export async function loadNewReleases(contents: WebContents, country: string, options: { cacheFile?: string; signal: AbortSignal; now?: number;
  log?: (event: string, fields?: Record<string, boolean | number>) => void; onProgress?: (progress: NewReleasesProgress) => void;
  onStale?: (cached: NewReleasesResult) => void }): Promise<NewReleasesResult> {
  if (!/^[a-z]{2}$/.test(country)) throw new NewReleasesError(0, 0);
  const now = options.now ?? Date.now(), log = options.log;
  const since = sinceDate(now), until = sinceDate(now, 0);
  if (options.cacheFile) {
    const cached = readNewReleasesCache(options.cacheFile, now);
    if (cached && cached.country === country) {
      // La ventana se vuelve a acotar al leer: una caché de otro día puede traer preventas ya publicadas o discos ya fuera de las cuatro semanas.
      const albums = cached.releases.filter(album => (album.released ?? '') <= until && (album.released ?? '') >= since), age = now - cached.checkedAt;
      if (age < newReleasesLimits.cacheMs) {
        log?.('Novedades: desde la caché', { discos: albums.length, artistas: cached.artists, edadMin: Math.round(age / 60000) });
        return { albums, artists: cached.artists, fromCache: true, checkedAt: cached.checkedAt };
      }
      if (age < newReleasesLimits.staleMs) options.onStale?.({ albums, artists: cached.artists, fromCache: true, checkedAt: cached.checkedAt });
    }
  }
  const run = (script: string): Promise<unknown> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([contents.mainFrame.executeJavaScript(script),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NEW_RELEASES_TIMEOUT')), newReleasesLimits.timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const started = Date.now(), per = newReleasesLimits.artistsPerPage, artists = new Map<string, string>(), queue: string[] = [], albums = new Map<string, AppleAlbum>();
  let total: number | undefined, pagesRead = 0, checked = 0, batches = 0, libraryDone = false, failure: unknown;
  // Los lotes del catálogo esperan artistas nuevos (o el fin de la biblioteca, o un error, o la cancelación).
  const waiters: Array<() => void> = [];
  const notify = (): void => { for (const wake of waiters.splice(0)) wake(); };
  options.signal.addEventListener('abort', notify, { once: true });
  const report = (): void => {
    if (!options.onProgress || options.signal.aborted) return;
    const read = libraryDone ? Math.max(artists.size, Math.min(total ?? Infinity, pagesRead * per)) : Math.min(total ?? Infinity, pagesRead * per);
    options.onProgress({ read, ...(total === undefined ? {} : { total }), artists: artists.size, checked, libraryDone, albums: sortReleases(albums.values()) });
  };
  // Lecturas: una respuesta 429 (cuota de Apple) se reintenta dos veces, a los 2 y 4 s; cualquier otro error corta.
  const ask = async (script: string, stage: number): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      let result: unknown;
      try { result = await run(script); } catch { throw new NewReleasesError(stage, 0); }
      if (result === null) throw new NewReleasesError(stage, 0);
      const error = result && typeof result === 'object' && !Array.isArray(result) && 'error' in result ? (result as { error: unknown }).error : undefined;
      if (error !== 429 || attempt >= 2) return result;
      log?.('Novedades: cuota de Apple, reintento', { etapa: stage, intento: attempt + 1 });
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => { clearTimeout(timer); reject(options.signal.reason); };
        const timer = setTimeout(() => { options.signal.removeEventListener('abort', stop); resolve(); }, 2000 * 2 ** attempt);
        options.signal.addEventListener('abort', stop, { once: true });
      });
    }
  };
  const more = new Map<number, boolean>();
  const readPage = async (page: number): Promise<ReturnType<typeof parseLibraryArtists>> => {
    options.signal.throwIfAborted();
    const parsed = parseLibraryArtists(await ask(libraryArtistsScript(page * per), 1));
    if (parsed.error !== undefined) throw new NewReleasesError(1, parsed.error);
    if (page === 0 && parsed.total !== undefined) total = parsed.total;
    pagesRead++; more.set(page, parsed.more && parsed.artists.length > 0);
    for (const artist of parsed.artists) if (!artists.has(artist.id)) { artists.set(artist.id, artist.name); queue.push(artist.id); }
    notify(); report();
    return parsed;
  };
  const library = async (): Promise<void> => {
    try {
      const first = await readPage(0);
      if (first.more && first.artists.length) {
        if (total !== undefined) {
          const pages = Math.min(Math.ceil(total / per), newReleasesLimits.artistPages);
          let nextPage = 1;
          const reader = async (): Promise<void> => { while (nextPage < pages && failure === undefined) await readPage(nextPage++); };
          await Promise.all(Array.from({ length: Math.min(newReleasesLimits.libraryInFlight, pages - 1) }, reader));
          // Si Apple informó un total menor de lo que hay, se sigue de a una página mientras diga que hay otra.
          for (let page = pages; more.get(page - 1) && page < newReleasesLimits.artistPages && failure === undefined; page++) await readPage(page);
        } else {
          for (let page = 1; page < newReleasesLimits.artistPages && failure === undefined; page++) {
            const parsed = await readPage(page);
            if (!parsed.more || !parsed.artists.length) break;
          }
        }
      }
      if (failure === undefined) log?.('Novedades: artistas de la biblioteca', { artistas: artists.size, páginas: pagesRead, ms: Date.now() - started });
    } catch (error) { failure ??= error; }
    finally { libraryDone = true; notify(); if (failure === undefined) report(); }
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined || options.signal.aborted) return;
      if (queue.length >= newReleasesLimits.idsPerRequest || (libraryDone && queue.length)) {
        const chunk = queue.splice(0, newReleasesLimits.idsPerRequest);
        let result: unknown;
        try { result = await ask(latestReleasesScript(country, chunk), 2); }
        catch (error) { failure ??= error instanceof NewReleasesError || options.signal.aborted ? error : new NewReleasesError(2, 0); notify(); return; }
        const parsed = parseLatestReleases(result, country, since, until);
        if (parsed.error !== undefined) { failure ??= new NewReleasesError(2, parsed.error); notify(); return; }
        for (const album of parsed.albums) if (!albums.has(album.id)) albums.set(album.id, album);
        checked += chunk.length; batches++; report();
        await new Promise(resolve => setTimeout(resolve, newReleasesLimits.pacingMs));
        continue;
      }
      if (libraryDone) return;
      await new Promise<void>(resolve => waiters.push(resolve));
    }
  };
  try { await Promise.all([library(), ...Array.from({ length: newReleasesLimits.inFlight }, worker)]); }
  finally { options.signal.removeEventListener('abort', notify); }
  options.signal.throwIfAborted();
  if (failure !== undefined) throw failure instanceof NewReleasesError ? failure : new NewReleasesError(1, 0);
  const sorted = sortReleases(albums.values());
  log?.('Novedades: lanzamientos', { artistas: artists.size, lotes: batches, discos: sorted.length, ms: Date.now() - started });
  if (options.cacheFile) {
    try { saveNewReleasesCache(options.cacheFile, { checkedAt: now, country, artists: artists.size, releases: sorted }); }
    catch { log?.('Novedades: no se pudo guardar la caché'); }
  }
  return { albums: sorted, artists: artists.size, fromCache: false, checkedAt: now };
}
