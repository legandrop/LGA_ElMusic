import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';

const labelsPath = require.resolve('../src/labels');
const controllerPath = require.resolve('../src/playlist-labels');
const previousLabels = require.cache[labelsPath];
const mbLabels = new Map<string, string[]>(); const mbCalls: string[] = [];
const real = require(labelsPath) as typeof import('../src/labels');
const fake = new Module(labelsPath); fake.filename = labelsPath; fake.loaded = true;
fake.exports = { ...real,
  findEditionLabels: async (id: string) => { mbCalls.push(id); if (id === '4') throw new Error('429'); return (mbLabels.get(id) ?? []).map(name => ({ name, id: 'x', source: 'MusicBrainz' })); }
};
require.cache[labelsPath] = fake; delete require.cache[controllerPath]; delete require.cache[require.resolve('../src/record-labels')];
// iTunes simulado: la columna Label sólo usa searchAppleAlbums e itunesIdle de recommendations.
const recommendationsPath = require.resolve('../src/recommendations'); delete require.cache[recommendationsPath];
const realRecommendations = require(recommendationsPath) as typeof import('../src/recommendations');
const itunes = { albums: new Map<string, Array<{ id: string; name: string; artist: string }>>(), calls: [] as string[], failure: false, idle: true, hold: false, onCall: undefined as (() => void) | undefined };
const fakeRecommendations = new Module(recommendationsPath); fakeRecommendations.filename = recommendationsPath; fakeRecommendations.loaded = true;
fakeRecommendations.exports = { ...realRecommendations, itunesIdle: () => itunes.idle,
  searchAppleAlbums: async (term: string, country: string, _signal: AbortSignal, limit = 10) => {
    itunes.calls.push(country + ':' + term + ':' + limit); itunes.onCall?.();
    if (itunes.hold) await new Promise((_, reject) => _signal.addEventListener('abort', () => reject(_signal.reason), { once: true }));
    if (itunes.failure) throw new Error('RECOMMENDATION_RATE_LIMITED');
    return itunes.albums.get(term) ?? [];
  } };
require.cache[recommendationsPath] = fakeRecommendations; delete require.cache[require.resolve('../src/record-labels')];
const { installPlaylistLabels, playlistAlbums, playlistAlbumsScript, playlistLabelsScript, playlistLabelLimits, nameKey, pickSearchedAlbum,
  catalogAlbumsScript, catalogSearchScript, primaryArtist, playlistAliases, AlbumIndex, libraryPlaylistOf, playlistTracksScript, playlistTracksPage,
  playlistLabelsWakeMessage } = require('../src/playlist-labels') as typeof import('../src/playlist-labels');
after(() => { if (previousLabels) require.cache[labelsPath] = previousLabels; else delete require.cache[labelsPath]; delete require.cache[controllerPath]; delete require.cache[recommendationsPath]; });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('las referencias de la página se validan: ID de álbum o artista + álbum con su clave exacta', () => {
  assert.deepEqual(playlistAlbums([{ key: '123', country: 'ar', id: '123' }, { key: '123', country: 'ar', id: '123' }, { key: '1', country: 'ARG', id: '1' },
    { key: '12a', country: 'us', id: '12a' }, null, { key: '7', country: 'us', id: '8' }, { key: nameKey(' Rejjie  Snow', 'PEACE '), country: 'us', artist: ' Rejjie  Snow', album: 'PEACE ' },
    { key: 'n:x\u0001y', country: 'us', artist: 'otro', album: 'y' }]),
  [{ key: '123', country: 'ar', id: '123' }, { key: 'n:Rejjie Snow\u0001PEACE', country: 'us', artist: 'Rejjie Snow', album: 'PEACE' }]);
  assert.deepEqual(playlistAlbums('x'), []);
  assert.equal(playlistAlbums(Array.from({ length: 1500 }, (_, i) => ({ key: String(i), country: 'ar', id: String(i) }))).length, playlistLabelLimits.sample);
  assert.throws(() => catalogAlbumsScript('ar', ['1', 'x'])); assert.throws(() => catalogAlbumsScript('ARG', ['1']));
  assert.throws(() => catalogAlbumsScript('ar', Array.from({ length: 101 }, (_, i) => String(i))));
  assert.match(catalogSearchScript('us', 'A "x" B'), /term: "A \\"x\\" B", types: 'albums', limit: 10 /);
  assert.match(catalogSearchScript('us', 'Dummy', 25), /limit: 25 /); assert.throws(() => catalogSearchScript('us', 'x', 26));
  assert.equal(primaryArtist('Oscar Brown, Jr.· Matthew Herbert'), 'Oscar Brown'); assert.equal(primaryArtist('Raedio· Amindi· Rae Khalil'), 'Raedio');
});

