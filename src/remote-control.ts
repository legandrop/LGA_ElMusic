import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

// Canal local del plugin Stream Deck: named pipe / socket Unix por usuario, sin puerto TCP ni acceso de la vista remota.
export const controlProtocol = 1;
export const controlActions = ['hello', 'state', 'previous', 'playPause', 'next', 'playlists', 'addToPlaylist', 'toggleWindow'] as const;
export type ControlAction = typeof controlActions[number];
export interface ControlRequest { id: number; action: ControlAction; playlistId?: string }
export type ControlOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
export type ControlReply = ControlOutcome & { id: number | null };

const playlistPattern = /^p\.[A-Za-z0-9]{1,64}$/;
const maxLine = 512;
const maxBuffer = 4096;
const maxClients = 8;
const maxPendingPerClient = 4;
const mutationLimit = 90000;

export function controlEndpoint(platform: NodeJS.Platform, username: string, home: string): string {
  if (platform === 'win32') return `\\\\.\\pipe\\ElMusic-control-${username.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'user'}`;
  const base = platform === 'darwin' ? path.posix.join(home, 'Library', 'Application Support') : path.posix.join(home, '.config');
  return path.posix.join(base, 'LGA', 'ElMusic', 'control.sock');
}

export function parseControlRequest(line: string): ControlRequest | undefined {
  if (line.length > maxLine) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.some(key => !['id', 'action', 'playlistId'].includes(key))) return;
  if (!Number.isInteger(data.id) || (data.id as number) < 1 || (data.id as number) > 2 ** 31) return;
  if (!controlActions.includes(data.action as ControlAction)) return;
  const action = data.action as ControlAction;
  if (action === 'addToPlaylist') {
    if (typeof data.playlistId !== 'string' || !playlistPattern.test(data.playlistId)) return;
    return { id: data.id as number, action, playlistId: data.playlistId };
  }
  if ('playlistId' in data) return;
  return { id: data.id as number, action };
}

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return { status: 'unavailable' };
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    if (!music) return { status: 'unavailable' };`;

// Sólo comandos y propiedades públicas del singleton que configuró la página oficial; nunca tokens ni estado privado.
export const controlStateScript = `(async () => {
    ${guard}
    return { status: 'ok', playing: music.isPlaying === true, item: !!music.nowPlayingItem };
  })()`;

export function controlTransportScript(action: 'previous' | 'playPause' | 'next'): string {
  if (!['previous', 'playPause', 'next'].includes(action)) throw new Error('Acción de transporte inválida');
  return `(async () => {
    ${guard}
    const action = ${JSON.stringify(action)};
    try {
      if (action === 'playPause') {
        if (music.isPlaying === true) { if (typeof music.pause !== 'function') return { status: 'unavailable' }; await music.pause(); }
        else { if (typeof music.play !== 'function' || !music.nowPlayingItem) return { status: 'nothing-playing' }; await music.play(); }
      } else if (action === 'next') {
        if (typeof music.skipToNextItem !== 'function') return { status: 'unavailable' };
        await music.skipToNextItem();
      } else if (Number(music.currentPlaybackTime) > 3 && typeof music.seekToTime === 'function') await music.seekToTime(0);
      else {
        if (typeof music.skipToPreviousItem !== 'function') return { status: 'unavailable' };
        await music.skipToPreviousItem();
      }
    } catch { return { status: 'failed' }; }
    return { status: 'ok', playing: music.isPlaying === true };
  })()`;
}

export const controlPlaylistsScript = `(async () => {
    ${guard}
    if (music.isAuthorized !== true) return { status: 'signed-out' };
    if (typeof music.api?.music !== 'function') return { status: 'unavailable' };
    const playlists = [];
    let offset = 0;
    try {
      for (let page = 0; page < 10; page++) {
        const response = await music.api.music('/v1/me/library/playlists', { limit: 100, offset });
        const data = response?.data?.data;
        if (!Array.isArray(data)) break;
        for (const item of data) {
          const name = item?.attributes?.name;
          if (typeof item?.id === 'string' && ${playlistPattern}.test(item.id) && typeof name === 'string' && item.attributes.canEdit === true)
            playlists.push({ id: item.id, name: name.replace(/\\s+/g, ' ').trim().slice(0, 200) });
        }
        if (!response.data.next || !data.length) break;
        offset += data.length;
      }
    } catch { return { status: 'failed' }; }
    return { status: 'ok', playlists };
  })()`;

// Escritura acotada: sólo el tema en reproducción, sólo a la playlist del botón y sin duplicar.
export function controlAddToPlaylistScript(playlistId: string): string {
  if (!playlistPattern.test(playlistId)) throw new Error('Playlist inválida');
  return `(async () => {
    ${guard}
    const shown = music.nowPlayingItem;
    const add = async () => {
    if (music.isAuthorized !== true) return { status: 'signed-out' };
    if (typeof music.api?.music !== 'function') return { status: 'unavailable' };
    const item = music.nowPlayingItem;
    if (!item) return { status: 'nothing-playing' };
    const params = item.playParams ?? item.attributes?.playParams ?? {};
    const kind = params.kind ?? item.type;
    if (!['song', 'songs', 'library-songs'].includes(kind)) return { status: 'not-a-song' };
    const candidate = String(params.id ?? item.id ?? '');
    const catalogId = typeof params.catalogId === 'string' && /^\\d{1,20}$/.test(params.catalogId) ? params.catalogId :
      params.isLibrary !== true && /^\\d{1,20}$/.test(candidate) ? candidate : undefined;
    const libraryId = params.isLibrary === true && /^i\\.[A-Za-z0-9]{1,64}$/.test(candidate) ? candidate : undefined;
    if (!catalogId && !libraryId) return { status: 'not-a-song' };
    const rawTitle = item.title ?? item.attributes?.name;
    const title = typeof rawTitle === 'string' ? rawTitle.replace(/\\s+/g, ' ').trim().slice(0, 200) : '';
    // Duplicado por nombre: mismo título y mismo artista, sin distinguir mayúsculas ni espacios,
    // aunque el ID sea otro (otra edición del mismo tema). Versiones con otro título (Live, Remix…) no coinciden.
    const same = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\\s+/g, ' ').trim().toLowerCase() : '';
    const nameKey = same(rawTitle), artistKey = same(item.artistName ?? item.attributes?.artistName);
    let similar = false;
    const tracks = '/v1/me/library/playlists/' + ${JSON.stringify(playlistId)} + '/tracks';
    // MKError guarda la Response en data y rotula también 405/501 como NOT_FOUND: sólo un 404 real cuenta como playlist vacía.
    const notFound = error => Number(error?.data?.status ?? error?.status) === 404;
    // La lectura tiene un plazo total; el POST, uno propio y sin cancelación posible una vez enviado.
    const deadline = Date.now() + 20000;
    const within = (promise, milliseconds) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject({ elMusicTimeout: true }), Math.max(0, milliseconds)); })]).finally(() => clearTimeout(timer)); };
    let offset = 0;
    for (let page = 0; ; page++) {
      if (page >= 100) return { status: 'check-failed' };
      let response;
      // Una playlist vacía responde 404; cualquier otro error impide escribir sin saber si ya estaba.
      try { response = await within(music.api.music(tracks, { limit: 100, offset }), deadline - Date.now()); }
      catch (error) { if (offset === 0 && notFound(error)) break; return { status: 'check-failed' }; }
      const data = response?.data?.data;
      if (!Array.isArray(data)) return { status: 'check-failed' };
      for (const track of data) {
        const play = track?.attributes?.playParams;
        if ((libraryId && (track?.id === libraryId || play?.id === libraryId)) ||
          (catalogId && (play?.catalogId === catalogId || play?.purchasedId === catalogId || track?.id === catalogId))) return { status: 'already', title };
        if (nameKey && artistKey && same(track?.attributes?.name) === nameKey && same(track?.attributes?.artistName) === artistKey) similar = true;
      }
      if (!response.data.next || !data.length) break;
      offset += data.length;
    }
    // Se recorre la playlist entera antes: un ID exacto en otra página tiene prioridad sobre la coincidencia por nombre.
    if (similar) return { status: 'already', title, similar: true };
    if (music.nowPlayingItem !== item) return { status: 'changed' };
    const body = JSON.stringify({ data: [{ id: catalogId ?? libraryId, type: catalogId ? 'songs' : 'library-songs' }] });
    // Un solo efecto: sin reintentos aunque falle la respuesta.
    // MusicKit 2642 (web de Apple) toma method/body de las opciones directas e ignora fetchOptions: con sólo
    // fetchOptions el pedido salía como GET, respondía 200 y no agregaba nada. Se mandan ambas formas, iguales.
    let response;
    try { response = await within(music.api.music(tracks, {}, { method: 'POST', body, fetchOptions: { method: 'POST', body } }), 30000); }
    catch (error) { return { status: error?.elMusicTimeout ? 'unknown' : 'failed' }; }
    // Un GET devuelve la lista de pistas; un POST real responde 201/204 (o 200 sin listado). Si no, no se afirma que se agregó.
    const status = Number(response?.status);
    const listing = (Array.isArray(response?.data?.data) && response.data.data.some(entry => entry?.type !== 'library-playlists')) || !!response?.data?.next;
    if (![200, 201, 204].includes(status) || listing) return { status: 'unknown' };
    return { status: 'added', title };
    };
    const result = await add();
    // Si esa playlist está abierta, music-shell la vuelve a pedir para que se vea el tema nuevo.
    if (result.status === 'added' && typeof document !== 'undefined' && typeof CustomEvent === 'function')
      try { document.dispatchEvent(new CustomEvent('el-music-playlist-added', { detail: ${JSON.stringify(playlistId)} })); } catch { /* sin refresco */ }
    // Aviso visible en la app: textContent sin HTML, cierre solo por fade. No demora la respuesta al plugin.
    if (typeof document !== 'undefined' && ['added', 'already', 'failed', 'unknown', 'check-failed'].includes(result.status) && shown) {
      void (async () => {
        const clean = value => typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
        const describe = playlist => result.status === 'added' ? 'Added to ' + playlist : result.status === 'already' ? (result.similar ? 'Same title and artist already in ' : 'Already in ') + playlist :
          result.status === 'unknown' ? 'Could not confirm it was added to ' + playlist : 'Could not add to ' + playlist;
        const song = [clean(shown.artistName ?? shown.attributes?.artistName), clean(shown.title ?? shown.attributes?.name)].filter(Boolean).join(' – ');
        // El aviso sale enseguida; el nombre de la playlist se completa si la lectura responde (sólo cuando la escritura no falló).
        document.getElementById('el-music-toast')?.remove();
        const box = document.createElement('div'); box.id = 'el-music-toast'; box.className = 'el-music-toast'; box.setAttribute('role', 'status');
        const detail = document.createElement('div'); detail.className = 'el-music-toast__detail'; detail.textContent = describe('playlist');
        if (song) { const row = document.createElement('div'); row.textContent = song; box.appendChild(row); }
        box.appendChild(detail); document.body.appendChild(box);
        setTimeout(() => box.classList.add('el-music-toast--hide'), 2800);
        setTimeout(() => box.remove(), 3600);
        if (!['added', 'already'].includes(result.status)) return;
        let timer;
        const response = await Promise.race([music.api.music('/v1/me/library/playlists/' + ${JSON.stringify(playlistId)}),
          new Promise((_, reject) => { timer = setTimeout(reject, 2500); })]).finally(() => clearTimeout(timer));
        const name = clean(response?.data?.data?.[0]?.attributes?.name);
        if (name) detail.textContent = describe(name);
      })().catch(() => {});
    }
    return result;
  })()`;
}

const statuses = ['ok', 'unavailable', 'signed-out', 'nothing-playing', 'not-a-song', 'already', 'added', 'changed', 'check-failed', 'unknown', 'failed'];
export function controlResult(action: ControlAction, value: unknown): ControlOutcome {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const status = statuses.includes(data.status as string) ? data.status as string : 'failed';
  const success = action === 'addToPlaylist' ? ['added', 'already'].includes(status) : status === 'ok';
  if (!success) return { ok: false, error: status };
  const bounded = (text: unknown): string => typeof text === 'string' ? text.slice(0, 200) : '';
  if (action === 'playlists') {
    const list = Array.isArray(data.playlists) ? data.playlists.slice(0, 1000) : [];
    return { ok: true, data: { playlists: list.filter((item): item is { id: string; name: string } => !!item && typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' && playlistPattern.test((item as { id: string }).id) && typeof (item as { name?: unknown }).name === 'string')
      .map(item => ({ id: item.id, name: bounded(item.name) })) } };
  }
  if (action === 'addToPlaylist') return { ok: true, data: { result: status, title: bounded(data.title) } };
  return { ok: true, data: { playing: data.playing === true } };
}

export interface ControlServer { close(): void }
export type MusicRunner = (script: string) => Promise<unknown> | undefined;
// Mostrar/minimizar la ventana lo resuelve main: no pasa por la página de Apple.
export type WindowToggle = () => 'shown' | 'minimized' | undefined;

export function startControlServer(endpoint: string, run: MusicRunner, version: string,
  log: (message: string) => void, toggleWindow: WindowToggle = () => undefined): ControlServer | undefined {
  const clients = new Set<net.Socket>();
  let mutation = false;
  let playlists: Promise<ControlOutcome> | undefined;
  const handle = async (request: ControlRequest): Promise<ControlOutcome> => {
    if (request.action === 'hello') return { ok: true, data: { app: 'ElMusic', protocol: controlProtocol, version } };
    if (request.action === 'toggleWindow') { const window = toggleWindow(); return window ? { ok: true, data: { window } } : { ok: false, error: 'unavailable' }; }
    if (request.action === 'addToPlaylist' && mutation) return { ok: false, error: 'busy' };
    // Una sola lectura de playlists en vuelo, compartida: evita multiplicar llamadas a Apple con la cuenta.
    if (request.action === 'playlists' && playlists) return playlists;
    const script = request.action === 'state' ? controlStateScript : request.action === 'playlists' ? controlPlaylistsScript :
      request.action === 'addToPlaylist' ? controlAddToPlaylistScript(request.playlistId!) : controlTransportScript(request.action);
    const execute = async (): Promise<ControlOutcome> => {
      const pending = run(script);
      if (!pending) return { ok: false, error: 'unavailable' };
      if (request.action !== 'addToPlaylist') return controlResult(request.action, await pending.catch(() => ({ status: 'failed' })));
      // El cerrojo se libera aunque la página no conteste; el resultado queda como desconocido, nunca como reintento.
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), mutationLimit); });
      try { return controlResult(request.action, await Promise.race([pending.catch(() => ({ status: 'failed' })), limit])); }
      finally { clearTimeout(timer); }
    };
    if (request.action === 'playlists') { playlists = execute().finally(() => { playlists = undefined; }); return playlists; }
    if (request.action === 'addToPlaylist') mutation = true;
    try { return await execute(); }
    finally { if (request.action === 'addToPlaylist') mutation = false; }
  };
  const server = net.createServer(socket => {
    if (clients.size >= maxClients) { socket.destroy(); return; }
    clients.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let pending = 0;
    const reply = (value: ControlReply): void => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > maxBuffer) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line) continue;
        const request = parseControlRequest(line);
        if (!request) { reply({ id: null, ok: false, error: 'bad-request' }); continue; }
        if (pending >= maxPendingPerClient) { reply({ id: request.id, ok: false, error: 'busy' }); continue; }
        pending++;
        void handle(request).then(result => reply({ id: request.id, ...result }),
          () => reply({ id: request.id, ok: false, error: 'failed' })).finally(() => { pending--; });
      }
    });
    socket.on('error', () => { /* El cliente local puede cortar sin aviso. */ });
    socket.on('close', () => clients.delete(socket));
  });
  if (process.platform !== 'win32') {
    try {
      fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
      // Instancia única: un socket viejo sólo puede ser de un cierre abrupto anterior.
      if (fs.lstatSync(endpoint, { throwIfNoEntry: false })?.isSocket()) fs.unlinkSync(endpoint);
    } catch { log('No se pudo preparar el canal Stream Deck'); return; }
  }
  server.on('error', () => log('Canal Stream Deck no disponible'));
  server.listen(endpoint, () => {
    if (process.platform !== 'win32') { try { fs.chmodSync(endpoint, 0o600); } catch { log('No se pudieron restringir permisos del canal Stream Deck'); } }
    log('Canal Stream Deck activo');
  });
  return { close: () => {
    for (const socket of clients) socket.destroy();
    server.close();
    if (process.platform !== 'win32') { try { if (fs.lstatSync(endpoint, { throwIfNoEntry: false })?.isSocket()) fs.unlinkSync(endpoint); } catch { /* Ya no existe. */ } }
  } };
}
