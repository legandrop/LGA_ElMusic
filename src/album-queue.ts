import type { WebContents } from 'electron';
import { randomInt } from 'node:crypto';

// Cola de discos desde nuestras listas (New releases, panel de un sello y lista al pie de la página de un sello): Play o
// Shuffle sobre un disco reproduce ese disco y sigue con los discos que le siguen en la lista mostrada, hasta el final.
// Play: cada disco en su orden. Shuffle: los temas de cada disco mezclados, pero los discos en el orden de la lista (el
// shuffle de Apple mezclaría todos los discos entre sí, por eso queda apagado y la mezcla la hace main).
// Sólo API pública del singleton MusicKit que configuró la página: temas de /v1/catalog/{país}/albums (sólo lectura),
// shuffleMode, setQueue({ songs, startPlaying }) una vez al empezar y playLater({ songs }) para agregar al final los discos
// siguientes cuando quedan menos de refillBelow temas por sonar. La cola se valida antes de cada agregado: si contiene un
// tema que esta cola no puso (el usuario reprodujo otra cosa), la cola de discos termina y no se toca más. Un pedido en
// vuelo por vez y sin reintentar efectos.
export type AlbumQueueMode = 'in-order' | 'shuffle';
export const albumQueueLimits = { albums: 300, idsPerRequest: 25, firstAlbums: 4, batchAlbums: 6, tracksPerAlbum: 300, refillBelow: 12,
  songs: 3000, timeoutMs: 20000, tickMs: 5000 } as const;
export const albumQueueWakeMessage = 'elMusic.albumQueue.tick';

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
const kit = `const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;`;
const idList = (ids: readonly string[], max: number): boolean => ids.length > 0 && ids.length <= max && ids.every(id => /^\d{1,20}$/.test(id));

