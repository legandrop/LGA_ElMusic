import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import { inflateRawSync, crc32 } from 'node:zlib';
import { controlAddToPlaylistScript, controlEndpoint, controlPlaylistsScript, controlResult, controlStateScript, controlTransportScript,
  parseControlRequest, startControlServer } from '../src/remote-control';

const repo = path.resolve(__dirname, '..', '..');
const plugin = path.join(repo, 'streamdeck', 'com.lga.elmusic.sdPlugin', 'bin');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const client = require(path.join(plugin, 'control-client.js')) as {
  controlEndpoint: (platform: string, username: string, home: string) => string;
  ControlClient: new (endpoint: string) => { request: (action: string, extra?: object, timeout?: number) => Promise<Record<string, unknown>>; close: () => void };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const websocket = require(path.join(plugin, 'websocket.js')) as {
  encodeFrame: (text: string, opcode?: number) => Buffer;
  decodeFrames: (buffer: Buffer) => { frames: Array<{ fin: boolean; opcode: number; payload: Buffer }>; rest: Buffer };
};

interface Init { method?: string; body?: string; fetchOptions?: { method?: string; body?: string } }
interface Track { id: string; type?: string; attributes?: { name?: string; artistName?: string; playParams?: Record<string, unknown> } }
function musicFixture(options: { playing?: boolean; time?: number; item?: Record<string, unknown> | null; authorized?: boolean;
  tracks?: Track[][]; tracksError?: unknown; playlists?: Array<Array<Record<string, unknown>>>; postError?: unknown; document?: unknown;
  legacy?: boolean; postResponse?: Record<string, unknown> } = {}) {
  const calls: Array<{ path: string; query: Record<string, unknown>; init?: Init }> = [];
  const commands: string[] = [];
  const item = options.item === undefined ? { id: '123', type: 'songs', title: 'Song  A', playParams: { id: '123', kind: 'song' } } : options.item;
  const music: Record<string, unknown> = {
    isPlaying: options.playing ?? false, currentPlaybackTime: options.time ?? 0, nowPlayingItem: item, isAuthorized: options.authorized ?? true,
    play: async () => { commands.push('play'); music.isPlaying = true; },
    pause: async () => { commands.push('pause'); music.isPlaying = false; },
    skipToNextItem: async () => { commands.push('next'); }, skipToPreviousItem: async () => { commands.push('previous'); },
    seekToTime: async (time: number) => { commands.push(`seek:${time}`); },
    api: { music: async (pathName: string, query: Record<string, unknown>, init?: Init) => {
      calls.push({ path: pathName, query, init });
      // MusicKit 2642 lee method/body de las opciones directas; legacy simula la versión que leía fetchOptions.
      const method = options.legacy ? init?.fetchOptions?.method : init?.method;
      if (method === 'POST') { if (options.postError) throw options.postError; return options.postResponse ?? { status: 204, data: {} }; }
      if (pathName === '/v1/me/library/playlists') {
        const pages = options.playlists ?? [[]]; const page = pages[Math.floor(Number(query.offset) / 100)] ?? [];
        return { data: { data: page, next: Number(query.offset) / 100 + 1 < pages.length ? 'next' : undefined } };
      }
      if (pathName === '/v1/me/library/playlists/p.Test1') return { data: { data: [{ id: 'p.Test1', attributes: { name: 'New  Finds++++' } }] } };
      if (options.tracksError) throw options.tracksError;
      const pages = options.tracks ?? [[]]; const index = Math.floor(Number(query.offset) / 100);
      return { data: { data: pages[index] ?? [], next: index + 1 < pages.length ? 'next' : undefined } };
    } }
  };
  for (const name of ['developerToken', 'musicUserToken']) Object.defineProperty(music, name, { get: () => { throw new Error('No leer credenciales'); } });
  const frame = {};
  const context = vm.createContext({ MusicKit: { getInstance: () => music }, top: frame, self: frame, URL, setTimeout, clearTimeout, location: new URL('https://music.apple.com/ar/new'),
    CustomEvent: class { constructor(public type: string, public init: { detail?: unknown }) {} }, ...(options.document ? { document: options.document } : {}) });
  return { run: (script: string) => vm.runInContext(script, context) as Promise<Record<string, unknown>>, calls, commands, music };
}
const page = (count: number, start = 0): Track[] => Array.from({ length: count }, (_, index) => ({ id: `i.lib${start + index}`, attributes: { playParams: { id: `i.lib${start + index}`, catalogId: String(9000 + start + index) } } }));

test('el endpoint del plugin coincide con el de la app y no usa puertos', () => {
  for (const [platform, user, home] of [['win32', 'ana-pc', 'C:\\Users\\ana-pc'], ['win32', 'Usuário Ñ', 'C:\\Users\\x'], ['darwin', 'ana', '/Users/ana']]) {
    assert.equal(client.controlEndpoint(platform, user, home), controlEndpoint(platform as NodeJS.Platform, user, home));
  }
  assert.equal(controlEndpoint('win32', 'ana-pc', ''), '\\\\.\\pipe\\ElMusic-control-ana-pc');
  assert.equal(controlEndpoint('darwin', 'ana', '/Users/ana'), '/Users/ana/Library/Application Support/LGA/ElMusic/control.sock');
  assert.equal(controlEndpoint('win32', 'a\\b:c', ''), '\\\\.\\pipe\\ElMusic-control-a_b_c');
});

test('el canal acepta sólo acciones cerradas con argumentos exactos', () => {
  assert.deepEqual(parseControlRequest('{"id":1,"action":"next"}'), { id: 1, action: 'next' });
  assert.deepEqual(parseControlRequest('{"id":2,"action":"addToPlaylist","playlistId":"p.AbC123"}'), { id: 2, action: 'addToPlaylist', playlistId: 'p.AbC123' });
  for (const line of ['{"id":1,"action":"seek"}', '{"id":0,"action":"next"}', '{"id":1.5,"action":"next"}', '{"id":1,"action":"next","playlistId":"p.A"}',
    '{"id":1,"action":"addToPlaylist"}', '{"id":1,"action":"addToPlaylist","playlistId":"pl.A"}', '{"id":1,"action":"addToPlaylist","playlistId":"p.A/../x"}',
    '{"id":1,"action":"next","script":"x"}', '[1]', 'nope', `{"id":1,"action":"next","x":"${'a'.repeat(600)}"}`]) {
    assert.equal(parseControlRequest(line), undefined, line);
  }
  assert.throws(() => controlAddToPlaylistScript('p.x"});alert(1)//'));
});

test('transporte usa comandos públicos y anterior reinicia el tema pasados 3 s', async () => {
  const paused = musicFixture({ playing: false });
  assert.deepEqual({ ...(await paused.run(controlTransportScript('playPause'))) }, { status: 'ok', playing: true });
  const playing = musicFixture({ playing: true, time: 12 });
  await playing.run(controlTransportScript('playPause')); await playing.run(controlTransportScript('previous')); await playing.run(controlTransportScript('next'));
  assert.deepEqual(playing.commands, ['pause', 'seek:0', 'next']);
  const early = musicFixture({ time: 1 });
  await early.run(controlTransportScript('previous'));
  assert.deepEqual(early.commands, ['previous']);
  assert.equal((await musicFixture({ item: null }).run(controlTransportScript('playPause'))).status, 'nothing-playing');
  assert.deepEqual({ ...(await musicFixture({ playing: true }).run(controlStateScript)) }, { status: 'ok', playing: true, item: true });
});

test('fuera de music.apple.com no se ejecuta nada', async () => {
  const frame = {};
  const context = vm.createContext({ MusicKit: { getInstance: () => { throw new Error('no'); } }, top: frame, self: frame, URL, location: new URL('https://evil.example/') });
  assert.equal((await vm.runInContext(controlStateScript, context)).status, 'unavailable');
});

test('playlists lista sólo las editables, paginando', async () => {
  const fixture = musicFixture({ playlists: [[...Array.from({ length: 99 }, (_, i) => ({ id: `p.A${i}`, attributes: { name: `List ${i}`, canEdit: true } })), { id: 'p.Smart', attributes: { name: 'Smart', canEdit: false } }],
    [{ id: 'p.Last', attributes: { name: ' New  Finds++++ ', canEdit: true } }, { id: 'bad', attributes: { name: 'x', canEdit: true } }]] });
  const result = await fixture.run(controlPlaylistsScript);
  const playlists = result.playlists as Array<{ id: string; name: string }>;
  assert.equal(playlists.length, 100);
  assert.deepEqual({ ...playlists.at(-1) }, { id: 'p.Last', name: 'New Finds++++' });
  assert.deepEqual(fixture.calls.map(call => call.query.offset), [0, 100]);
  assert.equal((await musicFixture({ authorized: false }).run(controlPlaylistsScript)).status, 'signed-out');
});

test('agregar a playlist escribe una vez el tema en reproducción si no estaba', async () => {
  const fixture = musicFixture({ tracks: [page(100), page(20, 100)] });
  const result = await fixture.run(controlAddToPlaylistScript('p.Test1'));
  assert.deepEqual({ ...result }, { status: 'added', title: 'Song A' });
  const posts = fixture.calls.filter(call => call.init?.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/v1/me/library/playlists/p.Test1/tracks');
  assert.deepEqual(JSON.parse(posts[0].init!.body!), { data: [{ id: '123', type: 'songs' }] });
  assert.deepEqual(fixture.calls.filter(call => !call.init).map(call => call.query.offset), [0, 100]);
});

test('no duplica: el tema ya presente por catálogo o biblioteca no se escribe', async () => {
  const byCatalog = musicFixture({ tracks: [page(100), [{ id: 'i.other', attributes: { playParams: { id: 'i.other', catalogId: '123' } } }]] });
  assert.equal((await byCatalog.run(controlAddToPlaylistScript('p.Test1'))).status, 'already');
  assert.equal(byCatalog.calls.some(call => call.init), false);
  const library = musicFixture({ item: { id: 'i.mine', type: 'library-songs', title: 'Mine', playParams: { id: 'i.mine', kind: 'song', isLibrary: true } },
    tracks: [[{ id: 'i.mine', attributes: { playParams: { id: 'i.mine', isLibrary: true } } }]] });
  assert.equal((await library.run(controlAddToPlaylistScript('p.Test1'))).status, 'already');
  const libraryNew = musicFixture({ item: { id: 'i.mine', type: 'library-songs', title: 'Mine', playParams: { id: 'i.mine', kind: 'song', isLibrary: true } } });
  assert.equal((await libraryNew.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
  assert.deepEqual(JSON.parse(libraryNew.calls.at(-1)!.init!.body!), { data: [{ id: 'i.mine', type: 'library-songs' }] });
  const preferCatalog = musicFixture({ item: { id: 'i.mine', type: 'library-songs', playParams: { id: 'i.mine', kind: 'song', isLibrary: true, catalogId: '555' } } });
  await preferCatalog.run(controlAddToPlaylistScript('p.Test1'));
  assert.deepEqual(JSON.parse(preferCatalog.calls.at(-1)!.init!.body!), { data: [{ id: '555', type: 'songs' }] });
});

test('sin poder comprobar duplicados no escribe; playlist vacía (404) sí', async () => {
  const failing = musicFixture({ tracksError: { status: 500 } });
  assert.equal((await failing.run(controlAddToPlaylistScript('p.Test1'))).status, 'check-failed');
  assert.equal(failing.calls.some(call => call.init), false);
  for (const tracksError of [{ errorCode: 'NOT_FOUND', data: { status: 405 } }, { errorCode: 'NOT_FOUND' }, { errorCode: 'NOT_FOUND', data: { errors: [{ status: '404' }] } }]) {
    const failClosed = musicFixture({ tracksError });
    assert.equal((await failClosed.run(controlAddToPlaylistScript('p.Test1'))).status, 'check-failed');
    assert.equal(failClosed.calls.some(call => call.init), false);
  }
  const empty = musicFixture({ tracksError: { errorCode: 'NOT_FOUND', data: { status: 404 } } });
  assert.equal((await empty.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
  for (const [options, status] of [[{ authorized: false }, 'signed-out'], [{ item: null }, 'nothing-playing'],
    [{ item: { id: '9', type: 'music-videos', playParams: { id: '9', kind: 'musicVideo' } } }, 'not-a-song'], [{ postError: new Error('x') }, 'failed']] as const) {
    const fixture = musicFixture(options);
    assert.equal((await fixture.run(controlAddToPlaylistScript('p.Test1'))).status, status);
    assert.ok(fixture.calls.filter(call => call.init).length <= 1);
  }
});

test('si el tema cambió durante la comprobación no se escribe', async () => {
  const fixture = musicFixture();
  const api = fixture.music.api as { music: (...args: unknown[]) => Promise<unknown> };
  const original = api.music;
  api.music = async (...args: unknown[]) => { const value = await original(...args); fixture.music.nowPlayingItem = { id: '777', type: 'songs', playParams: { id: '777', kind: 'song' } }; return value; };
  assert.equal((await fixture.run(controlAddToPlaylistScript('p.Test1'))).status, 'changed');
  assert.equal(fixture.calls.some(call => call.init), false);
});

test('los resultados de la página se validan antes de salir por el canal', () => {
  assert.deepEqual(controlResult('addToPlaylist', { status: 'added', title: 'x'.repeat(300) }), { ok: true, data: { result: 'added', title: 'x'.repeat(200) } });
  assert.deepEqual(controlResult('addToPlaylist', { status: 'weird' }), { ok: false, error: 'failed' });
  assert.deepEqual(controlResult('next', { status: 'ok', playing: 'yes' }), { ok: true, data: { playing: false } });
  assert.deepEqual(controlResult('playlists', { status: 'ok', playlists: [{ id: 'p.A', name: 'A' }, { id: 'x', name: 'B' }, null] }), { ok: true, data: { playlists: [{ id: 'p.A', name: 'A' }] } });
});

test('servidor local: saludo, una sola escritura en vuelo y vista no lista', async () => {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ElMusic-test-${process.pid}` : path.join(os.tmpdir(), `elmusic-test-${process.pid}.sock`);
  let release: (value: unknown) => void = () => {};
  let ready = true;
  const scripts: string[] = [];
  const server = startControlServer(endpoint, script => {
    if (!ready) return undefined;
    scripts.push(script);
    return script.includes('/tracks') ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ status: 'ok', playing: true });
  }, '9.9.9', () => {});
  assert.ok(server);
  await new Promise(resolve => setTimeout(resolve, 100));
  const peer = new client.ControlClient(endpoint);
  try {
    assert.deepEqual(await peer.request('hello'), { app: 'ElMusic', protocol: 1, version: '9.9.9' });
    const first = peer.request('addToPlaylist', { playlistId: 'p.Test1' });
    await new Promise(resolve => setTimeout(resolve, 50));
    await assert.rejects(peer.request('addToPlaylist', { playlistId: 'p.Test1' }), /busy/);
    release({ status: 'added', title: 'T' });
    assert.deepEqual(await first, { result: 'added', title: 'T' });
    assert.deepEqual(await peer.request('state'), { playing: true });
    ready = false;
    await assert.rejects(peer.request('next'), /unavailable/);
    await assert.rejects(peer.request('seek', {}, 300), /timeout/);
    assert.equal(scripts.filter(script => script.includes('/tracks')).length, 1);
    ready = true;
    const burst = await Promise.allSettled(Array.from({ length: 6 }, () => peer.request('state', {}, 2000)));
    assert.ok(burst.some(result => result.status === 'rejected' && /busy/.test(String(result.reason))));
    assert.ok(burst.some(result => result.status === 'fulfilled'));
  } finally { peer.close(); server!.close(); }
});

test('frames WebSocket del plugin: máscara, longitudes extendidas y restos parciales', () => {
  for (const text of ['hola', 'x'.repeat(300), 'ñ'.repeat(40000)]) {
    const frame = websocket.encodeFrame(text);
    assert.equal(frame[1] & 0x80, 0x80);
    const { frames, rest } = websocket.decodeFrames(frame);
    assert.equal(frames[0].payload.toString('utf8'), text); assert.equal(rest.length, 0);
    const partial = websocket.decodeFrames(frame.subarray(0, frame.length - 1));
    assert.equal(partial.frames.length, 0); assert.equal(partial.rest.length, frame.length - 1);
  }
  const server = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
  assert.equal(websocket.decodeFrames(server).frames[0].payload.toString(), 'ok');
});

test('el paquete .streamDeckPlugin lleva la versión de package.json y archivos íntegros', async () => {
  const pack = await (new Function('specifier', 'return import(specifier)'))(path.join(repo, 'scripts', 'pack-streamdeck.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:')) as { packStreamDeck: (output: string) => Promise<{ output: string; version: string }> };
  const output = path.join(os.tmpdir(), `elmusic-pack-${process.pid}.streamDeckPlugin`);
  try {
    const { version } = await pack.packStreamDeck(output);
    const zip = fs.readFileSync(output);
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    let cursor = zip.readUInt32LE(end + 16); const count = zip.readUInt16LE(end + 10);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16), size = zip.readUInt32LE(cursor + 20), nameLength = zip.readUInt16LE(cursor + 28), offset = zip.readUInt32LE(cursor + 42);
      const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'); names.push(name);
      const localName = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
      const body = zip.subarray(offset + 30 + localName + extra, offset + 30 + localName + extra + size);
      const data = method === 8 ? inflateRawSync(body) : body;
      assert.equal(crc32(data) >>> 0, crc, name);
      if (name.endsWith('manifest.json')) assert.equal(JSON.parse(data.toString('utf8')).Version, `${version}.0`);
      cursor += 46 + nameLength;
    }
    assert.ok(names.every(name => name.startsWith('com.lga.elmusic.sdPlugin/')));
    for (const required of ['manifest.json', 'bin/plugin.js', 'bin/launcher.js', 'imgs/keys/window@2x.png', 'ui/playlist.html', 'imgs/keys/play@2x.png', 'imgs/keys/addtoplaylist.png', 'imgs/category.svg'])
      assert.ok(names.includes(`com.lga.elmusic.sdPlugin/${required}`), required);
  } finally { fs.rmSync(output, { force: true }); }
});

test('cada imagen del manifest existe en PNG con @2x o en SVG', () => {
  const base = path.join(repo, 'streamdeck', 'com.lga.elmusic.sdPlugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')) as { Icon: string; CategoryIcon: string; CodePath: string;
    Actions: Array<{ Icon: string; PropertyInspectorPath?: string; States: Array<{ Image: string }> }> };
  const images = [manifest.Icon, manifest.CategoryIcon, ...manifest.Actions.flatMap(action => [action.Icon, ...action.States.map(state => state.Image)])];
  for (const image of images) {
    const file = path.join(base, image);
    assert.ok(fs.existsSync(`${file}.svg`) || (fs.existsSync(`${file}.png`) && fs.existsSync(`${file}@2x.png`)), image);
  }
  for (const file of [manifest.CodePath, ...manifest.Actions.flatMap(action => action.PropertyInspectorPath ?? [])]) assert.ok(fs.existsSync(path.join(base, file)), file);
});
test('plugin de punta a punta contra un Stream Deck simulado y la app', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { start } = require(path.join(plugin, 'plugin.js')) as { start: (options: Record<string, unknown>) => void };
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ElMusic-e2e-${process.pid}` : path.join(os.tmpdir(), `elmusic-e2e-${process.pid}.sock`);
  const app = startControlServer(endpoint, script => Promise.resolve(script.includes('/tracks') ? { status: 'added', title: 'T' } :
    script.includes('/v1/me/library/playlists') ? { status: 'ok', playlists: [{ id: 'p.Test1', name: 'New Finds++++' }] } : { status: 'ok', playing: true }), '0.0.0', () => {});
  const received: Array<Record<string, unknown>> = [];
  let peer: Socket | undefined;
  const deck = http.createServer();
  deck.on('upgrade', (request, socket: Socket) => {
    const accept = crypto.createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    peer = socket;
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      const { frames, rest } = websocket.decodeFrames(Buffer.concat([pending, chunk])); pending = Buffer.from(rest);
      for (const frame of frames) received.push(JSON.parse(frame.payload.toString('utf8')));
    });
  });
  await new Promise<void>(resolve => deck.listen(0, '127.0.0.1', resolve));
  const port = (deck.address() as { port: number }).port;
  const send = (message: object): void => { const payload = Buffer.from(JSON.stringify(message)); peer!.write(Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]), payload])); };
  const until = async (match: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) { const found = received.find(match); if (found) return found; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Mensaje no recibido');
  };
  let closed = false;
  try {
    start({ port, uuid: 'PLUGIN', registerEvent: 'registerPlugin', endpoint, onClose: () => { closed = true; } });
    await until(message => message.event === 'registerPlugin' && message.uuid === 'PLUGIN');
    const add = 'com.lga.elmusic.addtoplaylist';
    send({ event: 'willAppear', action: add, context: 'A', payload: { settings: { playlistId: 'p.Test1', playlistName: 'New Finds++++' } } });
    await until(message => message.event === 'setTitle' && message.context === 'A' && (message.payload as { title: string }).title === 'New Finds++++');
    send({ event: 'keyDown', action: add, context: 'A', payload: {} });
    await until(message => message.event === 'showOk' && message.context === 'A');
    send({ event: 'sendToPlugin', context: 'INSPECTOR', payload: { request: 'playlists' } });
    const list = await until(message => message.event === 'sendToPropertyInspector' && message.context === 'INSPECTOR' && message.action === add);
    assert.deepEqual(list.payload, { playlists: [{ id: 'p.Test1', name: 'New Finds++++' }] });
    // Con la imagen que dibujó el inspector, la tecla la muestra sin título; una imagen que no es PNG en base64 se ignora.
    const image = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    send({ event: 'willAppear', action: add, context: 'I', payload: { settings: { playlistId: 'p.Test1', playlistName: 'Larga', image } } });
    await until(message => message.event === 'setImage' && message.context === 'I' && (message.payload as { image?: string }).image === image);
    await until(message => message.event === 'setTitle' && message.context === 'I' && (message.payload as { title: string }).title === '');
    send({ event: 'didReceiveSettings', action: add, context: 'J', payload: { settings: { playlistId: 'p.Test1', playlistName: 'Otra', image: 'javascript:alert(1)' } } });
    send({ event: 'willAppear', action: add, context: 'J', payload: { settings: { playlistId: 'p.Test1', playlistName: 'Otra', image: 'javascript:alert(1)' } } });
    await until(message => message.event === 'setTitle' && message.context === 'J' && (message.payload as { title: string }).title === 'Otra');
    assert.ok(received.some(message => message.event === 'setImage' && message.context === 'J' && !('image' in (message.payload as object))));
    send({ event: 'willAppear', action: add, context: 'B', payload: { settings: {} } });
    send({ event: 'keyDown', action: add, context: 'B', payload: {} });
    await until(message => message.event === 'showAlert' && message.context === 'B');
    send({ event: 'willAppear', action: 'com.lga.elmusic.playpause', context: 'P', payload: { settings: {} } });
    await until(message => message.event === 'setState' && message.context === 'P' && (message.payload as { state: number }).state === 1);
    send({ event: 'keyDown', action: 'com.evil.other', context: 'X', payload: {} });
    assert.equal(received.filter(message => message.event === 'showOk').length, 1);
  } finally {
    peer?.destroy(); deck.close(); app!.close();
    for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(closed, true);
});
test('agregar muestra en la app «Artista – Tema» y la playlist, con texto plano y sin demorar la respuesta', async () => {
  interface Node { id: string; className: string; textContent: string; children: Node[]; attributes: Record<string, string>; removed: boolean }
  const appended: Node[] = [];
  const element = (): Node & Record<string, unknown> => {
    const node = { id: '', className: '', textContent: '', children: [] as Node[], attributes: {} as Record<string, string>, removed: false } as Node & Record<string, unknown>;
    node.setAttribute = (name: string, value: string) => { node.attributes[name] = value; };
    node.appendChild = (child: Node) => { node.children.push(child); };
    node.remove = () => { node.removed = true; };
    node.classList = { add: (name: string) => { node.className += ' ' + name; } };
    return node;
  };
  const document = { createElement: element, getElementById: (id: string) => appended.find(node => node.id === id && !node.removed), body: { appendChild: (node: Node) => { appended.push(node); } } };
  const item = { id: '123', type: 'songs', title: 'IWUDLYK', artistName: 'Modeselektor <b>x</b>', playParams: { id: '123', kind: 'song' } };
  const fixture = musicFixture({ item, document });
  assert.deepEqual({ ...(await fixture.run(controlAddToPlaylistScript('p.Test1'))) }, { status: 'added', title: 'IWUDLYK' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0].children.map(child => child.textContent), ['Modeselektor <b>x</b> – IWUDLYK', 'Added to New Finds++++']);
  assert.equal(appended[0].attributes.role, 'status');
  const again = musicFixture({ item, document, tracks: [[{ id: 'i.x', attributes: { playParams: { id: 'i.x', catalogId: '123' } } }]] });
  await again.run(controlAddToPlaylistScript('p.Test1')); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(appended[0].removed, true); assert.equal(appended[1].children[1].textContent, 'Already in New Finds++++');
  const silent = musicFixture({ item: null, document });
  await silent.run(controlAddToPlaylistScript('p.Test1')); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(appended.length, 2);
});

test('no duplica otra edición con igual título y artista; otra versión con otro título sí se agrega', async () => {
  const item = { id: '123', type: 'songs', title: 'Empty and Silent (feat. King Krule)', artistName: 'Mount Kimbie & King Krule', playParams: { id: '123', kind: 'song' } };
  const edition = (name: string, artistName: string): Track => ({ id: 'i.ed', attributes: { name, artistName, playParams: { id: 'i.ed', catalogId: '456' } } });
  const similar = musicFixture({ item, tracks: [[edition('empty  and SILENT (feat. King Krule)', 'Mount Kimbie & King Krule')]] });
  assert.deepEqual({ ...(await similar.run(controlAddToPlaylistScript('p.Test1'))) }, { status: 'already', title: item.title, similar: true });
  assert.equal(similar.calls.some(call => call.init), false);
  assert.deepEqual(controlResult('addToPlaylist', { status: 'already', title: 'x', similar: true }), { ok: true, data: { result: 'already', title: 'x' } });
  for (const [name, artist] of [['Empty and Silent (feat. King Krule) [Live]', 'Mount Kimbie & King Krule'], ['Empty and Silent (feat. King Krule)', 'Mount Kimbie']]) {
    const other = musicFixture({ item, tracks: [[edition(name, artist)]] });
    assert.equal((await other.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
  }
  // Un ID exacto en una página posterior tiene prioridad: «already» sin la marca de similar.
  const exact = musicFixture({ item, tracks: [[...page(99), edition(item.title, item.artistName)], [{ id: 'i.x', attributes: { playParams: { id: 'i.x', catalogId: '123' } } }]] });
  assert.deepEqual({ ...(await exact.run(controlAddToPlaylistScript('p.Test1'))) }, { status: 'already', title: item.title });
  // Sin artista en el tema que suena no se compara por nombre.
  const noArtist = musicFixture({ item: { ...item, artistName: undefined }, tracks: [[edition(item.title, item.artistName)]] });
  assert.equal((await noArtist.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
});

test('agregar manda un POST real en el MusicKit actual y en el anterior, y no afirma éxito si la respuesta parece una lectura', async () => {
  for (const legacy of [false, true]) {
    const fixture = musicFixture({ legacy });
    assert.equal((await fixture.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
    const post = fixture.calls.at(-1)!.init!;
    assert.equal(post.method, 'POST'); assert.equal(post.fetchOptions?.method, 'POST'); assert.equal(post.body, post.fetchOptions?.body);
  }
  // Si MusicKit volviera a ignorar el método, la «escritura» devolvería la lista de pistas: estado incierto, no «added».
  const listing = musicFixture({ postResponse: { status: 200, data: { data: page(3) } } });
  assert.equal((await listing.run(controlAddToPlaylistScript('p.Test1'))).status, 'unknown');
  const resources = musicFixture({ postResponse: { status: 200, data: { data: [{ id: 'p.Test1', type: 'library-playlists' }] } } });
  assert.equal((await resources.run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
  const rejected = musicFixture({ postResponse: { status: 500, data: {} } });
  assert.equal((await rejected.run(controlAddToPlaylistScript('p.Test1'))).status, 'unknown');
});

test('el botón avisa a la página para refrescar la playlist sólo si la escritura quedó confirmada', async () => {
  const events: Array<{ type: string; init: { detail?: unknown } }> = [];
  const document = { dispatchEvent: (event: { type: string; init: { detail?: unknown } }) => { events.push(event); return true; } };
  assert.equal((await musicFixture({ document }).run(controlAddToPlaylistScript('p.Test1'))).status, 'added');
  assert.deepEqual(events.map(event => [event.type, event.init.detail]), [['el-music-playlist-added', 'p.Test1']]);
  for (const options of [{ tracks: [[{ id: 'i.x', attributes: { playParams: { id: 'i.x', catalogId: '123' } } }]] }, { postError: new Error('x') },
    { postResponse: { status: 200, data: { data: page(2) } } }]) await musicFixture({ ...options, document }).run(controlAddToPlaylistScript('p.Test1'));
  assert.equal(events.length, 1);
});

test('Open / Minimize: el canal alterna la ventana en main y, sin app, el plugin la abre una sola vez', async () => {
  assert.deepEqual(parseControlRequest('{"id":1,"action":"toggleWindow"}'), { id: 1, action: 'toggleWindow' });
  assert.equal(parseControlRequest('{"id":1,"action":"toggleWindow","playlistId":"p.A"}'), undefined);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { start } = require(path.join(plugin, 'plugin.js')) as { start: (options: Record<string, unknown>) => void };
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\ElMusic-window-${process.pid}` : path.join(os.tmpdir(), `elmusic-window-${process.pid}.sock`);
  const toggles: string[] = [];
  let launches = 0;
  const received: Array<Record<string, unknown>> = [];
  let peer: Socket | undefined;
  const deck = http.createServer();
  deck.on('upgrade', (request, socket: Socket) => {
    const accept = crypto.createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    peer = socket;
    socket.on('data', chunk => { for (const frame of websocket.decodeFrames(chunk).frames) received.push(JSON.parse(frame.payload.toString('utf8'))); });
  });
  await new Promise<void>(resolve => deck.listen(0, '127.0.0.1', resolve));
  const send = (message: object): void => { const payload = Buffer.from(JSON.stringify(message)); peer!.write(Buffer.concat([Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]), payload])); };
  const count = (event: string): number => received.filter(message => message.event === event && message.context === 'W').length;
  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Condición no cumplida');
  };
  let app: ReturnType<typeof startControlServer> = undefined;
  try {
    start({ port: (deck.address() as { port: number }).port, uuid: 'PLUGIN', registerEvent: 'registerPlugin', endpoint,
      launch: () => { launches++; return 'launched'; }, onClose: () => {} });
    await until(() => received.some(message => message.event === 'registerPlugin'));
    const key = { event: 'keyDown', action: 'com.lga.elmusic.window', context: 'W', payload: {} };
    send({ event: 'willAppear', action: 'com.lga.elmusic.window', context: 'W', payload: { settings: {} } });
    send(key); await until(() => count('showOk') === 1);
    send(key); await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(launches, 1);
    app = startControlServer(endpoint, () => undefined, '0.0.0', () => {}, () => { toggles.push('t'); return toggles.length % 2 ? 'shown' : 'minimized'; });
    await new Promise(resolve => setTimeout(resolve, 100));
    send(key); await until(() => count('showOk') === 2);
    send(key); await until(() => count('showOk') === 3);
    assert.equal(toggles.length, 2); assert.equal(launches, 1);
  } finally { peer?.destroy(); deck.close(); app?.close(); }
});

test('la ruta de inicio del plugin sólo acepta el ejecutable de El Music o su bundle', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { launchTarget, launchFile } = require(path.join(plugin, 'launcher.js')) as {
    launchTarget: (platform: string, executable: unknown) => string | undefined; launchFile: (platform: string, env: Record<string, string>, home: string) => string };
  assert.equal(launchTarget('win32', String.raw`C:\Apps\El\LGA_El_Music.exe`), String.raw`C:\Apps\El\LGA_El_Music.exe`);
  for (const bad of [String.raw`C:\Windows\System32\cmd.exe`, 'LGA_El_Music.exe', String.raw`C:\x\LGA_El_Music.exe.bat`, 42, undefined]) assert.equal(launchTarget('win32', bad), undefined);
  assert.equal(launchTarget('darwin', '/Applications/El Music.app/Contents/MacOS/LGA El Music'), '/Applications/El Music.app');
  for (const bad of ['/usr/bin/open', '/Applications/X/Contents/MacOS/Y', 'relative.app/Contents/MacOS/x']) assert.equal(launchTarget('darwin', bad), undefined);
  assert.equal(launchFile('win32', { APPDATA: String.raw`C:\Users\u\AppData\Roaming` }, String.raw`C:\Users\u`), String.raw`C:\Users\u\AppData\Roaming\LGA\ElMusic\launch.json`);
  assert.equal(launchFile('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/LGA/ElMusic/launch.json');
});

test('el glifo en línea del inspector es el mismo PNG de la tecla de playlist', () => {
  const base = path.join(repo, 'streamdeck', 'com.lga.elmusic.sdPlugin');
  const script = fs.readFileSync(path.join(base, 'ui', 'key-glyph.js'), 'utf8');
  const inline = /'data:image\/png;base64,([A-Za-z0-9+/=]+)'/.exec(script)?.[1];
  assert.equal(inline, fs.readFileSync(path.join(base, 'imgs', 'keys', 'addtoplaylist@2x.png')).toString('base64'));
  for (const file of ['ui/fonts/PretendardVariable.woff2', 'ui/fonts/LICENSE.txt']) assert.ok(fs.existsSync(path.join(base, file)), file);
});
