import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';

// MusicBrainz e iTunes simulados: el panel de un sello sólo usa estas funciones de labels y recommendations.
const labelsPath = require.resolve('../src/labels'), recommendationsPath = require.resolve('../src/recommendations');
const owned = [labelsPath, recommendationsPath, require.resolve('../src/record-labels'), require.resolve('../src/playlist-labels')];
for (const file of owned) delete require.cache[file];
const realLabels = require(labelsPath) as typeof import('../src/labels');
const realRecommendations = require(recommendationsPath) as typeof import('../src/recommendations');
const mbid = 'f85c7584-cf10-479f-b435-7d27937f794e';
const mb = { calls: 0, fail: 0, identifyFail: 0 };
const fakeLabels = new Module(labelsPath); fakeLabels.filename = labelsPath; fakeLabels.loaded = true;
fakeLabels.exports = { ...realLabels,
  findLabelByName: async () => {
    if (mb.identifyFail > 0) { mb.identifyFail--; throw new realLabels.PublicMetadataError('http', 503); }
    return { name: 'Nowadays Records', id: mbid, source: 'MusicBrainz' };
  },
  labelFamily: async (id: string) => [id],
  labelAlbumIds: async () => {
    mb.calls++;
    if (mb.fail > 0) { mb.fail--; throw new realLabels.PublicMetadataError('http', 503); }
    return { ids: ['2', '1'], unlinked: [{ artist: 'Fakear', title: 'Inner Forest', released: '2023-10-27' }, { artist: 'Nadie', title: 'Nada' }], nextOffset: 2, more: false };
  } };
const catalog: Record<string, { id: string; title: string; artist: string; url: string; released?: string }> = {
  1: { id: '1', title: 'Feu tempête', artist: 'Le Vasco', url: 'https://music.apple.com/ar/album/1', released: '2016-01-01' },
  2: { id: '2', title: 'Animal', artist: 'Fakear', url: 'https://music.apple.com/ar/album/2', released: '2020-01-01' } };
const lookups: string[][] = [], searches: string[] = [];
const fakeRecommendations = new Module(recommendationsPath); fakeRecommendations.filename = recommendationsPath; fakeRecommendations.loaded = true;
fakeRecommendations.exports = { ...realRecommendations,
  lookupAppleAlbums: async (ids: readonly string[]) => { lookups.push([...ids]); return ids.filter(id => catalog[id]).map(id => catalog[id]); },
  searchAppleAlbums: async (term: string, _country: string, _signal: AbortSignal, limit = 10, background = true) => {
    searches.push(`${term}:${limit}:${background}`);
    if (term === 'Nadie Nada') throw new SyntaxError('cuerpo inválido');
    if (term === "Le Vasco We're Not Natural Anymore :'( - Single") return [{ id: '4', name: "We're Not Natural Anymore :'( - Single", artist: 'Le Vasco', released: '2024-03-01' }];
    return term === 'Fakear Inner Forest' ? [{ id: '3', name: 'Inner Forest - Single', artist: 'Fakear', released: '2023-10-27' }] : [];
  } };
require.cache[labelsPath] = fakeLabels; require.cache[recommendationsPath] = fakeRecommendations;
const { installLabelBrowser, labelLinkKey } = require('../src/record-labels') as typeof import('../src/record-labels');
const { installPlaylistLabels } = require('../src/playlist-labels') as typeof import('../src/playlist-labels');
after(() => { for (const file of owned) delete require.cache[file]; });