// Temas reproducibles (con playParams) de un lote de discos, por disco y en el orden del disco. Sin nombres ni más datos.
export function albumTracksScript(country: string, ids: readonly string[]): string {
  if (!/^[a-z]{2}$/.test(country) || !idList(ids, albumQueueLimits.idsPerRequest)) throw new Error('INVALID_ALBUMS');
  return `(async () => { ${guard}
    ${kit}
    if (typeof music?.api?.music !== 'function') return null;
    try {
      const response = await music.api.music(${JSON.stringify(`/v1/catalog/${country}/albums`)}, { ids: ${JSON.stringify(ids.join(','))} });
      const code = Number(response?.status), refusal = Array.isArray(response?.data?.errors) ? Number(response.data.errors[0]?.status) : NaN;
      if ((Number.isInteger(code) && code >= 400) || Number.isInteger(refusal)) return { error: Number.isInteger(code) && code >= 400 ? code : refusal };
      const data = response?.data?.data;
      return Array.isArray(data) ? data.slice(0, ${albumQueueLimits.idsPerRequest}).map(album => ({ id: String(album?.id),
        songs: (Array.isArray(album?.relationships?.tracks?.data) ? album.relationships.tracks.data : []).slice(0, ${albumQueueLimits.tracksPerAlbum})
          .filter(track => track?.type === 'songs' && track?.attributes?.playParams).map(track => String(track?.id)) })) : [];
    } catch (error) { const status = Number(error?.status ?? error?.response?.status ?? error?.errorCode); return { error: Number.isInteger(status) ? status : 0 }; }
  })()`;
}
// Temas por disco, sólo de los discos pedidos y con IDs numéricos sin repetir; un disco sin temas reproducibles queda vacío.
export function parseAlbumTracks(value: unknown, ids: readonly string[]): { tracks: Map<string, string[]>; error?: number } {
  const tracks = new Map<string, string[]>();
  if (value && typeof value === 'object' && !Array.isArray(value) && 'error' in value) {
    const error = (value as { error: unknown }).error; return { tracks, error: Number.isInteger(error) ? error as number : 0 };
  }
  if (!Array.isArray(value)) return { tracks, error: 0 };
  const wanted = new Set(ids), seen = new Set<string>();
  for (const item of value.slice(0, albumQueueLimits.idsPerRequest)) {
    const album = item as { id?: unknown; songs?: unknown };
    if (!album || typeof album.id !== 'string' || !wanted.has(album.id) || tracks.has(album.id) || !Array.isArray(album.songs)) continue;
    const songs: string[] = [];
    for (const song of album.songs.slice(0, albumQueueLimits.tracksPerAlbum)) if (typeof song === 'string' && /^\d{1,20}$/.test(song) && !seen.has(song)) { seen.add(song); songs.push(song); }
    tracks.set(album.id, songs);
  }
  return { tracks };
}
// Orden de la cola: los discos en el orden pedido; con shuffle, los temas de cada disco mezclados (Fisher–Yates).
export function arrangeSongs(albums: readonly (readonly string[])[], mode: AlbumQueueMode, random: (max: number) => number = randomInt): string[] {
  const songs: string[] = [];
  for (const album of albums) {
    const list = [...album];
    if (mode === 'shuffle') for (let index = list.length - 1; index > 0; index--) { const other = random(index + 1); [list[index], list[other]] = [list[other], list[index]]; }
    songs.push(...list);
  }
  return songs;
}
// Arranque: shuffle de Apple apagado (el orden ya viene armado) y un único setQueue público con startPlaying. La marca de
// cola activa va antes de tocar el shuffle: la preferencia guardada de shuffle no toma ese apagado como un cambio del usuario.
export function queueStartScript(songs: readonly string[]): string {
  if (!idList(songs, albumQueueLimits.songs)) throw new Error('INVALID_SONGS');
  return `(async () => { ${guard}
    const root = document.documentElement;
    if (root.dataset.elMusicAlbumPlayBusy || root.dataset.elMusicRecommendationQueueBusy) return 'busy';
    root.dataset.elMusicAlbumPlayBusy = '1';
    const before = root.dataset.elMusicAlbumQueue;
    let started = false, music, shuffle;
    try {
      const kit = globalThis.MusicKit; music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
      if (typeof music?.setQueue !== 'function') return 'unavailable';
      root.dataset.elMusicAlbumQueue = '1';
      shuffle = Number(music.shuffleMode);
      if (shuffle !== 0) music.shuffleMode = 0;
      const queue = await music.setQueue({ songs: ${JSON.stringify([...songs])}, startPlaying: true });
      started = queue !== undefined && queue !== null;
      return started ? 'requested/' + (Array.isArray(queue?.items) ? queue.items.length : 0) : 'unavailable';
    } catch { return 'failed'; }
    finally {
      delete root.dataset.elMusicAlbumPlayBusy;
      // Si no arrancó, el shuffle y la marca quedan como estaban.
      if (!started) { try { if (shuffle === 1 && Number(music?.shuffleMode) === 0) music.shuffleMode = 1; } catch {} if (before === '1') root.dataset.elMusicAlbumQueue = '1'; else delete root.dataset.elMusicAlbumQueue; }
    }
  })()`;
}
// Estado público de la cola: posición, IDs de sus temas (sólo números) y si el shuffle de Apple está encendido.
export const queueStateScript = `(() => { ${guard}
  ${kit}
  const items = music?.queue?.items;
  if (!Array.isArray(items)) return null;
  return { position: Number(music.queue.position), shuffle: Number(music.shuffleMode) || 0, ids: items.slice(0, ${albumQueueLimits.songs + 200}).map(item => String(item?.id ?? '')) };
})()`;
// Agrega al final, sólo si la cola sigue siendo la que esta cola de discos dejó: mismo largo y mismo último tema.
export function queueAppendScript(songs: readonly string[], expectedLength: number, expectedLast: string): string {
  if (!idList(songs, albumQueueLimits.songs) || !Number.isInteger(expectedLength) || expectedLength < 1 || !/^\d{1,20}$/.test(expectedLast)) throw new Error('INVALID_SONGS');
  return `(async () => { ${guard}
    const root = document.documentElement;
    if (root.dataset.elMusicAlbumPlayBusy || root.dataset.elMusicRecommendationQueueBusy) return 'busy';
    ${kit}
    if (typeof music?.playLater !== 'function' || !Array.isArray(music?.queue?.items)) return 'unavailable';
    const items = music.queue.items;
    if (items.length !== ${expectedLength} || String(items[items.length - 1]?.id) !== ${JSON.stringify(expectedLast)}) return 'changed';
    root.dataset.elMusicAlbumPlayBusy = '1';
    try { await music.playLater({ songs: ${JSON.stringify([...songs])} }); return 'appended/' + (Array.isArray(music.queue?.items) ? music.queue.items.length : 0); }
    catch { return 'failed'; }
    finally { delete root.dataset.elMusicAlbumPlayBusy; }
  })()`;
}
// La página avisa con un mensaje de consola fijo cuando cambia el tema o la posición, sólo mientras hay una cola de discos.
const activeScript = (active: boolean): string => `(() => { ${guard} if (${active}) document.documentElement.dataset.elMusicAlbumQueue = '1'; else delete document.documentElement.dataset.elMusicAlbumQueue; return true; })()`;

