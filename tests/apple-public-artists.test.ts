import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtistPage } from '../src/apple-public-artists';

const artistId = '853090', artist = 'Portishead', albumId = '1440653096', songId = '1440653206';
const artistUrl = `https://music.apple.com/ar/artist/portishead/${artistId}`;
const albumUrl = `https://music.apple.com/ar/album/dummy/${albumId}`;
const songUrl = `https://music.apple.com/ar/album/glory-box/${albumId}?i=${songId}`;
const descriptor = (kind: string, id: string, url: string) => ({ kind, identifiers: { storeAdamID: id }, url });
const image = 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/bb/90/f3/bb90f392-b78d-f180-ba6b-f04d2d1e62fd/s05.kfnyrece.jpg/{w}x{h}{c}.{f}';
function fixture(featured = false) {
  const related = { id: '254458', title: 'Tricky', contentDescriptor: descriptor('artist', '254458', 'https://music.apple.com/ar/artist/tricky/254458'),
    segue: { destination: { contentDescriptor: descriptor('artist', '254458', 'https://music.apple.com/ar/artist/tricky/254458') } } };
  const song = { id: songId, title: 'Glory Box', duration: 308627, contentDescriptor: descriptor('song', songId, songUrl),
    subtitleLinks: [{ title: 'Dummy\u202f·\u202f1994' }], artwork: { dictionary: { url: image } },
    playAction: { items: [{ contentDescriptor: descriptor('song', songId, songUrl) }] } };
  const sections: Record<string, any>[] = [ // Fixtures sintéticos mutables para los negativos de frontera.
    { id: `artists_${artistId}_default.marker.ArtistDetailHeader-ArtistDetailHeader`, itemKind: 'artistDetailHeader', items: [{ id: artistId, title: artist, contentDescriptor: descriptor('artist', artistId, artistUrl) }] },
    featured ? { id: `artists_${artistId}_default.marker.shelfgroup.FeaturedContent.TopSongs-ArtistFeaturedContentAndTracks`, itemKind: 'artistFeaturedContentAndTracks', items: [{ tracks: [song] }] } :
      { id: `artists_${artistId}_default.marker.TopSongs-TrackLockupSection`, itemKind: 'trackLockup', items: [song] },
    { id: `artists_${artistId}_default.marker.Albums-SquareLockupSection`, itemKind: 'squareLockup', items: [{ id: albumId, titleLinks: [{ title: 'Dummy' }], contentDescriptor: descriptor('album', albumId, albumUrl) }] },
    { id: `artists_${artistId}_default.marker.SimilarArtists-CircleLockupSection`, itemKind: 'bubbleLockup', items: [related] }
  ];
  const page = { intent: { $kind: 'ArtistDetailPageIntent', contentDescriptor: { ...descriptor('artist', artistId, artistUrl), locale: { storefront: 'ar' } } }, data: { canonicalURL: artistUrl, sections } };
  return { page, song, related, sections, html: () => `<script id="serialized-server-data">${JSON.stringify({ data: [page] })}</script>` };
}
const parse = (value: ReturnType<typeof fixture>) => parseArtistPage(value.html(), 'ar', artistId, artist);

test('both observed TopSongs variants resolve the exact album card and preserve public ranking', async t => {
  for (const featured of [false, true]) await t.test(featured ? 'featured content and tracks' : 'track lockup', () => {
    const value = fixture(featured), result = parse(value);
    assert.equal(result.canonical, artistUrl);
    assert.deepEqual(result.related, [{ id: '254458', name: 'Tricky', url: 'https://music.apple.com/ar/artist/tricky/254458' }]);
    assert.deepEqual(result.songs, [{ id: songId, albumId, artistId, artist, title: 'Glory Box', album: 'Dummy', durationMs: 308627,
      artworkUrl: image.replace('{w}', '100').replace('{h}', '100').replace('{c}', 'bb').replace('{f}', 'jpg') }]);
    assert.notEqual(result.songs[0].album, value.song.subtitleLinks[0].title);
  });
});