interface PanelAlbum { id: string; released?: string }
interface Panel { open: boolean; busy: boolean; more: boolean; message: string; albums: PanelAlbum[] }
function panel(albumsOfLabel: (name: string) => { ids: string[]; named: Array<{ artist: string; title: string }> }) {
  const states: Panel[] = [], events: Array<[string, Record<string, boolean | number> | undefined]> = [];
  let request: string | null = null;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/library/playlist/p.X',
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = request; request = null; return { request: value, country: 'ar' }; }
      if (script.includes("types: 'record-labels'")) return [];
      const state = script.match(/const state = (\{.*?\});\n/s)?.[1];
      if (state) states.push(JSON.parse(state) as Panel);
      return true;
    } }
  });
  installLabelBrowser(contents as unknown as WebContents, () => {}, (event, fields) => events.push([event, fields]), albumsOfLabel);
  const more = (): void => { request = 'more'; contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame }); };
  const open = (): void => {
    request = 'open/' + labelLinkKey({ kind: 'name', name: 'Nowadays Records' });
    contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame });
  };
  const settled = async (done: (state: Panel) => boolean): Promise<Panel> => {
    for (let waited = 0; waited < 15000; waited += 50) {
      const last = states.at(-1);
      if (last && !last.busy && done(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('el panel no terminó: ' + JSON.stringify(states.at(-1)));
  };
  return { states, events, open, more, settled, close: () => contents.emit('destroyed') };
}

test('el panel de un sello muestra primero los álbumes conocidos y después todo MusicBrainz, también lo que no tiene enlace', async () => {
  mb.calls = 0; mb.fail = 1; lookups.length = 0; searches.length = 0;
  const view = panel(name => name === 'Nowadays Records' ? { ids: ['1'], named: [{ artist: 'Le Vasco', title: "We're Not Natural Anymore :'( - Single" }] } : { ids: [], named: [] });
  view.open();
  // Un 503 de MusicBrainz se reintenta a los 2 s; el álbum desde el que se abrió ya está a la vista.
  const last = await view.settled(state => state.albums.length === 4);
  assert.ok(view.states.some(state => state.albums.map(album => album.id).join() === '1'));
  assert.deepEqual(last.albums.map(album => album.id), ['4', '3', '2', '1']);
  assert.equal(last.message, ''); assert.equal(last.more, false); assert.equal(mb.calls, 2);
  // El conocido no se vuelve a pedir; el guardado sólo por nombre y los discos sin enlace se buscan en iTunes en primer
  // plano, uno por vuelta. Un error no pasajero con un disco lo saltea.
  assert.deepEqual(lookups, [['1'], ['2']]);
  assert.deepEqual(searches, ["Le Vasco We're Not Natural Anymore :'( - Single:10:false", 'Fakear Inner Forest:10:false', 'Nadie Nada:10:false']);
  assert.deepEqual(view.events.find(([event]) => event === 'Sellos: disco salteado')?.[1], { código: 0 });
  assert.deepEqual(view.events.find(([event]) => event === 'Sellos: discos del sello')?.[1] &&
    { ...view.events.find(([event]) => event === 'Sellos: discos del sello')![1], ms: 0 },
  { álbumes: 4, buscadosItunes: 3, encontradosItunes: 2, pendientes: 0, ms: 0 });
  assert.deepEqual(view.events.find(([event]) => event === 'Sellos: catálogo pedido')?.[1], { porNombre: true, sellos: 1, conocidos: 2 });
  view.close();
});

test('si MusicBrainz sigue fallando, el panel conserva lo conocido, ofrece reintentar y registra etapa y código', async () => {
  mb.calls = 0; mb.fail = 10; lookups.length = 0; searches.length = 0;
  const view = panel(() => ({ ids: ['1'], named: [] }));
  view.open();
  const last = await view.settled(state => !!state.message);
  assert.equal(last.message, 'Releases could not be loaded. Try again.'); assert.equal(last.more, true);
  assert.deepEqual(last.albums.map(album => album.id), ['1']); assert.equal(mb.calls, 3);
  assert.deepEqual(view.events.find(([event]) => event === 'Sellos: error al cargar discos')?.[1], { etapa: 2, código: 503 });
  view.close();
});

test('la columna le pasa al panel los álbumes que ya sabe de un sello, también los guardados por nombre', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-label-browser-')), file = path.join(folder, 'label-cache.json'), now = Date.now();
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({}) as NodeJS.Timeout) as unknown as typeof setInterval;
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 4, entries: [['937209863', 'Nowadays Records', null, now], ['n:Le Vasco\u0001Feu', 'Nowadays Records', null, now, '1600000000'],
      ['5', '℗ Nowadays Records Ltd', null, now], ['6', 'Warp, Nowadays Records', null, now], ['7', 'Warp', null, now], ['n:Sin\u0001Id', 'Nowadays Records', null, now]] }));
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/library/playlist/p.X', mainFrame: { executeJavaScript: async () => true } });
    const labels = installPlaylistLabels(contents as unknown as WebContents, () => {}, undefined, file);
    assert.deepEqual(labels.albumsOfLabel('Nowadays Records'), { ids: ['937209863', '1600000000', '5', '6'], named: [{ artist: 'Sin', title: 'Id' }] });
    assert.deepEqual(labels.albumsOfLabel('  '), { ids: [], named: [] });
    contents.emit('destroyed');
  } finally { globalThis.setInterval = originalInterval; fs.rmSync(folder, { recursive: true, force: true }); }
});