export interface QueueSnapshot { position: number; ids: string[]; shuffle: number }
export function parseQueueSnapshot(value: unknown): QueueSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const root = value as { position?: unknown; ids?: unknown; shuffle?: unknown };
  if (typeof root.position !== 'number' || !Number.isInteger(root.position) || !Array.isArray(root.ids)) return;
  return { position: root.position, shuffle: root.shuffle === 1 ? 1 : 0, ids: root.ids.slice(0, albumQueueLimits.songs + 200).map(id => String(id)) };
}
// Qué hacer con la cola: 'end' si tiene un tema que no puso esta cola entre los suyos (el usuario reprodujo otra cosa) o
// quedó vacía; 'refill' si quedan pocos temas propios por sonar y hay discos por agregar; 'tail' si haría falta agregar
// pero después del último tema propio hay temas ajenos (el autoplay de Apple puede sumarlos al final: playLater quedaría
// detrás de ellos, así que no se agrega); si no, nada. Con el shuffle de Apple encendido la cola se reordena, pero sigue
// teniendo sólo temas propios: se sigue agregando al final.
export function queueDecision(snapshot: QueueSnapshot, queued: ReadonlySet<string>, albumsLeft: boolean, songsQueued: number): 'end' | 'refill' | 'tail' | 'none' {
  let lastOwn = -1;
  for (let index = snapshot.ids.length - 1; index >= 0; index--) if (queued.has(snapshot.ids[index])) { lastOwn = index; break; }
  if (lastOwn < 0 || snapshot.ids.slice(0, lastOwn).some(id => !queued.has(id))) return 'end';
  const remaining = lastOwn - Math.max(0, snapshot.position);
  if (!albumsLeft || remaining >= albumQueueLimits.refillBelow || songsQueued >= albumQueueLimits.songs) return 'none';
  return lastOwn < snapshot.ids.length - 1 ? 'tail' : 'refill';
}

