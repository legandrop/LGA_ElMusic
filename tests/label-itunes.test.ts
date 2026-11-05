import test from 'node:test';
import assert from 'node:assert/strict';
import { itunesIdle, lookupAppleAlbums, searchAppleAlbums } from '../src/recommendations';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

test('búsqueda iTunes de álbumes para la columna Label: sólo ID, nombre y artista validados, en segundo plano', async () => {
  const original = globalThis.fetch; const urls: string[] = [];
  try {
    globalThis.fetch = async url => {
      urls.push(String(url));
      return Response.json({ results: [
        { wrapperType: 'collection', collectionId: 1440729339, collectionName: 'Verve Remixed 2', artistName: 'Varios Artistas', collectionPrice: 9.99, primaryGenreName: 'Electronic' },
        { wrapperType: 'collection', collectionId: 1440729339, collectionName: 'Repetido', artistName: 'X' },
        { wrapperType: 'track', collectionId: 5, collectionName: 'Una canción', artistName: 'Y' },
        { wrapperType: 'collection', collectionId: 'x7', collectionName: 'ID raro', artistName: 'Z' },
        { wrapperType: 'collection', collectionId: 8, collectionName: '', artistName: 'Z' }] });
    };
    const signal = new AbortController().signal;
    assert.deepEqual(await searchAppleAlbums('  Verve   Remixed 2 ', 'ar', signal, 25), [{ id: '1440729339', name: 'Verve Remixed 2', artist: 'Varios Artistas', genre: 'Electronic' }]);
    const search = new URL(urls.at(-1)!);
    assert.equal(search.origin + search.pathname, 'https://itunes.apple.com/search');
    assert.deepEqual(Object.fromEntries(search.searchParams), { term: 'Verve Remixed 2', media: 'music', entity: 'album', country: 'ar', limit: '25' });
    // El término se recorta a 200 caracteres; país y límite inválidos no salen a la red.
    await searchAppleAlbums('a'.repeat(300), 'ar', signal); assert.equal(new URL(urls.at(-1)!).searchParams.get('term')!.length, 200);
    const count = urls.length;
    for (const [term, country, limit] of [['x', 'ARG', 10], [' ', 'ar', 10], ['x', 'ar', 26]] as const)
      await assert.rejects(searchAppleAlbums(term, country, signal, limit), /INVALID_ALBUM_SEARCH/);
    assert.equal(urls.length, count);
    // Un rechazo no traba la cola ni deja pedidos pendientes; una respuesta con otra forma no devuelve nada.
    globalThis.fetch = async () => { throw new TypeError('red'); };
    await assert.rejects(searchAppleAlbums('x', 'ar', signal));
    globalThis.fetch = async () => Response.json({ results: 'x' });
    assert.deepEqual(await searchAppleAlbums('x', 'ar', signal), []);
    // Una búsqueda de sellos no cuenta como pedido de primer plano: la cola queda libre para otra apenas termina.
    assert.equal(itunesIdle(), true);
    await lookupAppleAlbums(['1'], 'ar', signal); assert.equal(itunesIdle(), false);
  } finally { globalThis.fetch = original; }
});