test('los discos de MusicBrainz aceptan enlaces viejos de iTunes y separan los que no tienen enlace', () => {
  const release = (resources: string[]) => ({ relations: resources.map(resource => ({ url: { resource } })) });
  assert.deepEqual(realLabels.releaseAppleIds(release(['https://music.apple.com/fr/album/1456284366', 'https://itunes.apple.com/fr/album/id1219276283',
    'https://itunes.apple.com/album/id1201007651', 'http://itunes.apple.com/us/album/some-name/id1113041261?uo=4', 'https://music.apple.com/fr/album/1456284366',
    'https://evil.test/fr/album/id1', 'https://itunes.apple.com/fr/artist/id5', 'https://music.apple.com:8443/fr/album/2', 'no url'])),
  ['1456284366', '1219276283', '1201007651', '1113041261']);
  assert.deepEqual(realLabels.releaseAppleIds({}), []);
});

test('un disco sin enlace lleva el crédito completo, título y fecha, sin repetidos', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ 'release-count': 4, releases: [
      { title: 'Underwater (Mira Ló remix)', date: '2025-04-11', 'artist-credit': [{ name: 'Fakear', joinphrase: ' & ' }, { name: 'KAVYA', joinphrase: '' }], relations: [] },
      { title: 'Underwater (Mira Ló remix)', date: '2025-04-11', 'artist-credit': [{ name: 'Fakear', joinphrase: ' & ' }, { name: 'KAVYA' }], relations: [] },
      { title: 'Talisman', date: 'pronto', 'artist-credit': [{ name: 'Fakear' }], relations: [{ url: { resource: 'https://itunes.apple.com/de/album/id1663308009' } }] },
      { title: 'Sin crédito', relations: [] }] });
    assert.deepEqual(await realLabels.labelAlbumIds(mbid, 0), { ids: ['1663308009'],
      unlinked: [{ artist: 'Fakear & KAVYA', title: 'Underwater (Mira Ló remix)', released: '2025-04-11' }], nextOffset: 4, more: false });
  } finally { globalThis.fetch = original; }
});

test('si MusicBrainz no identifica el sello, el panel muestra lo conocido y «Try again» lo vuelve a identificar', async () => {
  mb.calls = 0; mb.fail = 0; mb.identifyFail = 3; lookups.length = 0; searches.length = 0;
  const view = panel(() => ({ ids: ['1'], named: [] }));
  view.open();
  const failed = await view.settled(state => state.message === 'The label could not be loaded. Try again.');
  assert.deepEqual(failed.albums.map(album => album.id), ['1']); assert.equal(failed.more, true); assert.equal(mb.calls, 0);
  assert.deepEqual(view.events.find(([event]) => event === 'Sellos: error al identificar el sello')?.[1], { código: 503 });
  view.more();
  const last = await view.settled(state => state.albums.length === 3 && !state.message);
  assert.deepEqual(last.albums.map(album => album.id), ['3', '2', '1']); assert.equal(mb.calls, 1);
  view.close();
});

