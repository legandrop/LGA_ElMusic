import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendations } from '../src/recommendations';
import { RecommendationResult } from '../src/recommendation-types';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

interface Song { id: string; albumId: string; artistId: string; title: string; artist: string; album: string; durationMs: number }
interface Artist { id: string; name: string }
const descriptor = (kind: string, id: string, url: string) => ({ kind, identifiers: { storeAdamID: id }, url });
const artistUrl = (country: string, id: string) => `https://music.apple.com/${country}/artist/public-artist/${id}`;
function artistHtml(artist: Artist, songs: Song[], related: Artist[], country = 'ar', featured = false): string {
  const canonical = artistUrl(country, artist.id), prefix = `artists_${artist.id}_default.marker.`;
  const tracks = songs.map(song => ({ id: song.id, title: song.title, duration: song.durationMs,
    contentDescriptor: { ...descriptor('song', song.id, `https://music.apple.com/${country}/album/public-album/${song.albumId}?i=${song.id}`), albumID: song.albumId, artistID: artist.id } }));
  const albums = [...new Map(songs.map(song => [song.albumId, song])).values()].map(song => ({ id: song.albumId, titleLinks: [{ title: song.album }],
    contentDescriptor: descriptor('album', song.albumId, `https://music.apple.com/${country}/album/public-album/${song.albumId}`) }));
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: 'ArtistDetailPageIntent', contentDescriptor: { ...descriptor('artist', artist.id, canonical), locale: { storefront: country } } },
    data: { canonicalURL: canonical, sections: [
      { id: prefix + 'ArtistDetailHeader-ArtistDetailHeader', itemKind: 'artistDetailHeader', items: [{ id: artist.id, title: artist.name, contentDescriptor: descriptor('artist', artist.id, canonical) }] },
      featured ? { id: prefix + 'shelfgroup.FeaturedContent.TopSongs-ArtistFeaturedContentAndTracks', itemKind: 'artistFeaturedContentAndTracks', items: [{ tracks }] } :
        { id: prefix + 'TopSongs-TrackLockupSection', itemKind: 'trackLockup', items: tracks },
      { id: prefix + 'Albums-SquareLockupSection', itemKind: 'squareLockup', items: albums },
      { id: prefix + 'SimilarArtists-CircleLockupSection', itemKind: 'bubbleLockup', items: related.map(value => ({ id: value.id, title: value.name,
        contentDescriptor: descriptor('artist', value.id, artistUrl(country, value.id)), segue: { destination: { contentDescriptor: descriptor('artist', value.id, artistUrl(country, value.id)) } } })) }
    ] }
  }] }) + '</script>';
}
function songHtml(song: Song, country = 'ar', changed: Record<string, unknown> = {}): string {
  const link = (kind: string, id: string, title: string, url: string) => ({ title, segue: { destination: { contentDescriptor: descriptor(kind, id, url) } } });
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: 'SongDetailPageIntent', contentDescriptor: { kind: 'song', identifiers: { storeAdamID: song.id }, locale: { storefront: country } } },
    data: { canonicalURL: `https://music.apple.com/${country}/song/public-song/${song.id}`, sections: [{ items: [{
      title: song.title, artists: song.artist, album: song.album,
      contentDescriptor: { kind: 'song', identifiers: { storeAdamID: song.id }, albumID: song.albumId },
      artistLinks: [link('artist', song.artistId, song.artist, artistUrl(country, song.artistId))],
      albumLinks: [link('album', song.albumId, song.album, `https://music.apple.com/${country}/album/public-album/${song.albumId}`)], ...changed
    }] }] }
  }] }) + '</script>';
}
function searchArtist(artist: Artist, country = 'ar'): Response {
  return Response.json({ resultCount: 1, results: [{ wrapperType: 'artist', artistType: 'Artist', artistId: Number(artist.id), artistName: artist.name, artistLinkUrl: artistUrl(country, artist.id) + '?uo=4' }] });
}

