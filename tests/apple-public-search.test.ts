import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchPage } from '../src/apple-public-search';

const artistId = '853090', songId = '1440653203', albumId = '1440653096';
const term = 'Portishead Roads', canonical = 'https://music.apple.com/ar/search?term=Portishead%20Roads';
const descriptor = (kind: string, id: string, url: string) => ({ kind, identifiers: { storeAdamID: id }, url });
function fixture() {
  const song = { id: `track-section - song - ${songId}`, title: 'Roads', duration: null, isDisabled: false,
    contentDescriptor: descriptor('song', songId, `https://music.apple.com/ar/album/roads/${albumId}?i=${songId}`),
    subtitleLinks: [{ title: 'Portishead', segue: { destination: { contentDescriptor: descriptor('artist', artistId, `https://music.apple.com/ar/artist/portishead/${artistId}`) } } }] };
  const album = { id: `square-section - album - ${albumId}`, titleLinks: [{ title: 'Dummy' }], contentDescriptor: descriptor('album', albumId, `https://music.apple.com/ar/album/dummy/${albumId}`) };
  const sections: Record<string, any>[] = [{ id: 'track-section - song', itemKind: 'trackLockup', items: [song] }, { id: 'square-section - album', itemKind: 'squareLockup', items: [album] }];
  const page = { intent: { $kind: 'SearchResultsPageIntent', inLibrary: false, term, storefront: 'ar' }, data: { canonicalURL: canonical, sections } };
  return { page, song, album, sections, html: () => `<script id="serialized-server-data">${JSON.stringify({ data: [page] })}</script>` };
}
const parse = (value: ReturnType<typeof fixture>) => parseSearchPage(value.html(), 'ar', term);
const airTerm = "Air La femme d'argent", airCanonical = "https://music.apple.com/ar/search?term=Air%20La%20femme%20d'argent";
function airFixture() {
  const value = fixture(); value.page.intent.term = airTerm; value.page.data.canonicalURL = airCanonical;
  value.song.id = 'track-section - song - 697240265'; value.song.title = "La femme d'argent";
  value.song.contentDescriptor = descriptor('song', '697240265', 'https://music.apple.com/ar/album/la-femme-dargent/697240234?i=697240265');
  value.song.subtitleLinks[0].title = 'Air'; value.song.subtitleLinks[0].segue.destination.contentDescriptor = descriptor('artist', '5641488', 'https://music.apple.com/ar/artist/air/5641488');
  value.album.id = 'square-section - album - 697240234'; value.album.titleLinks[0].title = 'Moon Safari';
  value.album.contentDescriptor = descriptor('album', '697240234', 'https://music.apple.com/ar/album/moon-safari/697240234');
  return value;
}
test('Air canonical accepts the observed literal apostrophe and equivalent WHATWG encoding without changing identity', () => {
  for (const canonicalURL of [airCanonical, airCanonical.replaceAll("'", '%27')]) {
    const value = airFixture(); value.page.data.canonicalURL = canonicalURL;
    const page = parseSearchPage(value.html(), 'ar', airTerm);
    assert.equal(page.canonical, airCanonical.replaceAll("'", '%27'));
    assert.deepEqual(page.songs, [{ id: '697240265', albumId: '697240234', artistId: '5641488', artist: 'Air', title: "La femme d'argent", album: 'Moon Safari', url: value.song.contentDescriptor.url }]);
  }
});
test('Air canonical still rejects double encoding, duplicate or wrong terms and foreign URL scope', async t => {
  const mutations = [
    airCanonical.replaceAll("'", '%2527'), airCanonical + '&term=' + encodeURIComponent(airTerm), airCanonical.replace('argent', 'other'),
    airCanonical.replace('/ar/', '/us/'), airCanonical.replace('music.apple.com', 'music.apple.com.evil.test'),
    airCanonical.replace('https://', 'https://person:secret@'), airCanonical.replace('music.apple.com', 'music.apple.com:443'),
    airCanonical.replace('/search', '/library/search'), airCanonical + '#fragment', airCanonical.replace('https:', 'http:'),
    airCanonical.replace('term=', "te'rm="), airCanonical.replace('/search', "/sea'rch"), airCanonical.replace('music.apple.com', "mus'ic.apple.com")
  ];
  for (const [index, canonicalURL] of mutations.entries()) await t.test(String(index), () => {
    const value = airFixture(); value.page.data.canonicalURL = canonicalURL;
    assert.throws(() => parseSearchPage(value.html(), 'ar', airTerm), /PUBLIC_SEARCH_METADATA_MISMATCH/);
  });
  const wrongIntent = airFixture(); wrongIntent.page.intent.term = airTerm.replace("'", '’');
  assert.throws(() => parseSearchPage(wrongIntent.html(), 'ar', airTerm), /PUBLIC_SEARCH_METADATA_MISMATCH/);
});
test('missing album card preserves only explicit IDs and credit for mandatory Lookup enrichment', () => {
  const value = fixture(); value.sections.pop();
  const rows = parse(value).songs;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, songId); assert.equal(rows[0].albumId, albumId); assert.equal(rows[0].album, undefined);
  const unnamed = fixture(); unnamed.album.titleLinks = [];
  assert.equal(parse(unnamed).songs[0]?.album, undefined); assert.equal(parse(unnamed).songs.length, 1);
});