test('la página oficial de un sello: se detecta por la URL, se piden sus vistas de a 100 y se dibujan años y lista', async () => {
  const { labelPageRef, labelReleases, labelReleasesScript, takeLabelPageScript, labelPageScript } = require('../src/record-labels') as typeof import('../src/record-labels');
  assert.deepEqual(labelPageRef({ country: 'ar', id: '1543968172', name: ' Ghostly  International ' }), { country: 'ar', id: '1543968172', name: 'Ghostly International' });
  assert.equal(labelPageRef({ country: 'arg', id: '1', name: 'x' }), undefined); assert.equal(labelPageRef(null), undefined);
  assert.throws(() => labelReleasesScript('ar', 'x', 'latest-releases', 0)); assert.match(labelReleasesScript('ar', '15', 'top-releases', 100), /record-labels\/15\/view\/top-releases", \{ limit: 100, offset: 100 \}/);
  const art = 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b4/52/61/b45261fd-df30-9a10-f0d4-b6c9051f8b15/67717.jpg/{w}x{h}bb.jpg';
  assert.deepEqual(labelReleases([{ id: '6793256482', name: 'Shop Girl - EP', artist: 'Kate Bollinger', released: '2026-10-02', genre: 'Alternativa', artwork: art },
    { id: 'x', name: 'Bad', artist: 'Bad', released: '', genre: '', artwork: '' }, { id: '2', name: 'Sin fecha', artist: 'A', released: 'pronto', genre: 'G'.repeat(100), artwork: 'https://evil.test/a.jpg' }], 'ar'),
  [{ id: '6793256482', title: 'Shop Girl - EP', artist: 'Kate Bollinger', url: 'https://music.apple.com/ar/album/6793256482',
    artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/b4/52/61/b45261fd-df30-9a10-f0d4-b6c9051f8b15/67717.jpg/300x300bb.jpg', released: '2026-10-02', genre: 'Alternativa' },
  { id: '2', title: 'Sin fecha', artist: 'A', url: 'https://music.apple.com/ar/album/2', genre: 'G'.repeat(80) }]);
  assert.deepEqual(labelReleases('x', 'ar'), []);
  // Recorrido en main: la vista de top releases y después latest-releases hasta una página corta; el estado llega a la página.
  const states: Array<{ open: boolean; busy: boolean; albums: Array<{ id: string }>; message: string }> = [], events: Array<[string, unknown]> = [], views: string[] = [];
  let pathname = '/ar/label/ghostly-international/1543968172';
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com' + pathname,
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) return { request: null, country: 'ar' };
      if (script === takeLabelPageScript) return pathname.includes('/label/') ? { country: 'ar', id: '1543968172', name: 'Ghostly International' } : null;
      const view = script.match(/view\/(latest-releases|top-releases)", \{ limit: 100, offset: (\d+) \}/);
      if (view) {
        views.push(view[1] + ':' + view[2]);
        if (view[1] === 'top-releases') return [{ id: '1', name: 'Top', artist: 'A', released: '2020-01-01', genre: 'Rock', artwork: '' }];
        const offset = Number(view[2]);
        return Array.from({ length: offset === 0 ? 100 : 3 }, (_, i) => ({ id: String(offset + i + 1), name: 'R' + (offset + i), artist: 'B', released: '2021-01-01', genre: '', artwork: '' }));
      }
      const page = script.match(/const state = (\{.*?\});\n/s);
      if (page && script.includes('el-music-label-releases')) states.push(JSON.parse(page[1]));
      return true;
    } }
  });
  const originalInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return {} as NodeJS.Timeout; }) as typeof setInterval;
  try {
    installLabelBrowser(contents as unknown as WebContents, () => assert.fail('fallo'), (event, fields) => events.push([event, fields]));
    tick!();
    for (let waited = 0; waited < 5000 && !(states.at(-1)?.open && !states.at(-1)?.busy); waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    const last = states.at(-1)!;
    assert.equal(last.open, true); assert.equal(last.busy, false); assert.equal(last.message, '');
    assert.equal(last.albums.length, 103); assert.deepEqual(views, ['top-releases:0', 'latest-releases:0', 'latest-releases:100']);
    assert.deepEqual(events.find(([event]) => event === 'Sellos: discos de la página de Apple')?.[1] && { ...(events.find(([event]) => event === 'Sellos: discos de la página de Apple')![1] as object), ms: 0 },
      { álbumes: 103, páginas: 3, estado: 0, ms: 0 });
    // Un sondeo más en la misma página no vuelve a pedir nada; al salir de la página se limpia.
    tick!(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(views.length, 3);
    pathname = '/ar/new'; tick!(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(states.at(-1)!.open, false);
    // El script de la página: fuera de la página del sello sólo quita la sección.
    const removed: string[] = []; const self = {};
    const context = vm.createContext({ document: { documentElement: {}, querySelector: () => null, getElementById: () => ({ remove: () => removed.push('section') }) },
      top: self, self, location: new URL('https://music.apple.com/ar/new'), URL, RegExp });
    assert.equal(vm.runInContext(labelPageScript({ epoch: 'e', open: true, id: '1543968172', country: 'ar', albums: [], busy: false, message: '' }), context), true);
    assert.deepEqual(removed, ['section']);
  } finally { globalThis.setInterval = originalInterval; contents.emit('destroyed'); }
});

const { newReleasesProgress } = require('../src/record-labels') as typeof import('../src/record-labels');
test('el texto y la barra de New releases dicen cuánto falta y cuántos discos van', () => {
  const album = { id: '1', title: 'A', artist: 'B', url: 'https://music.apple.com/ar/album/1' };
  assert.deepEqual(newReleasesProgress(undefined), { message: 'Reading your library…', progress: 'indeterminate' });
  assert.deepEqual(newReleasesProgress({ read: 300, total: 1088, artists: 290, checked: 75, libraryDone: false, albums: [] }),
    { message: 'Checking 85 of 1,088 artists in your library…', progress: 85 / 1088 });
  assert.deepEqual(newReleasesProgress({ read: 1088, total: 1088, artists: 1060, checked: 1000, libraryDone: true, albums: [album] }),
    { message: 'Checking 1,028 of 1,088 artists in your library… · 1 new release so far', progress: 1028 / 1088 });
  assert.equal(newReleasesProgress({ read: 1088, total: 1088, artists: 1060, checked: 1060, libraryDone: true, albums: [] }).progress, 1);
  // Sin total de Apple: el número sólo aparece cuando terminó la biblioteca.
  assert.deepEqual(newReleasesProgress({ read: 100, artists: 100, checked: 50, libraryDone: false, albums: [album, album] }),
    { message: '50 artists in your library checked… · 2 new releases so far', progress: 'indeterminate' });
  assert.equal(newReleasesProgress({ read: 300, artists: 280, checked: 100, libraryDone: true, albums: [] }).message, 'Checking 100 of 280 artists in your library…');
});

test('New releases abre el panel enseguida, muestra el avance y los discos que van llegando, y una lista vieja mientras actualiza', async () => {
  const states: Array<{ busy: boolean; message: string; albums: Array<{ id: string }>; note?: string; progress?: number | string }> = [];
  let request: string | null = null;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/new',
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = request; request = null; return { request: value, country: 'ar' }; }
      const state = script.match(/const state = (\{.*?\});\n/s)?.[1];
      if (state) states.push(JSON.parse(state));
      return true;
    } }
  });
  const album = (id: string) => ({ id, title: 'T' + id, artist: 'A', url: 'https://music.apple.com/ar/album/' + id, released: '2026-10-10' });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let stale = false;
  installLabelBrowser(contents as unknown as WebContents, () => {}, () => {}, () => ({ ids: [], named: [] }), async (_country, _signal, hooks) => {
    if (stale) hooks.onStale({ albums: [album('9')], artists: 900, fromCache: true, checkedAt: Date.now() - 2 * 86400000 });
    await wait(20);
    hooks.onProgress({ read: 100, total: 1088, artists: 100, checked: 0, libraryDone: false, albums: [] });
    await wait(450);
    hooks.onProgress({ read: 600, total: 1088, artists: 590, checked: 400, libraryDone: false, albums: [album('1')] });
    await wait(450);
    hooks.onProgress({ read: 1088, total: 1088, artists: 1060, checked: 1060, libraryDone: true, albums: [album('1'), album('2')] });
    return { albums: [album('1'), album('2')], artists: 1060, fromCache: false, checkedAt: Date.now() };
  });
  const run = async () => {
    states.length = 0; request = 'new-releases';
    contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame });
    for (let waited = 0; waited < 5000 && !(states.length > 1 && !states.at(-1)!.busy); waited += 25) await wait(25);
  };
  await run();
  // Primer dibujo: panel abierto, leyendo la biblioteca con la barra corrida.
  assert.equal(states[0].busy, true); assert.equal(states[0].message, 'Reading your library…'); assert.equal(states[0].progress, 'indeterminate');
  const middle = states.find(state => state.busy && state.albums.length === 1);
  assert.ok(middle, 'los discos parciales se muestran mientras sigue la búsqueda');
  assert.equal(middle!.message, 'Checking 410 of 1,088 artists in your library… · 1 new release so far');
  assert.ok(typeof middle!.progress === 'number' && Math.abs(middle!.progress - 410 / 1088) < 1e-9);
  const last = states.at(-1)!;
  assert.equal(last.busy, false); assert.equal(last.progress, undefined); assert.equal(last.message, '');
  assert.deepEqual(last.albums.map(item => item.id), ['1', '2']); assert.match(last.note!, /by 1,060 artists in your library .* Checked \d\d:\d\d$/);
  // Con una lista de días anteriores: se ve enseguida con «Updating…» y se reemplaza recién al terminar.
  stale = true; await run();
  const updating = states.filter(state => state.busy && state.albums.length);
  assert.ok(updating.length > 0 && updating.every(state => state.albums.map(item => item.id).join() === '9'));
  assert.ok(updating.some(state => state.message.startsWith('Updating… Checking')));
  assert.ok(updating.every(state => !/so far/.test(state.message)), 'con la lista vieja no se cuentan los discos nuevos');
  assert.match(updating[0].note!, /by 900 artists .* Checked [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d$/);
  assert.deepEqual(states.at(-1)!.albums.map(item => item.id), ['1', '2']);
  contents.emit('destroyed');
});