test('el álbum buscado por nombre exige el mismo nombre y un artista compartido', () => {
  const found = [{ id: '1', name: 'Greatest Hits', artist: 'Queen', label: 'EMI', copyright: '' }, { id: '2', name: 'PRIMA', artist: 'ADÉLA', label: 'Capitol Records', copyright: '' },
    { id: '3', name: 'Mornings', artist: 'Various Artists', label: 'V', copyright: '' }];
  assert.equal(pickSearchedAlbum(found, 'ADÉLA', 'prima')?.label, 'Capitol Records');
  assert.equal(pickSearchedAlbum(found, 'Raedio, Amindi & Queen', 'Greatest Hits')?.id, '1');
  assert.equal(pickSearchedAlbum(found, 'ABBA', 'Greatest Hits'), undefined);
  assert.equal(pickSearchedAlbum(found, 'RICEWINE', 'Mornings')?.id, '3');
  assert.equal(pickSearchedAlbum([{ id: 'x', name: 'PRIMA', artist: 'ADÉLA', label: '', copyright: '' }], 'ADÉLA', 'PRIMA'), undefined);
  // Acentos, apóstrofos tipográficos y «EP» sin guion (casos reales de una biblioteca).
  assert.equal(pickSearchedAlbum([{ id: '9', name: 'Tout va bien', artist: 'Ézéchiel Pailhès', label: 'X', copyright: '' }], 'Ezechiel Pailhes', 'Tout va bien')?.id, '9');
  assert.equal(pickSearchedAlbum([{ id: '8', name: 'Baker’s Dozen', artist: 'Dibia$e', label: 'X', copyright: '' }], 'Dibia$E', "Baker's Dozen")?.id, '8');
  assert.equal(pickSearchedAlbum([{ id: '7', name: 'Sketch on Glass - EP', artist: 'Mount Kimbie', label: 'X', copyright: '' }], 'Mount Kimbie', 'Sketch on glass EP')?.id, '7');
  assert.equal(pickSearchedAlbum([{ id: '6', name: 'Every Single', artist: 'A', label: 'X', copyright: '' }], 'A', 'Every'), undefined);
  // Cualquiera de los artistas de la fila, nombre flexible (sin « - Single» ni «(Deluxe…)») y recopilatorios con un solo sello.
  assert.equal(pickSearchedAlbum([{ id: '4', name: 'Verve Remixed 2', artist: 'Matthew Herbert', label: 'Verve', copyright: '' }], 'Oscar Brown, Jr.· Matthew Herbert', 'Verve Remixed 2')?.id, '4');
  assert.equal(pickSearchedAlbum([{ id: '5', name: 'Arigato - Single', artist: 'Rejjie Snow', label: 'BMG', copyright: '' }], 'Rejjie Snow', 'Arigato')?.id, '5');
  assert.equal(pickSearchedAlbum([{ id: '6', name: 'Dummy (Deluxe Edition)', artist: 'Portishead', label: 'Go! Beat', copyright: '' }], 'Portishead', 'Dummy')?.id, '6');
  const comps = [{ id: '7', name: 'Verve Remixed 2', artist: 'Various Artists', label: 'Verve', copyright: '' }, { id: '8', name: 'Verve Remixed 2', artist: 'Various Artists', label: 'Verve', copyright: '' }];
  assert.equal(pickSearchedAlbum(comps, 'Oscar Brown', 'Verve Remixed 2')?.id, '7');
  assert.equal(pickSearchedAlbum([comps[0], { ...comps[1], label: 'Otro' }], 'Oscar Brown', 'Verve Remixed 2'), undefined);
});