test('Apple public artist primary stays regional, progressive and bounded before legacy fallback', async t => {
  const original = globalThis.fetch; let clock = Date.now(), sequence = 0;
  t.mock.method(Date, 'now', () => clock);
  let handler: (url: URL, options?: RequestInit) => Response | Promise<Response> = () => { throw new Error('UNEXPECTED_PUBLIC_REQUEST'); };
  const calls: URL[] = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push(url); clock += 5000;
    assert.equal(options?.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); assert.ok(options.signal);
    return handler(url, options);
  };
  const fixture = (label: string, artistCount = 1, songCount = 1) => {
    const offset = ++sequence * 1000, seedArtist = { id: String(600000 + offset), name: 'Seed ' + label };
    const related = Array.from({ length: artistCount }, (_, index) => ({ id: String(600001 + offset + index), name: `Related ${label} ${index}` }));
    const songs = related.flatMap((artist, artistIndex) => Array.from({ length: songCount }, (_, index): Song => ({ id: String(700000 + offset + artistIndex * 10 + index),
      albumId: String(800000 + offset + artistIndex), artistId: artist.id, artist: artist.name, title: `Song ${label} ${artistIndex} ${index}`, album: `Album ${label} ${artistIndex}`, durationMs: 200000 })));
    calls.length = 0;
    handler = url => {
      const country = url.hostname === 'itunes.apple.com' ? url.searchParams.get('country')! : url.pathname.split('/')[1];
      if (url.hostname === 'itunes.apple.com') {
        assert.equal(url.searchParams.get('entity'), 'musicArtist'); assert.equal(url.searchParams.get('limit'), '25'); assert.equal(url.searchParams.get('term'), seedArtist.name);
        return searchArtist(seedArtist, country);
      }
      if (url.pathname.includes('/artist/')) {
        const id = url.pathname.split('/').at(-1)!;
        if (id === seedArtist.id) return new Response(artistHtml(seedArtist, [], related, country));
        const context = related.find(artist => artist.id === id); assert.ok(context);
        return new Response(artistHtml(context, songs.filter(song => song.artistId === context.id), [], country, related.indexOf(context) % 2 === 0));
      }
      const song = songs.find(value => url.pathname.endsWith('/' + value.id)); assert.ok(song);
      return new Response(songHtml(song, country));
    };
    return { seed: { title: 'Current ' + label, artist: seedArtist.name, album: '', country: 'ar' }, seedArtist, related, songs };
  };
  try {
    await t.test('one exact artist search yields at most24 songs, pool6, early verified results and independent regional caches', async () => {
      const value = fixture('progressive', 6, 5), base = handler;
      let release!: () => void, first!: (result: RecommendationResult) => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const progress = new Promise<RecommendationResult>(resolve => { first = resolve; });
      let activeSongs = 0, maximumSongs = 0, activeArtists = 0, maximumArtists = 0;
      handler = async (url, options) => {
        if (url.pathname.includes('/artist/') && !url.pathname.endsWith('/' + value.seedArtist.id)) {
          activeArtists++; maximumArtists = Math.max(maximumArtists, activeArtists); await new Promise(resolve => setTimeout(resolve, 5)); activeArtists--;
        }
        if (url.pathname.includes('/song/')) {
          activeSongs++; maximumSongs = Math.max(maximumSongs, activeSongs);
          try { if (!url.pathname.endsWith('/' + value.songs[0].id)) await gate; return await base(url, options); } finally { activeSongs--; }
        }
        return base(url, options);
      };
      const operation = recommendations(value.seed, 'artist', new AbortController().signal, result => { if (result.items.length) first(result); });
      try {
        const early = await progress; assert.ok(early.items.length > 0 && early.items.length < 24);
        assert.ok(early.cards?.some(card => card.verificationStatus !== 'verified'));
        assert.ok(early.items.every(item => item.source === 'Apple Music' && item.matchMethod === 'public-catalog' && item.artistId && item.artistUrl && item.albumId && item.albumUrl && !item.recordingIdentityVerified));
        release(); const result = await operation;
        assert.equal(result.items.length, 24); assert.equal(result.cards?.length, 24); assert.equal(result.partial, false);
        assert.ok(maximumSongs > 1 && maximumSongs <= 6); assert.ok(maximumArtists > 1 && maximumArtists <= 3);
        assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 1);
        assert.equal(calls.some(url => ['musicbrainz.org', 'ws.audioscrobbler.com', 'labs.api.listenbrainz.org'].includes(url.hostname)), false);
        result.items[0].title = 'Caller mutation'; const before = calls.length;
        const cached = await recommendations(value.seed, 'artist', new AbortController().signal);
        assert.notEqual(cached.items[0].title, 'Caller mutation'); assert.equal(calls.length, before);
        const regional = await recommendations({ ...value.seed, country: 'us' }, 'artist', new AbortController().signal);
        assert.equal(regional.items.length, 24); assert.ok(regional.items.every(item => item.url.startsWith('https://music.apple.com/us/')));
        assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 2);
      } finally { release(); await operation.catch(() => {}); }
    });
    await t.test('ambiguous or truncated artist searches and foreign references reach no Apple page', async () => {
      for (const invalid of ['homonym', 'truncated', 'country', 'tracking']) {
        const value = fixture(invalid), base = handler; let fallback = 0;
        handler = async (url, options) => {
          if (url.hostname === 'musicbrainz.org') { fallback++; return Response.json({ count: 0, recordings: [], artists: [] }); }
          if (url.hostname === 'itunes.apple.com') {
            const data = await searchArtist(value.seedArtist).json();
            if (invalid === 'homonym') { data.results.push({ ...data.results[0], artistId: Number(value.seedArtist.id) + 100, artistLinkUrl: artistUrl('ar', String(Number(value.seedArtist.id) + 100)) }); data.resultCount = 2; }
            if (invalid === 'truncated') { data.results = Array.from({ length: 25 }, () => data.results[0]); data.resultCount = 25; }
            if (invalid === 'country') data.results[0].artistLinkUrl = artistUrl('us', value.seedArtist.id);
            if (invalid === 'tracking') data.results[0].artistLinkUrl += '&unknown=1';
            return Response.json(data);
          }
          return base(url, options);
        };
        const result = await recommendations(value.seed, 'artist', new AbortController().signal);
        assert.equal(result.items.length, 0); assert.ok(fallback > 0); assert.equal(calls.some(url => url.hostname === 'music.apple.com'), false);
      }
    });
    await t.test('SongDetail must corroborate contextual artistID, country, title and album before any result is published', async () => {
      for (const invalid of ['artistId', 'country', 'title', 'album']) {
        const value = fixture('song-' + invalid), base = handler; let published = 0, fallback = 0;
        handler = (url, options) => {
          if (url.hostname === 'musicbrainz.org') { fallback++; return Response.json({ count: 0, recordings: [], artists: [] }); }
          if (url.pathname.includes('/song/')) {
            const song = value.songs[0];
            if (invalid === 'artistId') return new Response(songHtml(song, 'ar', { artistLinks: [{ title: song.artist, segue: { destination: { contentDescriptor: descriptor('artist', '999999', artistUrl('ar', '999999')) } } }] }));
            return new Response(songHtml(song, invalid === 'country' ? 'us' : 'ar', invalid === 'title' ? { title: song.title + ' (Live)' } : invalid === 'album' ? { album: 'Another album' } : {}));
          }
          return base(url, options);
        };
        const result = await recommendations(value.seed, 'artist', new AbortController().signal, snapshot => { published++; assert.equal(snapshot.cards?.some(card => card.source === 'Apple Music'), false); });
        assert.equal(result.items.length, 0); assert.ok(fallback > 0); assert.ok(published > 0);
        assert.equal(result.cards?.some(card => card.source === 'Apple Music'), false);
      }
    });
    await t.test('external cancellation stops every Apple request and never starts legacy providers', async () => {
      const value = fixture('cancel'), base = handler, controller = new AbortController(); let started!: () => void, active = 0;
      const ready = new Promise<void>(resolve => { started = resolve; }); let published = 0;
      handler = (url, options) => {
        if (url.pathname.includes('/song/')) return new Promise((_resolve, reject) => {
          active++; started(); options!.signal!.addEventListener('abort', () => { active--; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
        });
        return base(url, options);
      };
      const operation = recommendations(value.seed, 'artist', controller.signal, () => { published++; }, 'a'.repeat(32));
      await ready; controller.abort(); await assert.rejects(operation, { name: 'AbortError' });
      assert.equal(active, 0); assert.equal(published, 0); assert.equal(calls.some(url => ['musicbrainz.org', 'ws.audioscrobbler.com'].includes(url.hostname)), false);
    });
    await t.test('deadline discards an empty primary before fallback and returns partial results without late callbacks when one song is verified', async () => {
      for (const partial of [false, true]) {
        const value = fixture('deadline-' + partial, 1, 3), base = handler; let active = 0, fallback = 0, published = 0;
        handler = (url, options) => {
          if (url.hostname === 'musicbrainz.org') { assert.equal(active, 0); fallback++; return Response.json({ count: 0, recordings: [], artists: [] }); }
          if (url.pathname.includes('/song/') && (!partial || !url.pathname.endsWith('/' + value.songs[0].id))) return new Promise((_resolve, reject) => {
            active++; options!.signal!.addEventListener('abort', () => { active--; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
          });
          return base(url, options);
        };
        const result = await recommendations(value.seed, 'artist', new AbortController().signal, snapshot => {
          published++; assert.ok(!partial || snapshot.items.every(item => item.source === 'Apple Music'));
          if (!partial) assert.equal(snapshot.cards?.some(card => card.source === 'Apple Music'), false);
        });
        const completed = published; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(published, completed); assert.equal(active, 0);
        if (partial) {
          assert.equal(result.items.length, 1); assert.equal(result.partial, true); assert.equal(result.unresolved, 2); assert.equal(fallback, 0);
          assert.equal(result.cards?.filter(card => card.verificationStatus === 'unavailable').length, 2);
        } else { assert.equal(result.items.length, 0); assert.ok(fallback > 0); assert.equal(result.cards?.some(card => card.source === 'Apple Music'), false); }
      }
    });
    await t.test('concurrent artist seed lookups keep the shared real iTunes interval', async () => {
      clock += 1000000;
      const prior = globalThis.fetch, starts: number[] = [];
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.hostname === 'itunes.apple.com') {
          starts.push(performance.now()); assert.equal(url.searchParams.get('entity'), 'musicArtist');
          return Response.json({ resultCount: 0, results: [] });
        }
        assert.equal(url.hostname, 'musicbrainz.org'); return Response.json({ count: 0, recordings: [], artists: [] });
      };
      try {
        await Promise.all(['first', 'second'].map(name => recommendations({ title: 'Quota ' + name, artist: 'Quota artist ' + name, album: '', country: 'ar' }, 'artist', new AbortController().signal)));
        assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 3090);
      } finally { globalThis.fetch = prior; }
    });
  } finally { globalThis.fetch = original; }
});