// start: tema del primer disco desde el que empieza (▶ de un tema del disco desplegado); los anteriores no entran.
export interface AlbumQueue { start(albums: readonly string[], mode: AlbumQueueMode, country: string, start?: string): Promise<'requested' | 'busy' | 'unavailable' | 'failed' | 'empty'>; stop(): void }
// Primer tramo de la cola: desde el tema pedido (en orden) o, sin él, el disco entero; los discos siguientes, según el modo.
export function firstSongs(tracks: readonly (readonly string[])[], mode: AlbumQueueMode, start?: string, random?: (max: number) => number): string[] | undefined {
  if (!start) return arrangeSongs(tracks, mode, random);
  const at = tracks[0]?.indexOf(start) ?? -1;
  if (at < 0) return;
  return [...tracks[0].slice(at), ...arrangeSongs(tracks.slice(1), mode, random)];
}
export function installAlbumQueue(contents: WebContents, log: (event: string, fields?: Record<string, boolean | number>) => void): AlbumQueue {
  type Session = { epoch: number; mode: AlbumQueueMode; country: string; albums: string[]; next: number; queued: Set<string>; length: number; started: number; added: number };
  let session: Session | undefined, epoch = 0, busy = false, again = false, stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const live = (): boolean => !stopped && !contents.isDestroyed();
  const run = (script: string): Promise<unknown> => {
    let timeout: NodeJS.Timeout | undefined;
    return Promise.race([contents.mainFrame.executeJavaScript(script),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('ALBUM_QUEUE_TIMEOUT')), albumQueueLimits.timeoutMs); })]).finally(() => clearTimeout(timeout));
  };
  const setActive = (active: boolean): void => { if (live()) void contents.mainFrame.executeJavaScript(activeScript(active)).catch(() => undefined); };
  // fin (log): 0 lista terminada, 1 otra cola (tema ajeno), 2 cola nueva, 3 error, 4 tope de temas, 5 temas ajenos al
  // final de la cola (autoplay de Apple) cuando hacía falta agregar.
  // Mientras arranca una cola nueva la marca de la página no se apaga: ya la puso el arranque y el shuffle guardado no
  // tiene que tomar el apagado como un cambio del usuario.
  let starting = 0;
  const end = (reason: number): void => {
    if (!session) return;
    log('Cola de discos: terminada', { fin: reason, discos: session.next, temas: session.length, agregados: session.added, min: Math.round((Date.now() - session.started) / 60000) });
    session = undefined; clearInterval(timer); timer = undefined;
    if (!starting) setActive(false);
  };
  // Los IDs que Apple dejó en la cola desde «from» pasan a ser propios: si reemplazó un tema por otro equivalente, la
  // validación siguiente no lo toma por ajeno.
  const adopt = async (current: Session, from: number): Promise<void> => {
    const snapshot = parseQueueSnapshot(await run(queueStateScript).catch(() => null));
    if (snapshot && session === current) for (const id of snapshot.ids.slice(from)) if (/^\d{1,20}$/.test(id)) current.queued.add(id);
  };
  // Temas de los discos [from, to) de la lista, de a idsPerRequest por pedido, en el orden de la lista.
  const tracksOf = async (country: string, ids: readonly string[]): Promise<string[][]> => {
    const albums: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += albumQueueLimits.idsPerRequest) {
      const chunk = ids.slice(offset, offset + albumQueueLimits.idsPerRequest);
      const parsed = parseAlbumTracks(await run(albumTracksScript(country, chunk)), chunk);
      if (parsed.error !== undefined) throw new Error('ALBUM_TRACKS_' + parsed.error);
      for (const id of chunk) albums.push(parsed.tracks.get(id) ?? []);
    }
    return albums;
  };
  const tick = async (): Promise<void> => {
    if (starting) return;
    if (busy) { again = true; return; }
    const current = session; if (!current || !live()) return;
    busy = true;
    try {
      const snapshot = parseQueueSnapshot(await run(queueStateScript));
      if (session !== current || !snapshot) return;
      const decision = queueDecision(snapshot, current.queued, current.next < current.albums.length, current.length);
      if (decision === 'end') { end(1); return; }
      if (decision === 'tail') { end(5); return; }
      if (decision !== 'refill') {
        // Sin discos por agregar, la cola se deja de mirar cuando suena el último tema propio.
        const lastOwn = snapshot.ids.reduce((last, id, index) => current.queued.has(id) ? index : last, -1);
        if (current.next >= current.albums.length && Math.max(0, snapshot.position) >= lastOwn) end(0);
        return;
      }
      const batch = current.albums.slice(current.next, current.next + albumQueueLimits.batchAlbums);
      const songs = arrangeSongs(await tracksOf(current.country, batch), current.mode).filter(id => !current.queued.has(id))
        .slice(0, albumQueueLimits.songs - current.length);
      if (session !== current) return;
      current.next += batch.length;
      if (!songs.length) { if (current.next < current.albums.length) again = true; else end(0); return; }
      const result = await run(queueAppendScript(songs, snapshot.ids.length, snapshot.ids[snapshot.ids.length - 1]));
      if (session !== current) return;
      const appended = typeof result === 'string' && /^appended\/\d{1,6}$/.test(result);
      log('Cola de discos: discos agregados', { resultado: appended ? 1 : result === 'changed' ? 2 : result === 'busy' ? 3 : result === 'unavailable' ? 4 : 5, discos: batch.length, temas: songs.length,
        enCola: appended ? Number((result as string).slice(9)) : snapshot.ids.length });
      if (appended) {
        for (const id of songs) current.queued.add(id);
        current.length = Number((result as string).slice(9)) || snapshot.ids.length + songs.length; current.added += batch.length;
        await adopt(current, snapshot.ids.length);
        if (session === current && current.length >= albumQueueLimits.songs) end(4);
      } else if (result === 'changed') end(1);
      else { current.next -= batch.length; if (result !== 'busy') end(3); }
    } catch (error) {
      if (session === current) { log('Cola de discos: error al agregar', { código: Number(String((error as Error)?.message).match(/\d+$/)?.[0]) || 0 }); end(3); }
    } finally {
      busy = false;
      if (again) { again = false; void tick(); }
    }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === albumQueueWakeMessage && details.frame === contents.mainFrame && session) void tick();
  };
  contents.on('console-message', wake);
  contents.once('destroyed', () => { stopped = true; clearInterval(timer); contents.removeListener('console-message', wake); });
  return {
    async start(albums, mode, country, start) {
      const mine = ++epoch;
      const list = albums.filter((id, index) => /^\d{1,20}$/.test(id) && albums.indexOf(id) === index).slice(0, albumQueueLimits.albums);
      if (!list.length || !/^[a-z]{2}$/.test(country) || (start !== undefined && !/^\d{1,20}$/.test(start))) return 'failed';
      // La cola anterior sigue (y se sigue alargando) hasta que la nueva arranca de verdad: un Play que falla no la corta.
      starting++;
      try {
        const started = Date.now();
        // Primer tramo: el disco elegido y los que le siguen hasta firstAlbums, para empezar enseguida; el resto, al avanzar.
        const first = list.slice(0, albumQueueLimits.firstAlbums);
        let tracks: string[][];
        try { tracks = await tracksOf(country, first); }
        catch (error) { log('Cola de discos: error al leer los temas', { código: Number(String((error as Error)?.message).match(/\d+$/)?.[0]) || 0 }); return 'failed'; }
        if (mine !== epoch) return 'busy';
        if (!tracks[0]?.length) { log('Cola de discos: el disco no tiene temas reproducibles'); return 'empty'; }
        const songs = firstSongs(tracks, mode, start);
        if (!songs) { log('Cola de discos: el tema pedido no está entre los del disco'); return 'empty'; }
        // Un agregado de la cola anterior en vuelo: se espera a que termine (hasta 5 s) para no chocar con su marca de ocupado.
        for (let waited = 0; busy && waited < 5000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
        const result = await run(queueStartScript(songs)).catch(() => 'failed');
        if (mine !== epoch) return 'busy';
        const requested = typeof result === 'string' && /^requested\/\d{1,6}$/.test(result);
        log('Cola de discos: reproducir', { resultado: requested ? 1 : result === 'busy' ? 2 : result === 'unavailable' ? 3 : 4, modo: mode === 'shuffle' ? 1 : 0,
          discos: list.length, temas: songs.length, enCola: requested ? Number((result as string).slice(10)) : 0, ms: Date.now() - started });
        if (!requested) return result === 'busy' ? 'busy' : result === 'unavailable' ? 'unavailable' : 'failed';
        if (session) end(2);
        const current: Session = { epoch: mine, mode, country, albums: list, next: first.length, queued: new Set(songs), length: Number((result as string).slice(10)) || songs.length, started, added: 0 };
        session = current;
        await adopt(current, 0);
        setActive(true);
        timer = setInterval(() => void tick(), albumQueueLimits.tickMs); timer.unref?.();
        return 'requested';
      } finally {
        starting--;
        // Sin cola viva (un arranque que no prosperó o que quedó viejo) la marca de la página no puede quedar puesta.
        if (!starting) { if (session) void tick(); else setActive(false); }
      }
    },
    stop() { epoch++; end(2); }
  };
}