test('dos clics seguidos en New releases: el segundo cancela la búsqueda del primero', async () => {
  let request: string | null = null;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/new',
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = request; request = null; return { request: value, country: 'ar' }; }
      return true;
    } }
  });
  const signals: AbortSignal[] = [];
  installLabelBrowser(contents as unknown as WebContents, () => {}, () => {}, () => ({ ids: [], named: [] }), async (_country, signal) => {
    signals.push(signal);
    await new Promise(resolve => setTimeout(resolve, 300));
    return { albums: [], artists: 1, fromCache: false, checkedAt: Date.now() };
  });
  const click = () => { request = 'new-releases'; contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame }); };
  click(); await new Promise(resolve => setTimeout(resolve, 40)); click();
  for (let waited = 0; waited < 2000 && signals.length < 2; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(signals.length, 2); assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  contents.emit('destroyed');
});

test('Play o Shuffle de un disco de New releases: la cola recibe el disco y los siguientes de la lista mostrada, con su modo', async () => {
  let request: string | null = null, following: string | null = null, parked = false;
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/new',
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = { parked, request, following, country: 'ar' }; request = following = null; return value; }
      return true;
    } }
  });
  const album = (id: string) => ({ id, title: 'T' + id, artist: 'A', url: 'https://music.apple.com/ar/album/' + id, released: '2026-10-10' });
  const starts: Array<{ albums: readonly string[]; mode: string; country: string }> = [];
  const events: string[] = [];
  installLabelBrowser(contents as unknown as WebContents, () => {}, event => events.push(event), () => ({ ids: [], named: [] }),
    async () => ({ albums: ['1', '2', '3', '4'].map(album), artists: 4, fromCache: true, checkedAt: Date.now() }),
    { start: async (albums, mode, country) => { starts.push({ albums, mode, country }); return 'requested'; }, stop: () => {} });
  const send = async (value: string, next: string | null = null) => {
    request = value; following = next;
    contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame });
    await new Promise(resolve => setTimeout(resolve, 60));
  };
  await send('new-releases');
  // Los siguientes que no están en la lista mostrada (99) o repetidos se descartan; el disco elegido va primero.
  await send('play/2/s', '3,99,4,3');
  assert.deepEqual(starts[0], { albums: ['2', '3', '4'], mode: 'shuffle', country: 'ar' });
  await send('play/1/p', '2,3,4');
  assert.deepEqual(starts[1], { albums: ['1', '2', '3', '4'], mode: 'in-order', country: 'ar' });
  // Un disco que no está en la lista no arma ninguna cola.
  await send('play/77/p', '1');
  assert.equal(starts.length, 2); assert.ok(events.includes('Sellos: play rechazado, disco fuera de la lista'));
  // Con el panel escondido (el usuario salió de su página), un Play viene de la lista de la página, no del panel: un
  // disco que sólo está en New releases ya no arma cola con esa lista.
  parked = true;
  await send('play/2/p', '3');
  assert.equal(starts.length, 2, 'el panel escondido no presta su lista');
  assert.equal(events.filter(event => event === 'Sellos: play rechazado, disco fuera de la lista').length, 2);
  contents.emit('destroyed');
});