test('el script de la página lee filas: enlace de álbum o, sin enlace, artista y álbum con el país de la lista', () => {
  // own = el enlace de álbum propio (el-music-album-link): no cuenta como de Apple.
  let position = 0;
  const row = (href: string | null, artist: string, album: string, own = false) => {
    const top = position; position += 1000;
    return {
      getBoundingClientRect: () => ({ top, bottom: top + 50 }),
      querySelector: (selector: string) => selector === '.songs-list__col--tertiary'
        ? { textContent: album, querySelector: (inner: string) => href === null || (own && inner.includes(':not(.el-music-album-link)')) ? null : { getAttribute: () => href } }
        : selector === '.songs-list__col--secondary' ? { textContent: artist } : null };
  };
  // Con innerHeight 800 se ven las filas que empiezan antes de 1200 px: las dos primeras.
  const rows = [row('https://music.apple.com/ar/album/nothing/111?i=5', 'A', 'x'), row('/ar/album/x/222', 'B', 'y'), row('https://evil.test/ar/album/444', 'C', 'Evil'),
    row(null, ' Rejjie  Snow ', 'PEACE 2 DA WORLD'), row(null, 'Rejjie Snow', 'PEACE 2 DA WORLD'), row(null, '', 'Sin artista'), row('/ar/album/x/222', 'B', 'y'),
    row('https://music.apple.com/ar/album/own/999', 'D', 'Own', true)];
  const events: string[] = [];
  const root: Record<symbol, unknown> = {};
  const document = { documentElement: root, querySelectorAll: (selector: string) => selector === '.songs-list .songs-list-row' ? rows : [],
    dispatchEvent: (event: { type: string }) => { events.push(event.type); } };
  const self = {}; const location = new URL('https://music.apple.com/library/playlist/p.X');
  const context = vm.createContext({ document, top: self, self, location, URL, innerHeight: 800, Event: class { constructor(readonly type: string) {} } });
  const named = { key: 'n:Rejjie Snow\u0001PEACE 2 DA WORLD', artist: 'Rejjie Snow', album: 'PEACE 2 DA WORLD', country: 'ar' };
  const own = { key: 'n:D\u0001Own', artist: 'D', album: 'Own', country: 'ar' };
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(playlistAlbumsScript, context))), [{ aliases: [['A', 'x', '111'], ['B', 'y', '222']] },
    { key: '111', country: 'ar', id: '111', shown: 1 }, { key: '222', country: 'ar', id: '222', shown: 1 }, { key: 'n:C\u0001Evil', artist: 'C', album: 'Evil', country: 'ar' }, named, own]);
  assert.equal(vm.runInContext(playlistLabelsScript([['222', '  Warp \n Records '], ['bad', 'x'], [named.key, 'Honeymoon'], ['n:\u0000', 'x']]), context), true);
  const store = root[Symbol.for('el-music.playlist-labels')] as Map<string, string>;
  assert.deepEqual(JSON.parse(JSON.stringify([...store])), [['222', 'Warp Records'], [named.key, 'Honeymoon']]);
  assert.deepEqual(events, ['el-music-playlist-labels']);
  // Con sello ya en la página: la fila visible se sigue mandando (marcada stored) y la lejana no.
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(playlistAlbumsScript, context))).slice(1).map((ref: { key: string; stored?: number }) => ref.key + (ref.stored ? '*' : '')),
    ['111', '222*', 'n:C\u0001Evil', own.key]);
  const outside = vm.createContext({ document, top: self, self, location: new URL('https://music.apple.com.evil.test/'), URL, innerHeight: 800 });
  assert.equal(vm.runInContext(playlistAlbumsScript, outside), null);
  // Sin país (biblioteca sin enlaces de catálogo ni barra lateral) las filas por nombre no se mandan: se avisa cuántas quedaron afuera.
  const noCountry = vm.createContext({ document: { documentElement: {}, querySelectorAll: (selector: string) => selector === '.songs-list .songs-list-row' ? [rows[3], rows[5]] : [] },
    top: self, self, location, URL, innerHeight: 800 });
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(playlistAlbumsScript, noCountry))), [{ aliases: [] }, { dropped: 1 }]);
  assert.deepEqual(playlistAlbums([{ dropped: 1 }]), []);
  assert.deepEqual(playlistAlbums([{ aliases: [] }, { key: '1', country: 'ar', id: '1', shown: 1, stored: 1 }]), [{ key: '1', country: 'ar', id: '1', shown: true, stored: true }]);
  assert.deepEqual(playlistAliases([{ aliases: [[' A ', 'x', '1'], ['B', '', '2'], ['C', 'y', 'z'], 'mal'] }]), [['A', 'x', '1']]);
  // La página arma la misma clave que main para las filas sin enlace, también con el enlace propio.
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const albumOf = vm.runInContext(source.slice(source.indexOf('  const albumOf ='), source.indexOf('  const rowsOf =')) + '; albumOf', vm.createContext({}));
  assert.equal(albumOf(rows[3]), named.key); assert.equal(albumOf(rows[1]), '222'); assert.equal(albumOf(rows[5]), ''); assert.equal(albumOf(rows[7]), own.key);
});