test('public search returns explicit artist credit, exact album card and no invented duration', () => {
  const result = parse(fixture());
  assert.deepEqual(result, { canonical, songs: [{ id: songId, albumId, artistId, artist: 'Portishead', title: 'Roads', album: 'Dummy', url: `https://music.apple.com/ar/album/roads/${albumId}?i=${songId}` }] });
  assert.equal('durationMs' in result.songs[0], false);
});

test('search intent, term, storefront, library flag and exact canonical scope cannot be substituted', async t => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['kind', value => { value.page.intent.$kind = 'ArtistDetailPageIntent'; }],
    ['term', value => { value.page.intent.term = 'Other query'; }],
    ['country', value => { value.page.intent.storefront = 'us'; }],
    ['library', value => { value.page.intent.inLibrary = true; }],
    ['library flag missing', value => { Reflect.deleteProperty(value.page.intent, 'inLibrary'); }],
    ['canonical term', value => { value.page.data.canonicalURL = canonical.replace('Roads', 'Other'); }],
    ['canonical country', value => { value.page.data.canonicalURL = canonical.replace('/ar/', '/us/'); }],
    ['canonical host', value => { value.page.data.canonicalURL = canonical.replace('music.apple.com', 'example.com'); }],
    ['canonical extras', value => { value.page.data.canonicalURL += '&other=1'; }],
    ['canonical duplicate term', value => { value.page.data.canonicalURL += '&term=Portishead%20Roads'; }],
    ['canonical hash', value => { value.page.data.canonicalURL += '#other'; }],
    ['canonical library path', value => { value.page.data.canonicalURL = canonical.replace('/search', '/library/search'); }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => parse(value), /PUBLIC_SEARCH_METADATA_MISMATCH/); });
  assert.throws(() => parseSearchPage(fixture().html(), 'a.*', term), /PUBLIC_SEARCH_METADATA_MISMATCH/);
  assert.throws(() => parseSearchPage(fixture().html(), 'ar', 'different'), /PUBLIC_SEARCH_METADATA_MISMATCH/);
  assert.throws(() => parseSearchPage(fixture().html() + fixture().html(), 'ar', term), /PUBLIC_SEARCH_DATA_INVALID/);
});

