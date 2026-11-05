import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { albumRef, parsePublicAlbum, labelsOfExactRelease, publicAlbum, PublicMetadataError, musicBrainz, labelAlbumIds, findLabelByName } from '../src/labels';
import { labelLinkKey, parseLabelRequest } from '../src/record-labels';
import { playerSampleScript } from '../src/player';
import { lookupAppleAlbums } from '../src/recommendations';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

const ref = { country: 'ar', id: '123456789' };
const mbid = '7eafcf10-49dc-4646-8870-5e5505626b0f';
const label = { id: mbid, name: 'Other People', source: 'MusicBrainz' as const };
function albumHtml(id = ref.id, country = ref.country, extra: Record<string, unknown> = {}): string {
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: 'AlbumDetailPageIntent', contentDescriptor: { kind: 'album', identifiers: { storeAdamID: id }, locale: { storefront: country } } },
    data: { sections: [{ items: [{ contentDescriptor: { kind: 'album', identifiers: { storeAdamID: id } }, title: 'Public album', subtitleLinks: [{ title: 'Artist' }], ...extra }] }] }
  }] }) + '</script>';
}
test('only public album URLs enter label metadata requests', () => {
  assert.deepEqual(albumRef('https://music.apple.com/ar/album/sirens/123456789?i=987'), ref);
  for (const url of ['http://music.apple.com/ar/album/123456789', 'https://music.apple.com.evil.test/ar/album/123456789',
    'https://person:secret@music.apple.com/ar/album/123456789', 'https://music.apple.com:444/ar/album/123456789',
    'https://music.apple.com/ar/artist/123456789', 'https://music.apple.com/ar/album/123456789?token=secret']) assert.equal(albumRef(url), undefined);
});
test('album identity and storefront are required; copyright is never a label', () => {
  assert.throws(() => parsePublicAlbum(albumHtml('987', 'ar'), ref), /ID_MISMATCH/);
  assert.throws(() => parsePublicAlbum(albumHtml('987', 'ar', { related: { contentDescriptor: { kind: 'album', identifiers: { storeAdamID: ref.id } } } }), ref), /ID_MISMATCH/);
  assert.throws(() => parsePublicAlbum(albumHtml(ref.id, 'us'), ref), /ID_MISMATCH/);
  assert.throws(() => parsePublicAlbum(albumHtml(ref.id, 'ar', { contentDescriptor: { kind: 'album', identifiers: { storeAdamID: '987' } } }), ref), /ID_MISMATCH/);
  assert.throws(() => parsePublicAlbum(albumHtml(ref.id, 'ar', { contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: ref.id } } }), ref), /ID_MISMATCH/);
  assert.deepEqual(parsePublicAlbum(albumHtml(ref.id, 'ar', { copyright: '℗ 2016 Other People' }), ref).labels, []);
  const parsed = parsePublicAlbum(albumHtml(ref.id, 'ar', { linkSection: { link: { title: '<Blue Note>', segue: { destination: { intent: {
    $kind: 'RecordLabelDetailPageIntent', contentDescriptor: { identifiers: { storeAdamID: '1556734421' } }
  } } } } } }), ref);
  assert.equal(parsed.labels[0].name, '<Blue Note>'); assert.equal(parsed.labels[0].source, 'Apple Music');
});
test('community labels belong only to editions linked to the exact Apple ID', () => {
  const release = { 'label-info': [{ label: { id: mbid, name: label.name } }], relations: [{ url: { resource: 'https://music.apple.com/gb/album/123456789' } }] };
  assert.deepEqual(labelsOfExactRelease(release, ref.id), [label]);
  assert.deepEqual(labelsOfExactRelease(release, '999'), []);
  assert.deepEqual(labelsOfExactRelease({ ...release, relations: [{ url: { resource: 'https://music.apple.com.evil.test/gb/album/123456789' } }] }, ref.id), []);
});
test('la columna sólo puede pedir sellos que main publicó, con sintaxis cerrada', () => {
  const mb = labelLinkKey({ kind: 'mb', id: mbid, name: 'Other  People ' })!;
  const apple = labelLinkKey({ kind: 'apple', url: 'https://music.apple.com/ar/label/blue-note/1556734421', name: 'Blue Note' })!;
  const holder = labelLinkKey({ kind: 'name', name: 'Warp Records' })!;
  assert.equal(mb, 'm' + mbid); assert.equal(apple, 'a1556734421'); assert.match(holder, /^p[a-f\d]{20}$/);
  assert.deepEqual(parseLabelRequest('open/' + mb), { action: 'open', link: { kind: 'mb', id: mbid, name: 'Other People' } });
  assert.equal((parseLabelRequest('open/' + apple) as { link: { kind: string } }).link.kind, 'apple');
  assert.deepEqual(parseLabelRequest('close'), { action: 'close' }); assert.deepEqual(parseLabelRequest('more'), { action: 'more' });
  // Play: el modo va en el pedido (p en orden, s mezclado) y los discos siguientes en un campo aparte, hasta 299.
  assert.deepEqual(parseLabelRequest('play/1631566422/p'), { action: 'play', id: '1631566422', mode: 'in-order', following: [] });
  assert.deepEqual(parseLabelRequest('play/1631566422/s', '1,22,333'), { action: 'play', id: '1631566422', mode: 'shuffle', following: ['1', '22', '333'] });
  const many = Array.from({ length: 299 }, (_, i) => String(i + 2)).join(',');
  assert.equal((parseLabelRequest('play/1/p', many) as { following: string[] }).following.length, 299);
  // Un campo de siguientes inválido o de más de 299 no rechaza el Play: se reproduce sólo el disco elegido.
  for (const following of [many + ',999', '1,,2', '1,2,', 'x', 42, ',1']) assert.deepEqual((parseLabelRequest('play/1/p', following) as { following: string[] }).following, [], String(following));
  // Desde un tema del disco desplegado: play/ID/p/TEMA (sólo en orden).
  assert.deepEqual(parseLabelRequest('play/1631566422/p/1631566430', '7'), { action: 'play', id: '1631566422', mode: 'in-order', following: ['7'], start: '1631566430' });
  for (const value of ['play/1/s/2', 'play/1/p/', 'play/1/p/x', 'play/1/p/2/3', 'play/1/p/123456789012345678901']) assert.equal(parseLabelRequest(value), undefined, value);
  assert.deepEqual(parseLabelRequest('new-releases'), { action: 'new-releases' }); assert.equal(parseLabelRequest('new-releases/x'), undefined);
  for (const value of ['play/', 'play/x1', 'play/123456789012345678901/p', 'play/1', 'play/1/', 'play/1/x', 'play/1/pp', 'play/1/2,3', 'play/1631566422/1,22,333']) assert.equal(parseLabelRequest(value), undefined, value);
  for (const value of ['open/m00000000-0000-0000-0000-000000000000', 'open/' + mb + '/', 'open/a1', 'open/https://evil.test', 'fetch/' + mb, 'close/x', 42]) assert.equal(parseLabelRequest(value), undefined);
  for (const link of [{ kind: 'apple' as const, url: 'https://evil.test/ar/label/1', name: 'x' }, { kind: 'apple' as const, url: 'https://music.apple.com/ar/label/1?x=1', name: 'x' },
    { kind: 'mb' as const, id: 'not-an-mbid', name: 'x' }, { kind: 'name' as const, name: '   ' }]) assert.equal(labelLinkKey(link), undefined);
});
test('discos del sello: IDs de Apple de MusicBrainz y disponibilidad regional en un solo Lookup', async () => {
  const original = globalThis.fetch; const urls: string[] = [];
  try {
    globalThis.fetch = async url => {
      urls.push(String(url));
      return Response.json({ 'release-count': 150, releases: [
        { relations: [{ url: { resource: 'https://music.apple.com/gb/album/x/111' } }, { url: { resource: 'https://music.apple.com/us/album/111' } }] },
        { relations: [{ url: { resource: 'https://music.apple.com/us/album/222' } }, { url: { resource: 'https://evil.test/us/album/333' } }] }, { relations: [] }] });
    };
    assert.deepEqual(await labelAlbumIds(mbid, 0), { ids: ['111', '222'], unlinked: [], nextOffset: 3, more: true });
    assert.equal(new URL(urls.at(-1)!).searchParams.get('inc'), 'url-rels artist-credits');
    assert.match(urls[0], /^https:\/\/musicbrainz\.org\/ws\/2\/release\?label=7eafcf10/);
    globalThis.fetch = async url => {
      urls.push(String(url));
      return Response.json({ results: [
        { wrapperType: 'collection', collectionId: 111, collectionName: 'One', artistName: 'A', releaseDate: '2020-05-01T07:00:00Z', artworkUrl100: 'https://evil.test/x.jpg' },
        { wrapperType: 'track', collectionId: 222, collectionName: 'Two', artistName: 'B' },
        { wrapperType: 'collection', collectionId: 999, collectionName: 'Not asked', artistName: 'C' }] });
    };
    const albums = await lookupAppleAlbums(['111', '222', 'x'], 'ar', new AbortController().signal);
    assert.deepEqual(albums, [{ id: '111', title: 'One', artist: 'A', url: 'https://music.apple.com/ar/album/111', artworkUrl: undefined, released: '2020-05-01' }]);
    const lookup = new URL(urls.at(-1)!); assert.equal(lookup.hostname, 'itunes.apple.com'); assert.equal(lookup.searchParams.get('id'), '111,222'); assert.equal(lookup.searchParams.get('country'), 'ar');
  } finally { globalThis.fetch = original; }
});
test('el titular ℗ sólo se convierte en sello si MusicBrainz tiene uno con ese nombre exacto', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ labels: [{ id: mbid, name: 'Warp Records' }, { id: '00000000-0000-4000-8000-000000000000', name: 'Warp Records Ltd' }] });
    assert.deepEqual(await findLabelByName(' warp  records'), { id: mbid, name: 'Warp Records', source: 'MusicBrainz' });
    globalThis.fetch = async () => Response.json({ labels: [{ id: mbid, name: 'Warp Records' }, { id: '00000000-0000-4000-8000-000000000000', name: 'WARP RECORDS' }] });
    assert.equal(await findLabelByName('Warp Records'), undefined);
  } finally { globalThis.fetch = original; }
});
test('sampler executes as page JavaScript and refuses authentication contexts', () => {
  const script = new vm.Script(playerSampleScript);
  const context: Record<string, unknown> = { top: {}, self: {}, location: { protocol: 'https:', hostname: 'accounts.apple.com' } };
  assert.equal(script.runInNewContext(context), null);
  const frame = {}; const url = 'https://music.apple.com/ar/album/sirens/123456789';
  context.top = frame; context.self = frame; context.URL = URL;
  context.location = { href: url, pathname: '/ar/album/sirens/123456789', protocol: 'https:', hostname: 'music.apple.com', port: '' };
  context.document = { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const result = script.runInNewContext(context); assert.equal(result.albumUrl, url); assert.equal(result.seed, null);
  assert.equal(result.metadataPresent, false);
});
test('anonymous fetch rejects redirect escape and oversized public bodies', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++; assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
      return new Response(null, { status: 301, headers: { location: 'https://evil.test/ar/album/90001' } });
    };
    await assert.rejects(publicAlbum({ country: 'ar', id: '90001' }, false), /REDIRECT_DENIED/); assert.equal(calls, 1);
    globalThis.fetch = async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1));
    await assert.rejects(publicAlbum({ country: 'ar', id: '90002' }, false), /TOO_LARGE/);
  } finally { globalThis.fetch = original; }
});
test('manual album lookups discard failed promises and expose only closed transport errors', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return calls === 1 ? new Response('private provider message', { status: 503 }) : new Response(albumHtml('90101')); };
    await assert.rejects(publicAlbum({ country: 'ar', id: '90101' }, false), error => error instanceof PublicMetadataError && error.kind === 'http' && error.status === 503 && error.message === 'PUBLIC_METADATA_UNAVAILABLE');
    assert.equal((await publicAlbum({ country: 'ar', id: '90101' }, false)).title, 'Public album'); assert.equal(calls, 2);
    globalThis.fetch = async () => { throw new TypeError('private network details'); };
    await assert.rejects(publicAlbum({ country: 'ar', id: '90102' }, false), error => error instanceof PublicMetadataError && error.kind === 'network' && error.status === undefined && !error.message.includes('private'));
  } finally { globalThis.fetch = original; }
});
test('MusicBrainz shares Retry-After cooldown and never requests before a long valid deadline', async () => {
  const original = globalThis.fetch; const originalNow = Date.now; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '7200' } }); };
    await assert.rejects(musicBrainz('artist', { query: 'fixture' }), error => error instanceof PublicMetadataError && error.kind === 'http' && error.status === 429);
    await assert.rejects(musicBrainz('recording', { query: 'fixture' }), error => error instanceof PublicMetadataError && error.status === 429); assert.equal(calls, 1);
    Date.now = () => originalNow() + 3600001;
    await assert.rejects(musicBrainz('artist', { query: 'fixture' }), error => error instanceof PublicMetadataError && error.status === 429); assert.equal(calls, 1);
    Date.now = () => originalNow() + 7200001;
    globalThis.fetch = async () => { calls++; return Response.json({ artists: [], count: 0 }); };
    assert.equal((await musicBrainz('artist', { query: 'fixture' })).count, 0); assert.equal(calls, 2);
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});