test('índice de discos: artista principal y nombre normalizados; dos IDs para un nombre no dan ninguno', () => {
  const index = new AlbumIndex();
  index.add('Like & Kali Uchis', 'Blah Loops', '10'); index.add('James Blake', 'Assume Form', '20'); index.add('James Blake', 'Assume Form', '20');
  assert.equal(index.find('Like· Kali Uchis', 'blah  loops'), '10'); assert.equal(index.find('James Blake', 'Assume Form'), '20');
  index.add('James Blake', 'Assume Form', '21'); assert.equal(index.find('James Blake', 'Assume Form'), undefined);
  assert.equal(index.find('Otro', 'Blah Loops'), undefined);
  index.forget('Like & Kali Uchis', 'Blah Loops', '10'); assert.equal(index.find('Like', 'Blah Loops'), undefined);
  assert.equal(libraryPlaylistOf('https://music.apple.com/library/playlist/p.AbC123'), 'p.AbC123');
  assert.equal(libraryPlaylistOf('https://music.apple.com/ar/playlist/top/pl.123'), undefined);
  assert.throws(() => playlistTracksScript('p.X', 50)); assert.throws(() => playlistTracksScript('pl.X', 0));
  assert.match(playlistTracksScript('p.X', 100), /\/v1\/me\/library\/playlists\/p\.X\/tracks", \{ limit: 100, offset: 100, include: 'catalog' \}/);
  assert.deepEqual(playlistTracksPage({ items: [['A', 'B', '1'], ['A', 'B', 'x']], count: 2, total: 2, next: false }), { items: [['A', 'B', '1']], count: 2, total: 2, next: false });
  assert.equal(playlistTracksPage({ error: 429 }), 429); assert.equal(playlistTracksPage(true), undefined);
});

test('catálogo por IDs y búsqueda por nombre; MusicBrainz sólo sin sello; caché y reintentos con espera', async () => {
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    mbLabels.set('2', ['Ninja Tune', 'Ninja Tune']);
    const catalog = new Map([['1', { label: 'Warp', copyright: '', released: '2024-05-17', genre: 'Electronic' }], ['2', { label: '', copyright: '℗ 2020 Someone' }],
      ['3', { label: '', copyright: '℗ 2019 Holder 3' }], ['4', { label: '', copyright: '℗ 2018 Artist under exclusive licence to Holder 4' }]]);
    const store = new Map<string, string | null>(); const keys = new Map<string, string>(); const info = new Map<string, [string, string]>();
    const named = { key: nameKey('Rejjie Snow', 'PEACE 2 DA WORLD'), country: 'ar', artist: 'Rejjie Snow', album: 'PEACE 2 DA WORLD' };
    const lost = { key: nameKey('Nadie', 'Nada'), country: 'ar', artist: 'Nadie', album: 'Nada' };
    let refs: Array<Record<string, string>> = [...['1', '2', '3', '4', '5'].map(id => ({ key: id, country: 'ar', id })), named, lost];
    const calls: string[] = []; let catalogError = 0;
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/p.X',
      mainFrame: { executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return refs.filter(ref => !store.has(ref.key) || store.get(ref.key) === null);
        const ids = script.match(/\/v1\/catalog\/ar\/albums", \{ ids: "([\d,]+)"/)?.[1];
        if (ids) {
          calls.push('albums:' + ids); if (catalogError) return { error: catalogError };
          return ids.split(',').filter(id => catalog.has(id)).map(id => ({ id, name: 'x', artist: 'y', artists: [], ...catalog.get(id)! }));
        }
        const term = script.match(/\/v1\/catalog\/ar\/search", \{ term: "([^"]*)"/)?.[1];
        if (term) {
          calls.push('search:' + term);
          return term === 'Rejjie Snow PEACE 2 DA WORLD' ? [{ id: '9', name: 'PEACE 2 DA WORLD', artist: 'Rejjie Snow', label: 'Honeymoon', copyright: '' }] : [];
        }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name, link, released, genre] of JSON.parse(match[1]) as Array<[string, string | null, string | null, string, string]>) { store.set(id, name); if (link) keys.set(id, link); if (released || genre) info.set(id, [released, genre]); }
        return true;
      } }
    });
    const events: Array<[string, Record<string, boolean | number>]> = [];
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), (event, fields) => events.push([event, fields]));
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    // Un solo pedido por IDs para todos los álbumes con enlace; una búsqueda por cada álbum sin enlace.
    // Sin coincidencia, un segundo intento sólo con el nombre del álbum.
    assert.deepEqual(calls, ['albums:1,2,3,4,5', 'search:Rejjie Snow PEACE 2 DA WORLD', 'search:Nadie Nada', 'search:Nada']);
    assert.deepEqual(mbCalls, ['2', '3', '4']);
    assert.deepEqual(new Map(store), new Map<string, string | null>([['1', 'Warp'], ['5', ''], [named.key, 'Honeymoon'], [lost.key, ''],
      ['2', 'Ninja Tune'], ['3', '℗ Holder 3'], ['4', '℗ Holder 4']]));
    // Cada sello lleva su clave para abrir su música; un álbum sin dato no.
    assert.match(keys.get('1')!, /^p[a-f\d]{20}$/); assert.match(keys.get(named.key)!, /^p[a-f\d]{20}$/); assert.equal(keys.has('5'), false);
    // Fecha de lanzamiento y género viajan con el sello (columnas Released y Genre); sin ellos no se manda nada.
    assert.deepEqual(info.get('1'), ['2024-05-17', 'Electronic']); assert.equal(info.has('2'), false);
    // Las filas sin enlace esperan los temas de la playlist (aquí la lectura falla) y recién después se buscan por nombre.
    assert.deepEqual(events.filter(([event]) => event === 'Sellos de lista: álbumes en cola').map(([, fields]) => fields), [{ porId: 5, porNombre: 0 }, { porId: 0, porNombre: 2 }]);
    assert.deepEqual(events.find(([event]) => event === 'Sellos de lista: búsqueda por nombre')?.[1], { buscados: 2, encontrados: 1, sinResultados: 1, sinCoincidencia: 0, errores: 0, ultimoEstado: 0 });
    // Un error del catálogo deja null (reintentable) y respeta la espera: no se consulta de nuevo enseguida.
    catalogError = 400; refs = [{ key: '6', country: 'ar', id: '6' }];
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.equal(store.get('6'), null); assert.deepEqual(events.at(-1), ['Sellos de lista: error del catálogo', { álbumes: 1, estado: 400 }]);
    tick!(); await settle();
    assert.equal(calls.filter(call => call === 'albums:6').length, 1);
    // Un error pasajero (429) no marca error: el álbum vuelve a la cola y se espera antes de seguir.
    catalogError = 429; refs = [{ key: '7', country: 'ar', id: '7' }];
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.equal(store.has('7'), false); assert.deepEqual(events.at(-1), ['Sellos de lista: error pasajero del catálogo', { álbumes: 1, estado: 429, esperaMs: 2000 }]);
    tick!(); await settle();
    assert.equal(calls.filter(call => call === 'albums:7').length, 1);
    // Si la página perdió el almacén (recarga), main reenvía lo conocido sin consultar.
    store.clear(); refs = [{ key: '1', country: 'ar', id: '1' }, named];
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.equal(calls.length, 6); assert.equal(store.get('1'), 'Warp'); assert.equal(store.get(named.key), 'Honeymoon');
    contents.emit('destroyed');
  } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});