test('dos Play seguidos: el segundo espera al primero y suena el último; un Play que no prospera retira el aviso del LCD', async () => {
  let request: string | null = null, following: string | null = null;
  const failed: number[] = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/new',
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = { request, following, country: 'ar' }; request = following = null; return value; }
      if (script.includes("'el-music:pending-play', { detail: null }")) failed.push(Date.now());
      return true;
    } }
  });
  const album = (id: string) => ({ id, title: 'T' + id, artist: 'A', url: 'https://music.apple.com/ar/album/' + id, released: '2026-10-10' });
  const starts: string[] = [];
  let release: (() => void) | undefined, result: 'requested' | 'failed' = 'requested';
  installLabelBrowser(contents as unknown as WebContents, () => {}, () => {}, () => ({ ids: [], named: [] }),
    async () => ({ albums: ['1', '2', '3'].map(album), artists: 3, fromCache: true, checkedAt: Date.now() }),
    { start: async albums => { starts.push(albums[0]); if (starts.length === 1) await new Promise<void>(resolve => { release = resolve; }); return result; }, stop: () => {} });
  const send = async (value: string) => {
    request = value; following = null;
    contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame });
    await new Promise(resolve => setTimeout(resolve, 60));
  };
  await send('new-releases');
  await send('play/1/p'); await send('play/2/p'); await send('play/3/s');
  assert.deepEqual(starts, ['1'], 'mientras el primero está en vuelo no arranca otro');
  release!(); await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(starts, ['1', '3'], 'después suena el último clic; el del medio se descarta');
  assert.equal(failed.length, 0);
  // Sin otro esperando, un Play que no prosperó retira el aviso; uno fuera de la lista también.
  result = 'failed'; await send('play/2/p'); assert.equal(failed.length, 1);
  await send('play/77/p'); assert.equal(failed.length, 2);
  contents.emit('destroyed');
});