test('el titular ℗ del pie del tracklist sale limpio y no se confunde con un sello acreditado', async () => {
  const { phonographicHolder } = await import('../src/labels');
  assert.equal(phonographicHolder('5 de abril de 2024\n9 Canciones y 36 minutos\n℗ 2024 Warp Records'), 'Warp Records');
  assert.equal(phonographicHolder('℗ 2017 Mount Kimbie under exclusive licence to Warp Records Limited.'), 'Warp Records Limited');
  assert.equal(phonographicHolder('℗ 2001, 2012 Virgin Records'), 'Virgin Records');
  assert.equal(phonographicHolder('© 2020 Someone\n12 songs'), undefined);
  const footer = { id: 'track-list-section - ' + ref.id, itemKind: 'containerDetailTracklistFooterLockup', items: [{ description: '1 de enero de 2020\n℗ 2020 Other People' }] };
  const withFooter = (section: object): string => { const html = albumHtml(); const data = JSON.parse(html.slice(html.indexOf('>') + 1, html.lastIndexOf('<')));
    data.data[0].data.sections.push(section); return '<script id="serialized-server-data">' + JSON.stringify(data) + '</script>'; };
  const html = withFooter(footer);
  const album = parsePublicAlbum(html, ref);
  assert.equal(album.copyrightHolder, 'Other People'); assert.deepEqual(album.labels, []);
  const foreign = withFooter({ ...footer, id: 'track-list-section - 999' });
  assert.equal(parsePublicAlbum(foreign, ref).copyrightHolder, undefined);
});

