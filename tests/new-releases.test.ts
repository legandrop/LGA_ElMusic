import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import type { WebContents } from 'electron';
import { libraryArtistsScript, latestReleasesScript, parseLibraryArtists, parseLatestReleases, sinceDate, readNewReleasesCache, saveNewReleasesCache,
  loadNewReleases, newReleasesLimits, NewReleasesError } from '../src/new-releases';

const now = Date.UTC(2026, 9, 20, 12, 0, 0);
const art = 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/8d/7d/5a/x/1000x1000bb.jpg'.replace('1000x1000bb', '{w}x{h}bb');

test('los scripts sólo corren en la página musical y piden lo mínimo', async () => {
  const outside = vm.createContext({ top: {}, self: {}, location: new URL('https://music.apple.com.evil.test/'), URL });
  for (const script of [libraryArtistsScript(0), latestReleasesScript('ar', ['1'])]) assert.equal(await vm.runInContext(script, outside), null);
  assert.match(libraryArtistsScript(200), /\/v1\/me\/library\/artists', \{ limit: 100, offset: 200, include: 'catalog' \}/);
  assert.match(latestReleasesScript('ar', ['1', '2']), /\/v1\/catalog\/ar\/artists", \{ ids: "1,2", views: 'latest-release' \}/);
  assert.throws(() => libraryArtistsScript(-1)); assert.throws(() => latestReleasesScript('ARG', ['1']));
  assert.throws(() => latestReleasesScript('ar', ['x'])); assert.throws(() => latestReleasesScript('ar', Array.from({ length: 26 }, (_, i) => String(i))));
});

test('los artistas de la biblioteca se leen sólo con ID de catálogo numérico, sin repetir', () => {
  assert.deepEqual(parseLibraryArtists({ more: true, artists: [{ id: '416281071', name: ' Bonobo ' }, { id: '', name: 'Sin catálogo' }, { id: 'r.x', name: 'Raro' },
    { id: '416281071', name: 'Bonobo' }, { id: '2539498', name: 'Fink' }] }), { artists: [{ id: '416281071', name: 'Bonobo' }, { id: '2539498', name: 'Fink' }], more: true });
  assert.deepEqual(parseLibraryArtists({ error: 403 }), { artists: [], more: false, error: 403 });
  assert.deepEqual(parseLibraryArtists('x'), { artists: [], more: false });
  assert.deepEqual(parseLibraryArtists(null), { artists: [], more: false });
});

test('los lanzamientos se filtran por fecha, se validan y conservan portada y género', () => {
  assert.equal(sinceDate(now), '2026-09-22');
  const value = [
    { artist: '416281071', albums: [{ id: '1895659203', name: 'Distance in Static', artist: 'Bonobo', released: '2026-09-11', genre: 'Electrónica', artwork: art }] },
    { artist: '2539498', albums: [{ id: '6812818891', name: ' More - Single ', artist: 'Fink & Jan Blomqvist', released: '2026-10-09', genre: 'Electrónica', artwork: art },
      { id: '6812818891', name: 'repetido', artist: 'Fink', released: '2026-10-09' }] },
    { artist: '1', albums: [{ id: '7', name: 'Mala portada', artist: 'A', released: '2026-10-01', artwork: 'https://evil.test/x.jpg' },
      { id: '10', name: 'Preventa', artist: 'A', released: '2027-01-09' },
      { id: 'x', name: 'ID inválido', artist: 'A', released: '2026-10-01' }, { id: '8', name: 'Fecha rara', artist: 'A', released: '2026-10' }] },
    { artist: '9', albums: [] }, null, 'x'];
  const { albums } = parseLatestReleases(value, 'ar', '2026-09-22', '2026-10-20');
  assert.equal(parseLatestReleases(value, 'ar', '2026-09-22').albums.length, 3);
  assert.deepEqual(albums, [
    { id: '6812818891', title: 'More - Single', artist: 'Fink & Jan Blomqvist', url: 'https://music.apple.com/ar/album/6812818891', released: '2026-10-09',
      artworkUrl: art.replace('{w}x{h}bb', '100x100bb'), genre: 'Electrónica' },
    { id: '7', title: 'Mala portada', artist: 'A', url: 'https://music.apple.com/ar/album/7', released: '2026-10-01' }]);
  assert.deepEqual(parseLatestReleases({ error: 429 }, 'ar', '2026-09-22'), { albums: [], error: 429 });
  assert.deepEqual(parseLatestReleases(value, 'ARG', '2026-09-22'), { albums: [] });
});

test('la caché de novedades es de un día, por país, y rechaza archivos ajenos', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-releases-'));
  try {
    const file = path.join(folder, 'new-releases.json');
    assert.equal(readNewReleasesCache(file, now), undefined);
    const album = { id: '6812818891', title: 'More - Single', artist: 'Fink', url: 'https://music.apple.com/ar/album/6812818891', released: '2026-10-09', genre: 'Electrónica' };
    saveNewReleasesCache(file, { checkedAt: now, country: 'ar', artists: 2, releases: [album] });
    assert.deepEqual(readNewReleasesCache(file, now), { checkedAt: now, country: 'ar', artists: 2, releases: [album] });
    assert.deepEqual(fs.readdirSync(folder), ['new-releases.json']);
    for (const content of ['no json', '{"version":2,"checkedAt":1,"country":"ar","artists":1,"releases":[]}', JSON.stringify({ version: 1, checkedAt: now, country: 'ar', artists: 1,
      releases: [{ ...album, url: 'https://evil.test/' }] }), JSON.stringify({ version: 1, checkedAt: now, country: 'ar', artists: 1, releases: [{ ...album, artworkUrl: 'https://evil.test/a.jpg' }] }),
      JSON.stringify({ version: 1, checkedAt: now + 120000, country: 'ar', artists: 1, releases: [] })]) {
      fs.writeFileSync(file, content); assert.equal(readNewReleasesCache(file, now), undefined, content);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('el recorrido lee las páginas de artistas, pide lotes al catálogo y usa la caché un día', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-releases-'));
  try {
    const file = path.join(folder, 'new-releases.json'), scripts: string[] = [], events: Array<[string, unknown]> = [];
    const artists = Array.from({ length: 130 }, (_, i) => ({ id: String(1000 + i), name: 'Artist ' + i }));
    const contents = { mainFrame: { executeJavaScript: async (script: string) => {
      scripts.push(script);
      const page = script.match(/offset: (\d+)/);
      if (page) { const offset = Number(page[1]); return { more: offset + 100 < artists.length, artists: artists.slice(offset, offset + 100) }; }
      const ids = script.match(/ids: "([^"]+)"/)![1].split(',');
      return ids.map(id => ({ artist: id, albums: id === '1003' || id === '1120' ? [{ id: '9' + id, name: 'New ' + id, artist: 'Artist', released: id === '1003' ? '2026-10-01' : '2026-10-15', artwork: art }] :
        [{ id: '8' + id, name: 'Old', artist: 'Artist', released: '2020-01-01' }] }));
    } }, isDestroyed: () => false };
    const first = await loadNewReleases(contents as unknown as WebContents, 'ar', { cacheFile: file, signal: new AbortController().signal, now, log: (event, fields) => events.push([event, fields]) });
    assert.equal(first.fromCache, false); assert.equal(first.artists, 130);
    assert.deepEqual(first.albums.map(album => album.id), ['91120', '91003']);
    assert.equal(scripts.filter(script => script.includes('library/artists')).length, 2);
    assert.equal(scripts.filter(script => script.includes('latest-release')).length, Math.ceil(130 / newReleasesLimits.idsPerRequest));
    assert.deepEqual(events.map(([event]) => event), ['Novedades: artistas de la biblioteca', 'Novedades: lanzamientos']);
    const second = await loadNewReleases(contents as unknown as WebContents, 'ar', { cacheFile: file, signal: new AbortController().signal, now: now + 3600000 });
    assert.equal(second.fromCache, true); assert.deepEqual(second.albums.map(album => album.id), ['91120', '91003']);
    const third = await loadNewReleases(contents as unknown as WebContents, 'us', { cacheFile: file, signal: new AbortController().signal, now: now + 3600000 });
    assert.equal(third.fromCache, false);
    // Error de la biblioteca (sin sesión): etapa 1 con su estado, sin tocar la caché.
    const denied = { mainFrame: { executeJavaScript: async () => ({ error: 403 }) }, isDestroyed: () => false };
    await assert.rejects(loadNewReleases(denied as unknown as WebContents, 'ar', { signal: new AbortController().signal, now }), (error: NewReleasesError) => error.stage === 1 && error.status === 403);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(loadNewReleases(contents as unknown as WebContents, 'ar', { signal: aborted.signal, now: now + 2 * newReleasesLimits.cacheMs }));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

// Biblioteca simulada de 1088 artistas con demora por pedido: cuenta cuántas páginas de la biblioteca hay en vuelo y en
// qué momento empieza el primer lote del catálogo.
function slowLibrary(options: { total?: boolean; failPage?: number; reportedTotal?: number; quotaPage?: number } = {}) {
  const artists = Array.from({ length: 1088 }, (_, i) => ({ id: String(5000 + i), name: 'Artist ' + i }));
  const trace = { inFlight: 0, maxInFlight: 0, libraryCalls: 0, libraryDoneAt: 0, firstCatalogAt: 0, catalogCalls: 0 };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const contents = { isDestroyed: () => false, mainFrame: { executeJavaScript: async (script: string) => {
    const page = script.match(/offset: (\d+)/);
    if (page) {
      const offset = Number(page[1]); trace.libraryCalls++; trace.inFlight++; trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight);
      await wait(30); trace.inFlight--;
      if (options.failPage !== undefined && offset === options.failPage * 100) return { error: 500 };
      if (options.quotaPage !== undefined && offset === options.quotaPage * 100) { options.quotaPage = undefined; return { error: 429 }; }
      if (offset + 100 >= artists.length) trace.libraryDoneAt = Date.now();
      return { more: offset + 100 < artists.length, ...(options.total === false ? {} : { total: options.reportedTotal ?? artists.length }), artists: artists.slice(offset, offset + 100) };
    }
    trace.catalogCalls++; if (!trace.firstCatalogAt) trace.firstCatalogAt = Date.now();
    await wait(5);
    const ids = script.match(/ids: "([^"]+)"/)![1].split(',');
    return ids.map(id => ({ artist: id, albums: Number(id) % 97 === 0 ? [{ id: '7' + id, name: 'New ' + id, artist: 'Artist', released: '2026-10-1' + (Number(id) % 9), artwork: art }] : [] }));
  } } };
  return { contents: contents as unknown as WebContents, trace };
}

test('con el total de Apple la biblioteca se lee de a tres páginas y el catálogo arranca antes de terminarla, con progreso', async () => {
  const { contents, trace } = slowLibrary();
  const steps: Array<{ read: number; total?: number; artists: number; checked: number; libraryDone: boolean; albums: unknown[] }> = [];
  const result = await loadNewReleases(contents, 'ar', { signal: new AbortController().signal, now, onProgress: step => steps.push(step) });
  assert.equal(result.artists, 1088); assert.equal(trace.libraryCalls, 11);
  assert.equal(trace.maxInFlight, newReleasesLimits.libraryInFlight);
  assert.ok(trace.firstCatalogAt && trace.firstCatalogAt < trace.libraryDoneAt, 'el catálogo empieza mientras se lee la biblioteca');
  assert.equal(trace.catalogCalls, Math.ceil(1088 / newReleasesLimits.idsPerRequest));
  for (let i = 1; i < result.albums.length; i++) assert.ok((result.albums[i - 1].released ?? '') >= (result.albums[i].released ?? ''), 'del más nuevo al más viejo');
  assert.equal(result.albums.length, Array.from({ length: 1088 }, (_, i) => 5000 + i).filter(id => id % 97 === 0).length);
  // El progreso nunca retrocede y termina con la biblioteca completa y todos los artistas consultados.
  for (let i = 1; i < steps.length; i++) { assert.ok(steps[i].checked >= steps[i - 1].checked); assert.ok(steps[i].read >= steps[i - 1].read); }
  assert.equal(steps[0].total, 1088);
  const last = steps.at(-1)!;
  assert.equal(last.libraryDone, true); assert.equal(last.checked, 1088); assert.equal(last.artists, 1088); assert.equal(last.albums.length, result.albums.length);
});

test('sin total la biblioteca sigue de a una página hasta que Apple dice que no hay más', async () => {
  const { contents, trace } = slowLibrary({ total: false });
  const result = await loadNewReleases(contents, 'ar', { signal: new AbortController().signal, now });
  assert.equal(result.artists, 1088); assert.equal(trace.libraryCalls, 11); assert.equal(trace.maxInFlight, 1);
});

test('si una página de la biblioteca falla, el catálogo no queda esperando y el error es de la etapa 1', async () => {
  const { contents } = slowLibrary({ failPage: 5 });
  const started = Date.now();
  await assert.rejects(loadNewReleases(contents, 'ar', { signal: new AbortController().signal, now }), (error: NewReleasesError) => error.stage === 1 && error.status === 500);
  assert.ok(Date.now() - started < 3000);
});

test('una lista de hasta 7 días se muestra al instante y se actualiza igual; más vieja, no se muestra', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-releases-'));
  try {
    const file = path.join(folder, 'new-releases.json'), day = 24 * 60 * 60 * 1000;
    const recent = { id: '61', title: 'Recent', artist: 'A', url: 'https://music.apple.com/ar/album/61', released: '2026-10-18' };
    const gone = { id: '62', title: 'Gone', artist: 'B', url: 'https://music.apple.com/ar/album/62', released: '2026-09-20' };
    saveNewReleasesCache(file, { checkedAt: now - 2 * day, country: 'ar', artists: 900, releases: [recent, gone] });
    const shown: Array<{ albums: Array<{ id: string }>; artists: number; fromCache: boolean; checkedAt: number }> = [];
    const { contents } = slowLibrary();
    const result = await loadNewReleases(contents, 'ar', { cacheFile: file, signal: new AbortController().signal, now, onStale: cached => shown.push(cached) });
    // La lista vieja se acota a la ventana de hoy (el disco de hace más de cuatro semanas sale) y se entrega una sola vez.
    assert.equal(shown.length, 1); assert.deepEqual(shown[0].albums.map(album => album.id), ['61']);
    assert.equal(shown[0].artists, 900); assert.equal(shown[0].checkedAt, now - 2 * day);
    assert.equal(result.fromCache, false); assert.equal(readNewReleasesCache(file, now)?.checkedAt, now);
    saveNewReleasesCache(file, { checkedAt: now - 8 * day, country: 'ar', artists: 900, releases: [recent] });
    shown.length = 0;
    await loadNewReleases(contents, 'ar', { cacheFile: file, signal: new AbortController().signal, now, onStale: cached => shown.push(cached) });
    assert.equal(shown.length, 0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('una respuesta 429 de Apple se reintenta y la carga sigue; un total menor de lo real no corta la biblioteca', async () => {
  const quota = slowLibrary({ quotaPage: 4 }), events: string[] = [];
  const result = await loadNewReleases(quota.contents, 'ar', { signal: new AbortController().signal, now, log: event => events.push(event) });
  assert.equal(result.artists, 1088); assert.equal(quota.trace.libraryCalls, 12);
  assert.deepEqual(events.filter(event => event.includes('cuota')), ['Novedades: cuota de Apple, reintento']);
  const short = slowLibrary({ reportedTotal: 150 });
  const all = await loadNewReleases(short.contents, 'ar', { signal: new AbortController().signal, now });
  assert.equal(all.artists, 1088); assert.equal(short.trace.libraryCalls, 11);
});