test('la caché en disco llena la columna sin consultar y hay hasta tres pedidos de catálogo a la vez', async () => {
  const fs = require('node:fs') as typeof import('node:fs'), os = require('node:os') as typeof import('node:os'), path = require('node:path') as typeof import('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-playlist-cache-')), file = path.join(folder, 'label-cache.json');
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [['900', 'Warp', { kind: 'name', name: 'Warp' }, Date.now()]] }));
    const store = new Map<string, string | null>(); const keys = new Map<string, string>(); const info = new Map<string, [string, string]>();
    const refs = [{ key: '900', country: 'ar', id: '900' }, ...Array.from({ length: 250 }, (_, i) => ({ key: String(i + 1), country: 'ar', id: String(i + 1) }))];
    let active = 0, peak = 0; const release: Array<() => void> = []; const batches: number[] = [];
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/p.Y',
      mainFrame: { executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return refs.filter(ref => !store.has(ref.key) || store.get(ref.key) === null);
        const ids = script.match(/\/v1\/catalog\/ar\/albums", \{ ids: "([\d,]+)"/)?.[1];
        if (ids) {
          const list = ids.split(','); batches.push(list.length); active++; peak = Math.max(peak, active);
          await new Promise<void>(resolve => release.push(resolve)); active--;
          return list.map(id => ({ id, name: 'x', artist: 'y', artists: [], label: 'Label ' + id, copyright: '', ...(id === '900' ? { released: '2001-01-01', genre: 'IDM' } : {}) }));
        }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name, link, released, genre] of JSON.parse(match[1]) as Array<[string, string | null, string | null, string, string]>) { store.set(id, name); if (link) keys.set(id, link); if (released || genre) info.set(id, [released, genre]); }
        return true;
      } }
    });
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), undefined, file);
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    // El sello guardado aparece sin consultar; los 250 álbumes nuevos salen en tres pedidos simultáneos de 100, 100 y 51:
    // el guardado sin fecha ni género (caché vieja) va en el último sólo para completar esos datos.
    assert.equal(store.get('900'), 'Warp'); assert.match(keys.get('900')!, /^p[a-f\d]{20}$/); assert.equal(info.has('900'), false);
    assert.deepEqual(batches, [100, 100, 51]); assert.equal(peak, 3);
    while (release.length) release.shift()!();
    await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.equal(store.get('250'), 'Label 250');
    // El sello de la caché no cambia y ahora tiene fecha y género; otro sondeo no lo vuelve a pedir.
    assert.equal(store.get('900'), 'Warp'); assert.deepEqual(info.get('900'), ['2001-01-01', 'IDM']);
    tick!(); await settle(); assert.deepEqual(batches, [100, 100, 51]);
    // Al cerrarse la vista se guarda lo nuevo en disco.
    contents.emit('destroyed');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<unknown[]> };
    assert.equal(saved.entries.length, 251); assert.deepEqual(saved.entries.find(([key]) => key === '7')?.slice(0, 2), ['7', 'Label 7']);
    assert.deepEqual(saved.entries.find(([key]) => key === '900')?.slice(5), ['2001-01-01', 'IDM', []]);
  } finally {
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('el tope 429 que MusicKit devuelve sin lanzar llega como error, no como «sin resultados»', async () => {
  const limited = { status: 429, data: { errors: [{ status: '429', code: '42900' }] } };
  const page = (response: unknown) => {
    const self = {}; const music = { api: { music: async () => response } };
    return vm.runInNewContext(catalogSearchScript('ar', 'Portishead Dummy'), { top: self, self, location: { protocol: 'https:', hostname: 'music.apple.com', port: '', href: 'https://music.apple.com/ar/x' },
      URL, globalThis: { MusicKit: { getInstance: () => music } } }).then((value: unknown) => JSON.parse(JSON.stringify(value))) as Promise<unknown>;
  };
  assert.deepEqual(await page(limited), { error: 429 });
  assert.deepEqual(await page({ status: 200, data: { results: {} } }), []);
  assert.deepEqual(await page({ data: { errors: [{ status: '503' }] } }), { error: 503 });
  assert.match(catalogAlbumsScript('ar', ['1']), /const code = Number\(response\?\.status\)/);
});

test('ante el tope de búsquedas se pausa sólo la búsqueda, sin marcar error, y el catálogo sigue', async () => {
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    const store = new Map<string, string | null>(); const calls: string[] = [];
    const named = ['A', 'B', 'C'].map(name => ({ key: nameKey(name, name), country: 'ar', artist: name, album: name }));
    let refs: Array<Record<string, string>> = named;
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/p.Y',
      mainFrame: { executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return refs.filter(ref => !store.has(ref.key) || store.get(ref.key) === null);
        const ids = script.match(/\/v1\/catalog\/ar\/albums", \{ ids: "([\d,]+)"/)?.[1];
        if (ids) { calls.push('albums:' + ids); return ids.split(',').map(id => ({ id, name: 'x', artist: 'y', artists: [], label: 'Warp', copyright: '' })); }
        const term = script.match(/\/v1\/catalog\/ar\/search", \{ term: "([^"]*)"/)?.[1];
        if (term) { calls.push('search:' + term); return { error: 429 }; }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name] of JSON.parse(match[1]) as Array<[string, string | null]>) store.set(id, name);
        return true;
      } }
    });
    const events: Array<[string, Record<string, boolean | number>]> = [];
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), (event, fields) => events.push([event, fields]));
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    // Una sola búsqueda por buscador antes de pausar; nada queda marcado como «sin dato» ni como error.
    assert.ok(calls.filter(call => call.startsWith('search:')).length <= playlistLabelLimits.searchWorkers);
    assert.equal(named.some(ref => store.has(ref.key)), false);
    assert.equal(events.filter(([event]) => event === 'Sellos de lista: tope de búsquedas de Apple').length, 1);
    assert.equal(events.find(([event]) => event === 'Sellos de lista: tope de búsquedas de Apple')?.[1].esperaMs, 60000);
    const before = calls.length;
    refs = [...named, { key: '8', country: 'ar', id: '8' }];
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.deepEqual(calls.slice(before), ['albums:8']); assert.equal(store.get('8'), 'Warp');
    contents.emit('destroyed');
  } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});