test('la página oficial del sello en Apple sólo se elige por nombre equivalente y con IDs numéricos', async () => {
  const { pickAppleLabel, appleLabelSearchScript } = await import('../src/record-labels');
  assert.equal(pickAppleLabel([{ id: '1543990853', name: 'Ninja Tune' }], 'Ninja Tune Ltd.'), '1543990853');
  assert.equal(pickAppleLabel([{ id: '1', name: 'Time Warp Records' }], 'Warp Records'), undefined);
  assert.equal(pickAppleLabel([{ id: '../x', name: 'Warp' }], 'Warp'), undefined);
  assert.equal(pickAppleLabel(null, 'Warp'), undefined);
  assert.throws(() => appleLabelSearchScript('Warp', 'us/evil'), /INVALID_COUNTRY/);
  const frame = {}; const calls: unknown[] = [];
  const music = { api: { music: async (...args: unknown[]) => { calls.push(args); return { data: { results: { 'record-labels': { data: [{ id: 7, attributes: { name: 'Warp' } }] } } } }; } } };
  const context = vm.createContext({ top: frame, self: frame, URL, location: { href: 'https://music.apple.com/library/playlist/p.x', protocol: 'https:', hostname: 'music.apple.com', port: '' },
    MusicKit: { getInstance: () => music } });
  assert.deepEqual(JSON.parse(JSON.stringify(await vm.runInContext(appleLabelSearchScript('"Warp"', 'ar'), context))), [{ id: '7', name: 'Warp' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/v1/catalog/ar/search', { term: '"Warp"', types: 'record-labels', limit: 5 }]]);
});
test('a blocked connection is retried 3 times before failing, and a later attempt can succeed', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; if (calls < 3) throw new TypeError('blocked by firewall'); return new Response(albumHtml('90201')); };
    assert.equal((await publicAlbum({ country: 'ar', id: '90201' }, false)).title, 'Public album'); assert.equal(calls, 3);
    calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('blocked by firewall'); };
    await assert.rejects(publicAlbum({ country: 'ar', id: '90202' }, false), error => error instanceof PublicMetadataError && error.kind === 'network');
    assert.equal(calls, 4);
  } finally { globalThis.fetch = original; }
});

test('Related y el pegado de enlaces sólo cierran el panel visible: el escondido espera a que Back vuelva a su página', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  for (const file of ['src/record-recommendations.ts', 'src/shared-links.ts', 'src/ui/music-shell.js']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /#el-music-label-panel \[data-close-labels\]/, file + ': cierre sin excluir el panel escondido');
  }
  assert.match(readFileSync('src/record-recommendations.ts', 'utf8'), /#el-music-label-panel:not\(\.el-music-panel--parked\) \[data-close-labels\]/);
  assert.match(readFileSync('src/shared-links.ts', 'utf8'), /#el-music-label-panel:not\(\.el-music-panel--parked\) \[data-close-labels\]/);
});