test('page identity, kind, full name, region, header and canonical are all authoritative', async t => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['intent kind', value => { value.page.intent.$kind = 'SongDetailPageIntent'; }],
    ['intent id', value => { value.page.intent.contentDescriptor.identifiers.storeAdamID = '999'; }],
    ['locale', value => { value.page.intent.contentDescriptor.locale.storefront = 'us'; }],
    ['canonical foreign region', value => { value.page.data.canonicalURL = artistUrl.replace('/ar/', '/us/'); }],
    ['canonical foreign host', value => { value.page.data.canonicalURL = artistUrl.replace('music.apple.com', 'example.com'); }],
    ['canonical query', value => { value.page.data.canonicalURL += '?x=1'; }],
    ['canonical other identity', value => { value.page.data.canonicalURL = artistUrl.replace(artistId, '999'); }],
    ['intent contradictory url', value => { value.page.intent.contentDescriptor.url = artistUrl.replace('/ar/', '/us/'); }],
    ['header artist id', value => { value.sections[0].items[0].id = '999'; }],
    ['header descriptor', value => { value.sections[0].items[0].contentDescriptor!.kind = 'album'; }],
    ['header full name', value => { value.sections[0].items[0].title = 'Portishead tribute'; }],
    ['header url', value => { value.sections[0].items[0].contentDescriptor!.url += '?x=1'; }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => { const value = fixture(); mutate(value); assert.throws(() => parse(value), /PUBLIC_ARTIST_METADATA_MISMATCH/); });
  assert.throws(() => parseArtistPage('<script>invalid</script>', 'ar', artistId, artist), /PUBLIC_ARTIST_DATA_INVALID/);
  assert.throws(() => parseArtistPage(fixture().html(), 'a.*', artistId, artist), /PUBLIC_ARTIST_METADATA_MISMATCH/);
  assert.throws(() => parseArtistPage(fixture().html(), 'ar', '1.*', artist), /PUBLIC_ARTIST_METADATA_MISMATCH/);
  assert.throws(() => parseArtistPage(fixture().html() + fixture().html(), 'ar', artistId, artist), /PUBLIC_ARTIST_DATA_INVALID/);
});

test('song cannot borrow an album title from subtitle, another ID, another region or contradictory cards', () => {
  const missing = fixture(); missing.sections.splice(2, 1); assert.deepEqual(parse(missing).songs, []);
  const wrong = fixture(); wrong.sections[2].items[0].contentDescriptor!.identifiers.storeAdamID = '999'; assert.deepEqual(parse(wrong).songs, []);
  const region = fixture(); region.sections[2].items[0].contentDescriptor!.url = albumUrl.replace('/ar/', '/us/'); assert.deepEqual(parse(region).songs, []);
  const duplicate = fixture(); const card = structuredClone(duplicate.sections[2].items[0]); card.titleLinks![0].title = 'Different album'; duplicate.sections[2].items.push(card);
  assert.deepEqual(parse(duplicate).songs, []);
});

test('song references reject mismatched ID, URL, duration, country and contradictory play action', async t => {
  const mutations: [string, (value: ReturnType<typeof fixture>) => void][] = [
    ['wrong row id', value => { value.song.id = '999'; }],
    ['wrong query id', value => { value.song.contentDescriptor.url = songUrl.replace(`i=${songId}`, 'i=999'); }],
    ['extra query', value => { value.song.contentDescriptor.url += '&x=1'; }],
    ['duplicate i', value => { value.song.contentDescriptor.url += `&i=${songId}`; }],
    ['foreign country', value => { value.song.contentDescriptor.url = songUrl.replace('/ar/', '/us/'); }],
    ['foreign host', value => { value.song.contentDescriptor.url = songUrl.replace('music.apple.com', 'example.com'); }],
    ['no duration', value => { value.song.duration = NaN; }],
    ['negative duration', value => { value.song.duration = -1; }],
    ['oversize duration', value => { value.song.duration = 86400001; }],
    ['wrong play id', value => { value.song.playAction.items[0].contentDescriptor.identifiers.storeAdamID = '999'; }],
    ['wrong play url', value => { value.song.playAction.items[0].contentDescriptor.url = songUrl.replace('/ar/', '/us/'); }]
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => { const value = fixture(); mutate(value); assert.deepEqual(parse(value).songs, []); });
});

test('unknown shelf variants do not become songs or related artists', () => {
  const value = fixture(); value.sections[1].itemKind = 'unknownTrackVariant'; value.sections[3].itemKind = 'unknownArtistVariant';
  assert.deepEqual(parse(value), { canonical: artistUrl, related: [], songs: [] });
});

test('contradictory related references and malformed artwork never become trusted output', () => {
  const value = fixture(); value.related.segue.destination.contentDescriptor.identifiers.storeAdamID = '999'; value.song.artwork.dictionary.url = image.replace('is1-ssl.mzstatic.com', 'example.com');
  assert.deepEqual(parse(value).related, []); assert.equal(parse(value).songs.length, 1); assert.equal(parse(value).songs[0].artworkUrl, undefined);
  const query = fixture(); query.song.artwork.dictionary.url += '?secret=bad'; assert.equal(parse(query).songs[0].artworkUrl, undefined);
});

test('duplicate contradictory songs and related artists are omitted without reordering remaining rows', () => {
  const value = fixture(); const contradictorySong = { ...structuredClone(value.song), title: 'Another title' };
  value.sections[1].items.push(contradictorySong);
  const contradictoryArtist = { ...structuredClone(value.related), title: 'Another artist' }; value.sections[3].items.push(contradictoryArtist);
  assert.deepEqual(parse(value).songs, []); assert.deepEqual(parse(value).related, []);
});