test('con la búsqueda de Apple en pausa, iTunes encuentra el ID del álbum y el sello sale del catálogo por ID', async () => {
  const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    itunes.calls = []; itunes.failure = false; itunes.idle = true; itunes.albums.clear();
    itunes.albums.set('Rejjie Snow PEACE 2 DA WORLD', [{ id: '90', name: 'PEACE 2 DA WORLD', artist: 'Rejjie Snow' }]);
    // Recopilatorio con dos ediciones: ambiguo, no se elige ninguna.
    itunes.albums.set('Verve Remixed 2', [{ id: '91', name: 'Verve Remixed 2', artist: 'Varios Artistas' }, { id: '92', name: 'Verve Remixed 2', artist: 'Varios Artistas' }]);
    const store = new Map<string, string | null>(); const calls: string[] = [];
    const found = { key: nameKey('Rejjie Snow', 'PEACE 2 DA WORLD'), country: 'ar', artist: 'Rejjie Snow', album: 'PEACE 2 DA WORLD' };
    const compilation = { key: nameKey('Oscar Brown, Jr.· Matthew Herbert', 'Verve Remixed 2'), country: 'ar', artist: 'Oscar Brown, Jr.· Matthew Herbert', album: 'Verve Remixed 2' };
    const missing = { key: nameKey('Rae Khalil', 'Girlfriend'), country: 'ar', artist: 'Rae Khalil', album: 'Girlfriend' };
    let path = 'p.Z'; let refs: Array<Record<string, string>> = [found, compilation, missing];
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/' + path,
      mainFrame: { executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return refs.filter(ref => !store.has(ref.key) || store.get(ref.key) === null);
        const ids = script.match(/\/v1\/catalog\/ar\/albums", \{ ids: "([\d,]+)"/)?.[1];
        if (ids) { calls.push('albums:' + ids); return ids.split(',').map(id => ({ id, name: 'x', artist: 'y', artists: [], label: 'Honeymoon', copyright: '' })); }
        const term = script.match(/\/v1\/catalog\/ar\/search", \{ term: "([^"]*)"/)?.[1];
        if (term) { calls.push('search:' + term); return { status: 429, error: 429 }; }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name] of JSON.parse(match[1]) as Array<[string, string | null]>) store.set(id, name);
        return true;
      } }
    });
    const events: Array<[string, Record<string, boolean | number>]> = [];
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), (event, fields) => events.push([event, fields]));
    // Sin pausa, iTunes no se usa: la búsqueda de MusicKit recibe el 429 y recién ahí entra iTunes, en el sondeo siguiente.
    tick!(); await settle();
    assert.deepEqual(itunes.calls, []);
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.deepEqual([...itunes.calls].sort(), ['ar:Girlfriend:25', 'ar:Oscar Brown Verve Remixed 2:10', 'ar:Rae Khalil Girlfriend:10', 'ar:Rejjie Snow PEACE 2 DA WORLD:10', 'ar:Verve Remixed 2:25']);
    assert.deepEqual(calls.filter(call => call.startsWith('albums:')), ['albums:90']);
    assert.equal(store.get(found.key), 'Honeymoon');
    // Lo que iTunes no resuelve no queda como «sin dato»: vuelve a la búsqueda de MusicKit, que lo intenta al terminar la pausa.
    assert.equal(store.has(compilation.key), false); assert.equal(store.has(missing.key), false);
    assert.deepEqual(events.find(([event]) => event === 'Sellos de lista: búsqueda iTunes')?.[1], { buscados: 3, encontrados: 1, errores: 0 });
    const searches = calls.filter(call => call.startsWith('search:')).length;
    tick!(); await settle();
    assert.equal(itunes.calls.length, 5); assert.equal(calls.filter(call => call.startsWith('search:')).length, searches);
    // Con Related usando iTunes se cede el turno; un error de iTunes pausa sólo ese buscador, sin marcar nada.
    path = 'p.W'; itunes.calls = []; itunes.idle = false;
    const other = { key: nameKey('Petit Fantôme', 'Stave'), country: 'ar', artist: 'Petit Fantôme', album: 'Stave' }; refs = [other];
    tick!(); await settle(); tick!(); await settle();
    assert.deepEqual(itunes.calls, []);
    itunes.idle = true; itunes.failure = true;
    tick!(); await settle();
    assert.deepEqual(itunes.calls, ['ar:Petit Fantôme Stave:10']); assert.equal(store.has(other.key), false);
    assert.deepEqual(events.find(([event]) => event === 'Sellos de lista: error de iTunes')?.[1], { esperaMs: 60000 });
    tick!(); await settle();
    assert.equal(itunes.calls.length, 1);
    // Pasada la pausa, la misma fila falla otra vez: pasa a MusicKit para no trabar a las demás, y la pausa se duplica.
    offset = 61000; tick!(); await settle(); tick!(); await settle();
    assert.deepEqual(itunes.calls, ['ar:Petit Fantôme Stave:10', 'ar:Petit Fantôme Stave:10']); assert.equal(store.has(other.key), false);
    assert.deepEqual(events.filter(([event]) => event === 'Sellos de lista: error de iTunes').at(-1)?.[1], { esperaMs: 120000 });
    offset = 200000; tick!(); await settle(); tick!(); await settle();
    assert.equal(itunes.calls.length, 2);
    // Un cambio de página con un pedido iTunes en vuelo lo cancela sin contarlo ni marcar la fila.
    itunes.failure = false; itunes.hold = true; itunes.calls = []; path = 'p.U';
    const held = { key: nameKey('Y', 'Y'), country: 'ar', artist: 'Y', album: 'Y' }; refs = [held];
    const errorsBefore = events.filter(([event]) => event.startsWith('Sellos de lista: error de iTunes')).length;
    tick!(); await settle();
    assert.deepEqual(itunes.calls, ['ar:Y Y:10']);
    path = 'p.T'; refs = []; tick!(); await settle();
    assert.equal(events.filter(([event]) => event.startsWith('Sellos de lista: error de iTunes')).length, errorsBefore);
    assert.equal(store.has(held.key), false);
    // También se cede el turno entre la primera búsqueda y la de sólo el álbum, sin repetir la primera.
    itunes.hold = false; itunes.calls = []; path = 'p.S';
    const lone = { key: nameKey('Z', 'Zeta'), country: 'ar', artist: 'Z', album: 'Zeta' }; refs = [lone];
    itunes.onCall = () => { itunes.idle = false; };
    tick!(); await settle();
    assert.deepEqual(itunes.calls, ['ar:Z Zeta:10']);
    itunes.onCall = undefined; itunes.idle = true; tick!(); await settle();
    assert.deepEqual(itunes.calls, ['ar:Z Zeta:10', 'ar:Zeta:25']);
    contents.emit('destroyed');
  } finally {
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; Date.now = realNow;
    itunes.failure = false; itunes.hold = false; itunes.onCall = undefined; itunes.idle = true;
  }
});

