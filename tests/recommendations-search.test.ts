import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendations } from '../src/recommendations';
import { RecommendationMatchDiagnostic, RecommendationResult } from '../src/recommendation-types';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

interface Song { id: string; albumId: string; artistId: string; title: string; artist: string; album: string; durationMs: number; mbid: string }
const seedMbid = '11111111-aaaa-aaaa-aaaa-111111111111';
const songs = (prefix: number, count: number): Song[] => Array.from({ length: count }, (_, index) => ({ id: String(prefix + index), albumId: String(prefix + 1000 + index),
  artistId: String(prefix + 2000 + index), title: `SSR song ${prefix} ${index}`, artist: `SSR artist ${prefix} ${index}`, album: `SSR album ${prefix} ${index}`,
  durationMs: 200000, mbid: `22222222-bbbb-bbbb-bbbb-${String(prefix + index).padStart(12, '0')}` }));
const descriptor = (kind: string, id: string, url?: string) => ({ kind, identifiers: { storeAdamID: id }, ...(url ? { url } : {}) });
function searchHtml(values: Song[], country: string, term: string, missingAlbums = false): string {
  const albums = [...new Map(values.map(song => [song.albumId, { id: `square-section - album - ${song.albumId}`,
    titleLinks: [{ title: song.album }], contentDescriptor: descriptor('album', song.albumId, `https://music.apple.com/${country}/album/${song.albumId}`) }])).values()];
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{ intent: { $kind: 'SearchResultsPageIntent', inLibrary: false, term, storefront: country },
    data: { canonicalURL: `https://music.apple.com/${country}/search?${new URLSearchParams({ term })}`, sections: [
      { id: 'track-section - song', itemKind: 'trackLockup', items: values.map(song => ({ id: `track-section - song - ${song.id}`, title: song.title, duration: null, isDisabled: false,
        contentDescriptor: { ...descriptor('song', song.id, `https://music.apple.com/${country}/album/${song.albumId}?i=${song.id}`), albumID: song.albumId, artistID: song.artistId },
        subtitleLinks: [{ title: song.artist, segue: { destination: { contentDescriptor: descriptor('artist', song.artistId, `https://music.apple.com/${country}/artist/${song.artistId}`) } } }] })) },
      { id: 'square-section - album', itemKind: 'squareLockup', items: missingAlbums ? [] : albums }
    ] } }] }) + '</script>';
}
function songHtml(song: Song, country: string, artistId = song.artistId): string {
  const link = (kind: string, id: string, title: string) => ({ title, segue: { destination: { contentDescriptor: descriptor(kind, id, `https://music.apple.com/${country}/${kind}/${id}`) } } });
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{ intent: { $kind: 'SongDetailPageIntent', contentDescriptor: { ...descriptor('song', song.id), locale: { storefront: country } } },
    data: { canonicalURL: `https://music.apple.com/${country}/song/${song.id}`, sections: [{ items: [{ title: song.title, artists: song.artist, album: song.album,
      contentDescriptor: { ...descriptor('song', song.id), albumID: song.albumId }, artistLinks: [link('artist', artistId, song.artist)], albumLinks: [link('album', song.albumId, song.album)] }] }] }
  }] }) + '</script>';
}
function itunesJson(values: Song[], country: string): Response {
  return Response.json({ resultCount: values.length, results: values.map(song => ({ kind: 'song', wrapperType: 'track', trackId: Number(song.id), collectionId: Number(song.albumId), artistId: Number(song.artistId),
    trackName: song.title, artistName: song.artist, collectionName: song.album, trackTimeMillis: song.durationMs, isStreamable: true, country: country === 'ar' ? 'ARG' : 'USA' })) });
}
function gate(): { promise: Promise<void>; release: () => void } { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function waitFor(operation: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function blocked(until: Promise<void>, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException('Synthetic cancellation', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void until.then(resolve).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

test('public Search resolves exact regional candidates in parallel before legacy Search fallback', async t => {
  const original = globalThis.fetch; let clock = Date.now(), realQuota = false;
  t.mock.method(Date, 'now', () => clock);
  let values: Song[] = [], country = 'ar', title = '', handler: (url: URL, options: RequestInit) => Promise<Response>;
  const calls: URL[] = [];
  const start = (name: string, list: Song[], region = 'ar', progress?: (result: RecommendationResult) => void, warm = false) => {
    title = name; values = list; country = region; calls.length = 0; if (!warm) clock += 1000000;
    const controller = new AbortController();
    return { controller, operation: recommendations({ title, artist: 'SSR seed artist', album: '', country }, 'track', controller.signal, progress) };
  };
  const base = async (url: URL): Promise<Response> => {
    if (url.hostname === 'musicbrainz.org') {
      const duration = url.searchParams.get('query')?.startsWith('rid:');
      return Response.json({ count: duration ? values.length : 1, recordings: (duration ? values : [{ mbid: seedMbid, title, artist: 'SSR seed artist', album: '', durationMs: 200000 }]).map(song => ({ id: song.mbid,
        title: song.title, length: song.durationMs, 'artist-credit': [{ name: song.artist, artist: { id: '33333333-cccc-cccc-cccc-333333333333', name: song.artist }, joinphrase: '' }], releases: [{ title: song.album }] })) });
    }
    if (url.hostname === 'labs.api.listenbrainz.org') {
      if (url.pathname === '/apple-music-id-from-metadata/json') return Response.json([]);
      return Response.json(values.map(song => ({ reference_mbid: seedMbid, recording_mbid: song.mbid, recording_name: song.title, artist_credit_name: song.artist, release_name: song.album })));
    }
    if (url.hostname === 'itunes.apple.com') return itunesJson(url.pathname === '/lookup' ? values.filter(song => url.searchParams.get('id')!.split(',').includes(song.id)) : [], country);
    const song = values.find(song => url.pathname.endsWith('/' + song.id)); assert.ok(song); return new Response(songHtml(song, country));
  };
  globalThis.fetch = async (input, options) => { if (!realQuota) clock += 4000; const url = new URL(String(input)); calls.push(url); return handler(url, options!); };
  try {
    await t.test('normal Last.fm validates early while optional MB stays pending and late hydration cannot replace the chosen song', async () => {
      for (const cancel of [false, true]) {
        const list = songs(cancel ? 997000 : 996000, 1); list[0].durationMs = 270066;
        const catalog = { ...list[0], durationMs: 298373 }, durationGate = gate(), firstPlay = gate();
        const diagnostics: RecommendationMatchDiagnostic[] = []; let durationReleased = false, late = 0;
        values = list; country = 'ar'; title = 'Early LF catalog ' + cancel; calls.length = 0; clock += 1000000;
        handler = async (url, options) => {
          if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: catalog.title, artist: { name: catalog.artist }, mbid: catalog.mbid }] } });
          if (url.hostname === 'musicbrainz.org' && url.searchParams.get('query')?.startsWith('rid:')) { await blocked(durationGate.promise, options.signal!); durationReleased = true; }
          else if (url.hostname === 'musicbrainz.org') return Response.json({ recordings: [], artists: [], count: 0 });
          if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml([catalog], country, url.searchParams.get('term')!));
          if (url.hostname === 'itunes.apple.com') return itunesJson([catalog], country);
          if (url.hostname === 'music.apple.com') return new Response(songHtml(catalog, country));
          return base(url);
        };
        const controller = new AbortController();
        const operation = recommendations({ title, artist: 'SSR seed artist', album: '', country }, 'track', controller.signal, progress => {
          if (controller.signal.aborted) late++;
          if (progress.items.length) { assert.equal(progress.items[0].id, catalog.id); firstPlay.release(); }
        }, 'a'.repeat(32), undefined, event => { if (controller.signal.aborted) late++; diagnostics.push(event); });
        try {
          await waitFor(firstPlay.promise, 'NORMAL_CATALOG_WAITED_FOR_MB');
          assert.equal(durationReleased, false); assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].durationSource, 0); assert.equal(diagnostics[0].selectionPolicy, 1);
          if (cancel) { controller.abort(); await assert.rejects(operation, { name: 'AbortError' }); }
          else { durationGate.release(); const result = await operation; assert.equal(result.items[0].id, catalog.id); assert.equal(durationReleased, true); }
          await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(diagnostics.length, 1); assert.equal(late, 0);
        } finally { controller.abort(); durationGate.release(); await operation.catch(() => {}); }
      }
    });
    await t.test('Last.fm catalog preserves scoped SSR order despite reversed Lookup rows and staggered search completion', async () => {
      for (const reverseDelay of [false, true]) {
        const list = songs(reverseDelay ? 985000 : 980000, 2);
        list[0].durationMs = 270066; list[1].durationMs = 344000;
        const catalog = [
          { ...list[0], durationMs: 298373 }, { ...list[0], id: String(Number(list[0].id) + 100), albumId: String(Number(list[0].albumId) + 100), album: list[0].album + ' (Deluxe Edition)', durationMs: 300533 },
          { ...list[1], durationMs: 347280 }, { ...list[1], id: String(Number(list[1].id) - 100), albumId: String(Number(list[1].albumId) + 200), album: 'Other plain album', durationMs: 350000 }
        ];
        const live = { ...catalog[0], id: String(Number(catalog[0].id) + 300), albumId: String(Number(catalog[0].albumId) + 300), album: 'Roseland, NYC Live' };
        values = list; country = 'ar'; title = 'Normal LF public order ' + reverseDelay; calls.length = 0; clock += 1000000;
        handler = async url => {
          if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: list.map(song => ({ name: song.title, artist: { name: song.artist }, mbid: song.mbid })) } });
          if (url.hostname === 'musicbrainz.org' && !url.searchParams.get('query')?.startsWith('rid:')) return Response.json({ recordings: [], artists: [], count: 0 });
          if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
            const term = url.searchParams.get('term')!;
            if (term.includes(list[reverseDelay ? 0 : 1].title)) await new Promise(resolve => setTimeout(resolve, 20));
            const matching = catalog.filter(song => `${song.artist} ${song.title}` === term);
            return new Response(searchHtml(term.includes(list[0].title) ? [live, ...matching] : matching, country, term));
          }
          if (url.hostname === 'itunes.apple.com' && url.pathname === '/lookup') return itunesJson([...catalog, live].filter(song => url.searchParams.get('id')!.split(',').includes(song.id)).reverse(), country);
          if (url.hostname === 'music.apple.com') { const song = catalog.find(row => url.pathname.endsWith('/' + row.id)); assert.ok(song); return new Response(songHtml(song, country)); }
          return base(url);
        };
        const diagnostics: RecommendationMatchDiagnostic[] = [];
        const result = await recommendations({ title, artist: 'SSR seed artist', album: '', country }, 'track', new AbortController().signal, undefined, '9'.repeat(32), undefined, event => diagnostics.push(event));
        assert.deepEqual(result.items.map(song => song.id), list.map(song => song.id));
        assert.ok(result.items.every(song => song.matchMethod === 'public-catalog' && !song.recordingIdentityVerified));
        assert.ok(diagnostics.every(event => event.status === 2 && event.selectionPolicy === 1 && event.durationSource === 1 && event.durationRowCount === 0));
        assert.equal(diagnostics.length, 2); assert.ok(!result.items.some(song => song.id === live.id));
        assert.ok(!calls.some(url => url.hostname === 'itunes.apple.com' && url.pathname === '/search'));
      }
    });
    await t.test('six public catalog observations replay through MB hydration, SSR, Lookup and SongDetail without live substitutions', async () => {
      // DTOs públicos observados el 14/10/2026; estos MBIDs de prueba no se atribuyen al candidato Last.fm actual ni acreditan audio.
      const list: Song[] = [
        { id: '1440653203', albumId: '1440653096', artistId: '853090', title: 'Roads', artist: 'Portishead', album: 'Dummy', durationMs: 305173, mbid: '8a49dba0-253a-4535-b87f-78bb035336ce' },
        { id: '1660486423', albumId: '1660485817', artistId: '133086', title: 'Midnight In a Perfect World', artist: 'DJ Shadow', album: 'Endtroducing.....', durationMs: 300053, mbid: '3f02f615-80d3-48cb-9a8f-4f892c9a1f1c' },
        { id: '39280557', albumId: '39280545', artistId: '161916', title: 'The Sea', artist: 'Morcheeba', album: 'Big Calm', durationMs: 348000, mbid: '2d98788d-b10b-40d6-8c9d-2bf9f0979378' },
        { id: '1726639440', albumId: '1726639434', artistId: '2737549', title: '6 Underground', artist: 'Sneaker Pimps', album: 'Becoming X', durationMs: 229000, mbid: '870fd0ab-b99d-486c-8139-7b7b2afe8040' },
        { id: '1436695385', albumId: '1436695379', artistId: '789023', title: 'Porcelain', artist: 'Moby', album: 'Play', durationMs: 241133, mbid: 'bc0d9b99-6743-4401-ab60-f8499f5e7ff0' },
        { id: '1435646607', albumId: '1435646598', artistId: '20135455', title: 'Lovely Head', artist: 'Goldfrapp', album: 'Felt Mountain', durationMs: 227706, mbid: 'c5f48ccd-694a-435b-9c4c-bb707f87666f' }
      ];
      const catalog = [
        { ...list[0], durationMs: 303973 }, { ...list[0], id: '1440913668', albumId: '1440913466', album: 'Roseland, NYC Live', durationMs: 350307 },
        { ...list[0], id: '1870933906', albumId: '1870933738', album: 'LA GRAZIA dal film di Sorrentino', durationMs: 303973 },
        { ...list[1], durationMs: 298373 }, { ...list[1], id: '1660367636', albumId: '1660367299', album: 'Endtroducing (Deluxe Edition)', durationMs: 300533 },
        { ...list[2], durationMs: 347280 }, { ...list[2], id: '179369706', albumId: '179367769', album: 'Morcheeba: The Platinum Collection', durationMs: 347280 },
        { ...list[3], durationMs: 228840 }, { ...list[3], id: '1765700282', albumId: '1765700280', album: '6 Underground (Maxi Single) - EP', durationMs: 251267 },
        { ...list[4], durationMs: 241160 }, { ...list[4], id: '1765706153', albumId: '1765705950', album: 'Porcelain - Single', durationMs: 241160 },
        { ...list[4], id: '1747764270', albumId: '1747763938', album: 'Play: The Complete Recordings', durationMs: 241160 },
        { ...list[5], durationMs: 229827 }, { ...list[5], id: '1439114836', albumId: '1439114834', album: 'Lovely Head - Single', durationMs: 229693 },
        { ...list[5], id: '1436134743', albumId: '1436134736', album: 'The Singles', durationMs: 227707 },
        { ...list[5], id: '1435650635', albumId: '1435650628', album: 'iTunes Originals: Goldfrapp', durationMs: 225840 }
      ];
      handler = async url => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
          const term = url.searchParams.get('term')!;
          return new Response(searchHtml(catalog.filter(song => `${song.artist} ${song.title}` === term), country, term, term.startsWith('DJ Shadow ')));
        }
        if (url.pathname === '/lookup') return itunesJson(catalog.filter(song => url.searchParams.get('id')!.split(',').includes(song.id)), country);
        if (url.hostname === 'music.apple.com') { const song = catalog.find(song => url.pathname.endsWith('/' + song.id)); assert.ok(song); return new Response(songHtml(song, country)); }
        return base(url);
      };
      const result = await start('SSR six observed songs', list).operation;
      assert.deepEqual(result.items.map(item => item.id), ['1440653203', '1660367636', '39280557', '1726639440', '1436695385', '1436134743']);
      assert.ok(result.items.every(item => item.recordingIdentityVerified === false && item.albumUrl && item.artistId));
      assert.equal(calls.some(url => url.hostname === 'music.apple.com' && url.pathname.endsWith('/1440913668')), false);
    });
    await t.test('an early missing SSR cannot consume iTunes quota before good lookups or delay early Play until the whole roster finishes', async () => {
      const list = songs(1100000, 12), late = gate(), apple = gate(), six = gate(), first = gate();
      let activeSearch = 0, peakSearch = 0, activeApple = 0, peakApple = 0, pages = 0, previews = false;
      const lookedUp: string[] = [];
      handler = async (url, options) => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
          activeSearch++; peakSearch = Math.max(peakSearch, activeSearch);
          try {
            const index = list.findIndex(song => `${song.artist} ${song.title}` === url.searchParams.get('term')); assert.ok(index >= 0);
            if (index === 11) await blocked(late.promise, options.signal!);
            const song = list[index];
            const rows = index === 0 ? [{ ...song, id: '9900001', title: song.title + ' (Remastered)' }] : [song,
              { ...song, id: String(9900100 + index), artist: 'Different artist' }, { ...song, id: String(9900200 + index), albumId: String(9900300 + index), album: 'Different album (Live)' }];
            return new Response(searchHtml(rows, country, url.searchParams.get('term')!));
          } finally { activeSearch--; }
        }
        if (url.pathname === '/lookup') {
          assert.equal(previews, true); lookedUp.push(...url.searchParams.get('id')!.split(','));
          assert.equal(calls.some(call => call.hostname === 'itunes.apple.com' && call.pathname === '/search'), false);
          return base(url);
        }
        if (url.hostname === 'music.apple.com') {
          activeApple++; peakApple = Math.max(peakApple, activeApple); if (activeApple === 6) six.release();
          try { await blocked(apple.promise, options.signal!); pages++; return await base(url); } finally { activeApple--; }
        }
        return base(url);
      };
      const run = start('SSR progressive seed', list, 'ar', value => { previews ||= value.cards?.length === 12 && value.items.length === 0; if (value.items.length) first.release(); });
      try {
        await waitFor(six.promise, 'SSR_DID_NOT_REACH_SIX_VALIDATIONS'); assert.equal(peakApple, 6); assert.ok(peakSearch <= 3); apple.release(); await waitFor(first.promise, 'SSR_DID_NOT_PUBLISH_EARLY');
        assert.ok(pages > 0); assert.equal(activeSearch, 1);
        assert.ok(lookedUp.every(id => list.slice(1, 11).some(song => song.id === id)));
        assert.equal(calls.some(call => call.hostname === 'itunes.apple.com' && call.pathname === '/search'), false);
        late.release(); const result = await run.operation;
        assert.equal(result.items.length, 11); assert.equal(result.cards?.length, 12); assert.equal(result.items[0].id, list[1].id);
        assert.equal(peakApple, 6); assert.equal(activeApple, 0); assert.equal(activeSearch, 0);
        assert.ok(result.items.every(item => item.artistId && item.artistUrl?.startsWith('https://music.apple.com/ar/artist/')));
      } finally { run.controller.abort(); late.release(); apple.release(); await run.operation.catch(() => {}); }
    });
    await t.test('regional caches clone successful metadata and US never reuses AR rows', async () => {
      const list = songs(1200000, 2);
      handler = async url => url.hostname === 'music.apple.com' && url.pathname.endsWith('/search') ? new Response(searchHtml(list, country, url.searchParams.get('term')!)) : base(url);
      const first = await start('SSR cache first', list).operation; assert.equal(first.items.length, 2); first.items[0].title = 'Caller mutation';
      const cached = await start('SSR cache second', list, 'ar', undefined, true).operation;
      assert.equal(cached.items[0].title, list[0].title); assert.equal(calls.some(url => url.pathname.endsWith('/search') || url.pathname === '/lookup'), false);
      const regional = await start('SSR cache US', list, 'us', undefined, true).operation;
      assert.equal(regional.items.length, 2); assert.ok(regional.items.every(item => item.url.startsWith('https://music.apple.com/us/')));
      assert.ok(calls.some(url => url.pathname === '/us/search')); assert.ok(calls.some(url => url.pathname === '/lookup' && url.searchParams.get('country') === 'us'));
    });
    await t.test('lookup and SongDetail never publish foreign identities, versions, durations or artist IDs', async () => {
      for (const invalid of ['id', 'country', 'streamable', 'title', 'duration', 'artist-id', 'page-country', 'ambiguous'] as const) {
        const list = songs(1300000 + 100 * ['id', 'country', 'streamable', 'title', 'duration', 'artist-id', 'page-country', 'ambiguous'].indexOf(invalid), 1);
        const alternate = { ...list[0], id: String(Number(list[0].id) + 10), durationMs: 201500 };
        handler = async url => {
          if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml(invalid === 'ambiguous' ? [...list, alternate] : list, country, url.searchParams.get('term')!));
          if (url.pathname === '/lookup') {
            const data = await itunesJson(invalid === 'ambiguous' ? [{ ...list[0], durationMs: 199000 }, alternate] : list, country).json();
            for (const row of data.results) {
              if (invalid === 'id') row.trackId = 9999999;
              if (invalid === 'country') row.country = 'USA';
              if (invalid === 'streamable') row.isStreamable = false;
              if (invalid === 'title') row.trackName += ' (Remastered)';
              if (invalid === 'duration') row.trackTimeMillis += 5000;
            }
            return Response.json(data);
          }
          if (url.hostname === 'music.apple.com') return new Response(songHtml(list[0], invalid === 'page-country' ? 'us' : country, invalid === 'artist-id' ? '9999999' : list[0].artistId));
          return base(url);
        };
        const result = await start('SSR invalid ' + invalid, list).operation; assert.equal(result.items.length, 0, invalid);
        assert.equal(calls.some(url => url.hostname === 'music.apple.com' && /\/song\//.test(url.pathname)), ['artist-id', 'page-country'].includes(invalid), invalid);
      }
    });
    await t.test('missing SSR album metadata is enriched only through strict Lookup and the exact SongDetail', async () => {
      for (const invalid of ['none', 'lookup', 'page'] as const) {
        const list = songs(2300000 + ['none', 'lookup', 'page'].indexOf(invalid), 1); let lookups = 0;
        handler = async url => {
          if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml(list, country, url.searchParams.get('term')!, true));
          if (url.pathname === '/lookup') { lookups++; const data = await itunesJson(list, country).json(); if (invalid === 'lookup') data.results[0].isStreamable = false; return Response.json(data); }
          if (url.hostname === 'music.apple.com') return new Response(songHtml(invalid === 'page' ? { ...list[0], album: 'Different album' } : list[0], country));
          return base(url);
        };
        const result = await start('SSR enrich ' + invalid, list).operation;
        assert.equal(lookups, 1); assert.equal(result.items.length, invalid === 'none' ? 1 : 0);
        if (invalid === 'none') { assert.equal(result.items[0].album, list[0].album); assert.ok(result.items[0].albumUrl?.endsWith('/' + list[0].albumId)); }
      }
    });
    await t.test('legacy Search cache never substitutes for strict Lookup but a successful Lookup is reusable', async () => {
      const list = songs(2100000, 1); let legacy = true;
      handler = async url => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(legacy ? '' : searchHtml(list, country, url.searchParams.get('term')!));
        if (url.hostname === 'itunes.apple.com' && url.pathname === '/search') {
          const data = await itunesJson(list, country).json(); delete data.results[0].isStreamable; data.results[0].country = 'USA'; return Response.json(data);
        }
        return base(url);
      };
      assert.equal((await start('SSR legacy cached first', list).operation).items.length, 1);
      legacy = false;
      assert.equal((await start('SSR legacy cached next', list, 'ar', undefined, true).operation).items.length, 1);
      assert.equal(calls.filter(url => url.pathname === '/lookup').length, 1);
      assert.equal((await start('SSR strict cached next', list, 'ar', undefined, true).operation).items.length, 1);
      assert.equal(calls.some(url => url.pathname === '/lookup'), false);
    });
    await t.test('optional Labs does not repeat IDs already attempted by the SSR Lookup', async () => {
      const list = songs(2200000, 2); const ids: string[] = [];
      handler = async (url, options) => {
        if (url.pathname === '/apple-music-id-from-metadata/json') return Response.json(JSON.parse(String(options.body)).map((item: Record<string, unknown>) => ({ ...item,
          apple_music_track_ids: [list.find(song => song.title === item.track_name)!.id] })));
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml(list, country, url.searchParams.get('term')!));
        if (url.pathname === '/lookup') { ids.push(...url.searchParams.get('id')!.split(',')); return itunesJson(list.map(song => ({ ...song, durationMs: 205000 })), country); }
        return base(url);
      };
      const result = await start('SSR duplicate lookup', list).operation;
      assert.equal(result.items.length, 0); assert.deepEqual(ids.sort(), list.map(song => song.id).sort());
      assert.ok(calls.some(url => url.hostname === 'itunes.apple.com' && url.pathname === '/search'));
    });
    await t.test('the run submits at most 200 distinct IDs even when 48 searches return many exact editions', async () => {
      const list = songs(1400000, 48), editions = list.flatMap((song, index) => Array.from({ length: 6 }, (_, edition) => ({ ...song, id: String(1500000 + index * 6 + edition) })));
      const batches: string[][] = [];
      handler = async url => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml(editions.filter(song => `${song.artist} ${song.title}` === url.searchParams.get('term')), country, url.searchParams.get('term')!));
        if (url.pathname === '/lookup') { const ids = url.searchParams.get('id')!.split(','); batches.push(ids); return itunesJson(editions.filter(song => ids.includes(song.id)), country); }
        if (url.hostname === 'music.apple.com') { const song = editions.find(song => url.pathname.endsWith('/' + song.id)); assert.ok(song); return new Response(songHtml(song, country)); }
        return base(url);
      };
      const result = await start('SSR 200 cap', list).operation;
      assert.equal(result.cards?.length, 48); assert.equal(result.items.length, 32);
      assert.ok(batches.every(batch => batch.length <= 200)); assert.equal(new Set(batches.flat()).size, 200); assert.equal(batches.flat().length, 200);
    });
    await t.test('cancellation drains all three searches and suppresses queued work and late progress', async () => {
      const list = songs(1600000, 12), started = gate(), hold = gate(); let active = 0, count = 0, snapshots = 0;
      handler = async (url, options) => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
          active++; count++; if (active === 3) started.release();
          try { await blocked(hold.promise, options.signal!); return new Response(searchHtml([], country, url.searchParams.get('term')!)); } finally { active--; }
        }
        return base(url);
      };
      const run = start('SSR cancel', list, 'ar', () => { snapshots++; });
      try {
        await waitFor(started.promise, 'SSR_POOL_DID_NOT_START'); run.controller.abort(); await assert.rejects(run.operation, { name: 'AbortError' });
        const finalSnapshots = snapshots; hold.release(); await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(active, 0); assert.equal(count, 3); assert.equal(snapshots, finalSnapshots); assert.equal(calls.some(url => url.hostname === 'itunes.apple.com'), false);
      } finally { run.controller.abort(); hold.release(); await run.operation.catch(() => {}); }
    });
    await t.test('the same 200-ID run budget also covers optional Labs lookup after SSR misses', async () => {
      const list = songs(1900000, 6), editions = list.slice(0, 5).flatMap((song, index) => Array.from({ length: 40 }, (_, edition) => ({ ...song, id: String(2000000 + index * 40 + edition) })));
      const submitted: string[] = [];
      handler = async (url, options) => {
        if (url.pathname === '/apple-music-id-from-metadata/json') {
          const inputs = JSON.parse(String(options.body));
          return Response.json(inputs.map((item: Record<string, unknown>) => ({ ...item, apple_music_track_ids: item.track_name === list[5].title ? [list[5].id, '2999999'] : [] })));
        }
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response(searchHtml(editions.filter(song => `${song.artist} ${song.title}` === url.searchParams.get('term')), country, url.searchParams.get('term')!));
        if (url.hostname === 'itunes.apple.com') {
          if (url.pathname === '/lookup') { const ids = url.searchParams.get('id')!.split(','); submitted.push(...ids); return itunesJson([...editions, list[5]].filter(song => ids.includes(song.id)), country); }
          return itunesJson(url.searchParams.get('term') === `${list[5].artist} ${list[5].title}` ? [list[5]] : [], country);
        }
        if (url.hostname === 'music.apple.com') {
          const song = [...editions, list[5]].find(song => url.pathname.endsWith('/' + song.id)); assert.ok(song);
          return new Response(songHtml(song, country, song.id === list[5].id ? song.artistId : '9999999'));
        }
        return base(url);
      };
      const result = await start('SSR shared lookup budget', list).operation;
      assert.deepEqual(result.items.map(item => item.id), [list[5].id]);
      assert.equal(new Set(submitted).size, 200); assert.equal(submitted.includes('2999999'), false);
      assert.ok(calls.some(url => url.hostname === 'itunes.apple.com' && url.pathname === '/search'));
    });
    await t.test('a bounded SSR timeout falls back to ordinary exact Search and stops its request', async () => {
      const list = songs(1700000, 1), hold = gate(); let aborted = false, searches = 0;
      handler = async (url, options) => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
          searches++; try { await blocked(hold.promise, options.signal!); } catch { aborted = true; throw new DOMException('Synthetic timeout', 'AbortError'); }
        }
        if (url.hostname === 'itunes.apple.com' && url.pathname === '/search') return itunesJson(list, country);
        return base(url);
      };
      const result = await start('SSR timeout', list).operation;
      assert.equal(result.items.length, 1); assert.equal(searches, 1); assert.equal(aborted, true);
    });
    await t.test('separate progressive lookup batches share the real 3100ms iTunes quota', async () => {
      const list = songs(1800000, 4), next = gate(), late = gate(); const starts: number[] = [], batches: string[][] = []; realQuota = true;
      handler = async (url, options) => {
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) {
          const index = list.findIndex(song => `${song.artist} ${song.title}` === url.searchParams.get('term'));
          if (index === 1) await blocked(next.promise, options.signal!);
          if (index > 1) await blocked(late.promise, options.signal!);
          return new Response(searchHtml([list[index]], country, url.searchParams.get('term')!));
        }
        if (url.pathname === '/lookup') { starts.push(performance.now()); batches.push(url.searchParams.get('id')!.split(',')); }
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/' + list[0].id)) { next.release(); setTimeout(late.release, 300); }
        return base(url);
      };
      const run = start('SSR quota', list);
      try {
        const result = await run.operation; assert.equal(result.items.length, 4); assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 3090);
        assert.deepEqual(new Set(batches[1]), new Set(list.slice(1).map(song => song.id)));
      } finally { run.controller.abort(); next.release(); late.release(); await run.operation.catch(() => {}); realQuota = false; }
    });
  } finally { globalThis.fetch = original; }
});