test('foreign or contradictory song, artist and album identities are omitted', async t => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['row id', value => { value.song.id = 'track-section - song - 999'; }],
    ['song descriptor id', value => { value.song.contentDescriptor.identifiers.storeAdamID = '999'; }],
    ['song query id', value => { value.song.contentDescriptor.url = value.song.contentDescriptor.url.replace(`i=${songId}`, 'i=999'); }],
    ['song region', value => { value.song.contentDescriptor.url = value.song.contentDescriptor.url.replace('/ar/', '/us/'); }],
    ['song extra query', value => { value.song.contentDescriptor.url += '&foo=1'; }],
    ['disabled', value => { value.song.isDisabled = true; }],
    ['artist region', value => { value.song.subtitleLinks[0].segue.destination.contentDescriptor.url = `https://music.apple.com/us/artist/portishead/${artistId}`; }],
    ['artist id', value => { value.song.subtitleLinks[0].segue.destination.contentDescriptor.identifiers.storeAdamID = '999'; }],
    ['artist kind', value => { value.song.subtitleLinks[0].segue.destination.contentDescriptor.kind = 'album'; }],
    ['artist credit missing', value => { value.song.subtitleLinks = []; }],
    ['multiple artist credits', value => { value.song.subtitleLinks.push(structuredClone(value.song.subtitleLinks[0])); }],
    ['album card id', value => { value.album.contentDescriptor.identifiers.storeAdamID = '999'; }],
    ['album card region', value => { value.album.contentDescriptor.url = value.album.contentDescriptor.url.replace('/ar/', '/us/'); }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => { const value = fixture(); mutate(value); assert.deepEqual(parse(value).songs, []); });
});

test('a remastered title remains exact so a plain candidate cannot enter its ID into Lookup', () => {
  const value = fixture(); value.page.intent.term = 'Massive Attack Dissolved Girl'; value.page.data.canonicalURL = 'https://music.apple.com/ar/search?term=Massive%20Attack%20Dissolved%20Girl';
  value.song.id = 'track-section - song - 1428689001';
  value.song.contentDescriptor = descriptor('song', '1428689001', 'https://music.apple.com/ar/album/dissolved-girl-remastered-2018/1428684976?i=1428689001');
  value.song.title = 'Dissolved Girl (Remastered 2018)'; value.song.subtitleLinks[0].title = 'Massive Attack';
  value.song.subtitleLinks[0].segue.destination.contentDescriptor = descriptor('artist', '526404', 'https://music.apple.com/ar/artist/massive-attack/526404');
  value.album.id = 'square-section - album - 1428684976'; value.album.titleLinks[0].title = 'Mezzanine (Deluxe)';
  value.album.contentDescriptor = descriptor('album', '1428684976', 'https://music.apple.com/ar/album/mezzanine-deluxe/1428684976');
  const result = parseSearchPage(value.html(), 'ar', value.page.intent.term);
  assert.equal(result.songs[0].title, 'Dissolved Girl (Remastered 2018)');
  assert.deepEqual(result.songs.filter(song => song.title === 'Dissolved Girl' && song.artist === 'Massive Attack'), []);
});

test('unknown shelves and album labels without a matching card are not guessed', () => {
  const unknown = fixture(); unknown.sections[0].itemKind = 'unknownTracks'; assert.deepEqual(parse(unknown).songs, []);
  const missing = fixture(); missing.sections.pop(); assert.equal(parse(missing).songs[0]?.album, undefined); assert.equal(parse(missing).songs.length, 1);
  const wrong = fixture(); wrong.sections[1].id = 'square-section - playlist'; assert.equal(parse(wrong).songs[0]?.album, undefined); assert.equal(parse(wrong).songs.length, 1);
});

test('contradictory duplicate albums or songs cannot overwrite accepted identity', () => {
  const albums = fixture(); albums.sections[1].items.push({ ...structuredClone(albums.album), titleLinks: [{ title: 'Another album' }] }); assert.deepEqual(parse(albums).songs, []);
  const songs = fixture(); songs.sections[0].items.push({ ...structuredClone(songs.song), title: 'Other song' }); assert.deepEqual(parse(songs).songs, []);
});