test('una clave por nombre guardada sin ID ni fecha busca el álbum una vez y agrega ID, fecha y género sin cambiar el sello', async () => {
  const fs = require('node:fs') as typeof import('node:fs'), os = require('node:os') as typeof import('node:os'), path = require('node:path') as typeof import('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-playlist-details-')), file = path.join(folder, 'label-cache.json');
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    const key = nameKey('Lapalux', 'Nostalchic');
    // Entrada anterior a la versión 4: sello por nombre, sin fecha, sin género y sin ID de álbum.
    fs.writeFileSync(file, JSON.stringify({ version: 6, entries: [[key, 'Brainfeeder', { kind: 'name', name: 'Brainfeeder' }, Date.now(), null, '', '']] }));
    const store = new Map<string, string | null>(); const info = new Map<string, unknown[]>(); const calls: string[] = [];
    const ref = { key, country: 'ar', artist: 'Lapalux', album: 'Nostalchic' };
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/p.Z',
      mainFrame: { executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return [ref];
        const term = script.match(/\/v1\/catalog\/ar\/search", \{ term: "([^"]*)"/)?.[1];
        if (term) { calls.push('search:' + term); return [{ id: '555', name: 'Nostalchic', artist: 'Lapalux', label: 'Otro sello', copyright: '', released: '2013-03-25', genre: 'Electronic' }]; }
        if (/\/v1\/catalog\/ar\/albums"/.test(script)) { calls.push('albums'); return []; }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name, , released, genre, album] of JSON.parse(match[1]) as Array<[string, string | null, string | null, string, string, string]>) { store.set(id, name); info.set(id, [released, genre, album]); }
        return true;
      } }
    });
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), undefined, file);
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.deepEqual(calls, ['search:Lapalux Nostalchic']);
    // El sello visible sigue siendo el de la caché; llegan fecha, género y el ID del álbum (enlace propio de la fila).
    assert.equal(store.get(key), 'Brainfeeder'); assert.deepEqual(info.get(key), ['2013-03-25', 'Electronic', '555']);
    // Otro sondeo en la misma sesión no vuelve a buscar.
    tick!(); await settle(); await new Promise(resolve => setTimeout(resolve, 450)); await settle();
    assert.deepEqual(calls, ['search:Lapalux Nostalchic']);
    contents.emit('destroyed');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<unknown[]> };
    assert.deepEqual(saved.entries.find(([entry]) => entry === key)?.slice(0, 2), [key, 'Brainfeeder']);
    // La búsqueda no trae artistas: quedan sin pedir (null) hasta un pedido por ID.
    assert.deepEqual(saved.entries.find(([entry]) => entry === key)?.slice(4), ['555', '2013-03-25', 'Electronic', null]);
  } finally {
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('el aviso de la página sondea sin esperar el intervalo; los temas de la playlist dan el ID sin buscar; lo visible va primero', async () => {
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((() => ({}) as NodeJS.Timeout) as unknown) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  try {
    const store = new Map<string, string | null>(); const info = new Map<string, unknown[]>(); const calls: string[] = [];
    const linked = { key: nameKey('Like· Kali Uchis', 'Blah Loops'), country: 'ar', artist: 'Like· Kali Uchis', album: 'Blah Loops' };
    const far = ['Uno', 'Dos', 'Tres'].map(name => ({ key: nameKey(name, name), country: 'ar', artist: name, album: name }));
    const near = { key: nameKey('Cerca', 'Cerca'), country: 'ar', artist: 'Cerca', album: 'Cerca', shown: 1 };
    let refs: Array<Record<string, string | number>> = [linked]; let tracksAnswer: unknown = { items: [['Like & Kali Uchis', 'Blah Loops', '10']], count: 1, total: 1, next: false };
    let path = 'p.L';
    const frame = {
      executeJavaScript: async (script: string) => {
        if (script === playlistAlbumsScript) return refs.filter(ref => !store.has(String(ref.key)) || store.get(String(ref.key)) === null);
        if (script.includes('/v1/me/library/playlists/')) { calls.push('tracks:' + (script.match(/offset: (\d+)/)?.[1] ?? '?')); return tracksAnswer; }
        const ids = script.match(/\/v1\/catalog\/ar\/albums", \{ ids: "([\d,]+)"/)?.[1];
        if (ids) { calls.push('albums:' + ids); return ids.split(',').map(id => ({ id, name: 'Blah Loops', artist: 'Like', artists: [], label: 'SQUATCH', copyright: '', released: '2019-05-03', genre: 'Hip-Hop' })); }
        const term = script.match(/\/v1\/catalog\/ar\/search", \{ term: "([^"]*)"/)?.[1];
        if (term) { calls.push('search:' + term); return []; }
        const match = script.match(/for \(const \[id, name, link, released, genre, album, artists\] of (\[.*?\]\])\)/s);
        if (match) for (const [id, name, , released, genre, album] of JSON.parse(match[1]) as Array<[string, string | null, string | null, string, string, string]>) { store.set(id, name); info.set(id, [released, genre, album]); }
        return true;
      }
    };
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://music.apple.com/library/playlist/' + path, mainFrame: frame });
    const events: Array<[string, Record<string, boolean | number>]> = [];
    installPlaylistLabels(contents as unknown as WebContents, () => assert.fail('fallo'), (event, fields) => events.push([event, fields]));
    // Un mensaje de otro frame o con otro texto no despierta nada.
    contents.emit('console-message', { message: playlistLabelsWakeMessage, frame: {} }); contents.emit('console-message', { message: 'otro', frame });
    await settle(); await new Promise(resolve => setTimeout(resolve, 150)); await settle();
    assert.deepEqual(calls, []);
    // El aviso de la página sondea enseguida; la fila sin enlace espera los temas y sale por ID, sin búsqueda por nombre.
    contents.emit('console-message', { message: playlistLabelsWakeMessage, frame });
    await settle(); await new Promise(resolve => setTimeout(resolve, 200)); await settle();
    assert.deepEqual(calls, ['tracks:0', 'albums:10']);
    assert.equal(store.get(linked.key), 'SQUATCH'); assert.deepEqual(info.get(linked.key), ['2019-05-03', 'Hip-Hop', '10']);
    assert.deepEqual(events.find(([event]) => event === 'Sellos de lista: temas de la playlist')?.[1]?.conCatalogo, 1);
    assert.deepEqual(events.filter(([event]) => event === 'Sellos de lista: álbumes en cola').map(([, fields]) => fields), [{ porId: 0, porNombre: 0, porLista: 1 }]);
    // Otra playlist sin temas legibles: lo visible se busca antes que lo que está más abajo en la lista.
    calls.length = 0; path = 'p.M'; tracksAnswer = { error: 404 }; refs = [...far, near];
    contents.emit('console-message', { message: playlistLabelsWakeMessage, frame });
    await settle(); await new Promise(resolve => setTimeout(resolve, 200)); await settle();
    assert.deepEqual((calls as string[]).filter(call => call.startsWith('search:')).slice(0, 2), ['search:Cerca Cerca', 'search:Uno Uno']);
    contents.emit('destroyed');
  } finally { globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; }
});
test('el catálogo por ID pide también los artistas del álbum y la página los recibe junto con el sello', () => {
  const script = catalogAlbumsScript('ar', ['1']);
  assert.match(script, /include: 'artists'/);
  // albumFields toma nombre e ID de cada artista incluido; sin atributos (relación sin incluir), ningún artista.
  const fields = vm.runInNewContext(script.match(/\.map\((album => \(\{[\s\S]*?\}\))\) : \[\]/)![1]) as (album: unknown) => { artists?: unknown };
  const album = (artists: unknown) => ({ id: '1', attributes: { name: 'Secret Wars', artistName: 'Raz Fresco & Dibia$E', recordLabel: 'BKRSCLB' }, relationships: { artists: { data: artists } } });
  assert.deepEqual(JSON.parse(JSON.stringify(fields(album([{ id: '111', attributes: { name: 'Raz Fresco' } }, { id: '222', attributes: { name: 'Dibia$E' } }])).artists)), [['Raz Fresco', '111'], ['Dibia$E', '222']]);
  assert.equal(fields(album([{ id: '111' }])).artists, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(fields(album([])).artists)), []);
  // La página guarda los artistas en el almacén de datos de la fila; un ID que no es numérico descarta la entrada.
  const root: Record<symbol, unknown> = {};
  const context = vm.createContext({ top: 1, self: 1, location: { protocol: 'https:', hostname: 'music.apple.com', port: '', href: 'https://music.apple.com/library/playlist/p.X' },
    URL, document: { documentElement: root, dispatchEvent: () => {} }, Event: class {} });
  context.top = context.self = context;
  assert.equal(vm.runInContext(playlistLabelsScript([['1', 'BKRSCLB', undefined, undefined, undefined, undefined, [['Raz Fresco', '111']]], ['2', 'x', undefined, undefined, undefined, undefined, [['A', 'x1']]]]), context), true);
  const info = root[Symbol.for('el-music.playlist-info')] as Map<string, { artists: unknown }>;
  assert.deepEqual(JSON.parse(JSON.stringify(info.get('1')?.artists)), [['Raz Fresco', '111']]); assert.equal(info.has('2'), false);
});