test('las navegaciones del enrutador no cierran el panel (el shell lo esconde y Back vuelve a él); una recarga del documento sí', async () => {
  let request: string | null = null, url = 'https://music.apple.com/ar/new';
  const scripts: string[] = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => url,
    mainFrame: { executeJavaScript: async (script: string) => {
      if (script.includes('delete root.dataset.elMusicLabelRequest')) { const value = { request, following: null, country: 'ar' }; request = null; return value; }
      scripts.push(script); return true;
    } }
  });
  installLabelBrowser(contents as unknown as WebContents, () => {}, () => {}, () => ({ ids: [], named: [] }),
    async () => ({ albums: [{ id: '1', title: 'T', artist: 'A', url: 'https://music.apple.com/ar/album/1', released: '2026-10-10' }], artists: 1, fromCache: true, checkedAt: Date.now() }),
    { start: async () => 'requested', stop: () => {} });
  request = 'new-releases'; contents.emit('console-message', { message: 'elMusic.labels.request-ready', frame: contents.mainFrame });
  await new Promise(resolve => setTimeout(resolve, 80));
  const closes = (): number => scripts.filter(script => script.includes("getElementById('el-music-label-panel')") && script.includes('"open":false')).length;
  const before = closes();
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://music.apple.com/ar/new' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closes(), before, 'misma URL: el panel sigue');
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://music.apple.com/ar/album/x/1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(closes(), before, 'otra página del enrutador: el panel sigue abierto (escondido por el shell)');
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://music.apple.com/ar/new' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(closes() > before, 'recarga u otro documento: el panel se cierra');
  url = 'https://music.apple.com/ar/album/x/1';
  contents.emit('destroyed');
});
