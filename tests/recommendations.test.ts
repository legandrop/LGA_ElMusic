import test from 'node:test';
import assert from 'node:assert/strict';
import { appleArtistId, appleArtworkUrl, seedAlbumsOnArtist, parsePublicSong, recommendations, selectAppleMatch } from '../src/recommendations';
import { RecommendationCandidate, RecommendationDiagnostic, RecommendationResult } from '../src/recommendation-types';
import { recommendationMatchFields } from '../src/record-recommendations';
import type { RecommendationMatchDiagnostic } from '../src/recommendation-types';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

type Song = Parameters<typeof selectAppleMatch>[1][number];
test('closed match diagnostic projection excludes unknown data and rejects invalid or inconsistent numbers', () => {
  const valid = { candidateIndex: 0, hasMbid: true, durationSource: 1, mbDurationMs: 200000, rowCount: 4, exactRowCount: 3,
    versionSafeRowCount: 2, durationRowCount: 1, minAppleDurationMs: 199000, maxAppleDurationMs: 220000, status: 2, selectionPolicy: 0 };
  assert.deepEqual(recommendationMatchFields({ ...valid, url: 'https://invalid.test/?api_key=fixture', apiKey: 'private-fixture', title: 'PRIVATE' }), valid);
  for (const bad of [{ candidateIndex: -1 }, { candidateIndex: 48 }, { candidateIndex: 0.5 }, { durationSource: 2 }, { status: 3 }, { status: '2' },
    { mbDurationMs: NaN }, { mbDurationMs: Infinity }, { mbDurationMs: 86400001 }, { mbDurationMs: 0 }, { hasMbid: false },
    { rowCount: 3.5 }, { rowCount: 10001 }, { rowCount: 2 }, { versionSafeRowCount: 4 }, { durationRowCount: 3 },
    { minAppleDurationMs: 230000 }, { minAppleDurationMs: NaN }, { maxAppleDurationMs: undefined }, { durationRowCount: 0 },
    { durationSource: 0 }, { selectionPolicy: 2 }, { selectionPolicy: undefined }, { hasMbid: 'true' }]) assert.equal(recommendationMatchFields({ ...valid, ...bad }), undefined, JSON.stringify(bad));
  assert.ok(recommendationMatchFields({ ...valid, selectionPolicy: 1, durationRowCount: 0 }));
  assert.equal(recommendationMatchFields({ ...valid, selectionPolicy: 1, durationRowCount: 0, versionSafeRowCount: 0 }), undefined);
  const unknown = { ...valid, hasMbid: false, durationSource: 0, mbDurationMs: undefined };
  assert.ok(recommendationMatchFields(unknown));
  assert.equal(recommendationMatchFields({ ...unknown, minAppleDurationMs: 1, maxAppleDurationMs: Infinity }), undefined);
});
test('Last.fm admission gives track durations the shared MB queue before optional seed discovery', async t => {
  await t.test('fast admitted candidates enqueue duration before seed without changing MB spacing', async () => {
    const original = globalThis.fetch; const controller = new AbortController();
    const mbid = '99999999-9999-9999-9999-999999999999';
    let received!: () => void; const seedReceived = new Promise<void>(resolve => { received = resolve; });
    const calls: { duration: boolean; time: number }[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
      if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: 'Gate duration song', artist: { name: 'Gate duration artist' }, mbid }] } });
      if (url.hostname === 'musicbrainz.org') {
        const duration = !!url.searchParams.get('query')?.startsWith('rid:'); calls.push({ duration, time: performance.now() });
        if (!duration) received();
        return Response.json({ count: 0, recordings: [], artists: [] });
      }
      return Response.json({ results: [] });
    };
    const operation = recommendations({ title: 'Gate duration seed', artist: 'Gate duration seed artist', album: '', country: 'ar' }, 'track', controller.signal, undefined, '1'.repeat(32));
    try {
      await seedReceived;
      assert.equal(calls[0].duration, true); assert.equal(calls[1].duration, false);
      assert.ok(calls[1].time - calls[0].time >= 1090);
    } finally { controller.abort(); await operation.catch(() => {}); globalThis.fetch = original; }
  });
  for (const scenario of ['slow', 'empty', 'error', 'cancel', 'no-key', 'artist'] as const) await t.test(scenario, async sub => {
    const original = globalThis.fetch; const controller = new AbortController();
    let release!: () => void, lastFmStarted!: () => void, mbStarted!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const lastFmRequest = new Promise<void>(resolve => { lastFmStarted = resolve; });
    const mbRequest = new Promise<void>(resolve => { mbStarted = resolve; });
    const events: string[] = []; const started = performance.now(); let mbTime = 0, gateTimer: ReturnType<typeof setTimeout> | undefined;
    const originalTimer = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    sub.mock.method(globalThis, 'setTimeout', ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
      const timer = originalTimer(callback, milliseconds, ...args); if (milliseconds === 2500) { gateTimer = timer; timers.add(timer); } return timer;
    }) as typeof setTimeout);
    sub.mock.method(globalThis, 'clearTimeout', ((timer: Parameters<typeof clearTimeout>[0]) => { timers.delete(timer as ReturnType<typeof setTimeout>); originalClear(timer); }) as typeof clearTimeout);
    const adds = sub.mock.method(controller.signal, 'addEventListener'); const removes = sub.mock.method(controller.signal, 'removeEventListener');
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
      if (url.hostname === 'itunes.apple.com') return Response.json({ resultCount: 0, results: [] });
      if (url.hostname === 'ws.audioscrobbler.com') {
        events.push('lastfm'); lastFmStarted();
        if (['slow', 'cancel', 'artist'].includes(scenario)) await blocked;
        if (scenario === 'error') { events.push('lastfm-error'); throw new Error('SYNTHETIC_LASTFM_FAILURE'); }
        events.push('lastfm-empty'); return Response.json({ similartracks: { track: [] }, similarartists: { artist: [] } });
      }
      assert.equal(url.hostname, 'musicbrainz.org'); events.push('mb'); mbTime ||= performance.now(); mbStarted();
      return Response.json({ count: 0, recordings: [], artists: [] });
    };
    const operation = recommendations({ title: 'Gate lifecycle ' + scenario, artist: 'Gate lifecycle artist ' + scenario, album: '', country: 'ar' }, scenario === 'artist' ? 'artist' : 'track', controller.signal,
      undefined, scenario === 'no-key' ? undefined : '2'.repeat(32));
    try {
      if (scenario === 'cancel') {
        await lastFmRequest; const gateListener = adds.mock.calls[0].arguments[1];
        assert.ok(gateTimer); controller.abort(); release(); await assert.rejects(operation, { name: 'AbortError' });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(events.includes('mb'), false); assert.equal(timers.size, 0);
        assert.ok(removes.mock.calls.some(call => call.arguments[1] === gateListener));
      } else {
        await mbRequest;
        if (scenario === 'slow') { assert.ok(mbTime - started >= 2400); assert.ok(mbTime - started <= 2900); }
        if (scenario === 'empty' || scenario === 'error') assert.ok(events.indexOf(scenario === 'error' ? 'lastfm-error' : 'lastfm-empty') < events.indexOf('mb'), events.join(' → '));
        if (scenario === 'no-key') assert.equal(events.includes('lastfm'), false);
        if (scenario === 'artist') assert.equal(events.includes('lastfm-empty'), false);
      }
    } finally { controller.abort(); release(); await operation.catch(() => {}); globalThis.fetch = original; }
    assert.equal(timers.size, 0);
  });
});
test('initial prefetch enters the iTunes queue before a ready independent candidate starts draining', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let releaseDuration!: () => void, searched!: () => void;
  const durationGate = new Promise<void>(resolve => { releaseDuration = resolve; });
  const firstSearch = new Promise<void>(resolve => { searched = resolve; });
  const firstSong: Song = { id: '820001', albumId: '830001', title: 'Priority first song (Live)', artist: 'Priority shared artist', album: 'Priority album', durationMs: 200000 };
  const mbid = '66666666-6666-6666-6666-666666666666';
  const searches: { term: string; time: number }[] = []; let pages = 0, durationReady = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.hostname === 'musicbrainz.org') {
      await durationGate;
      if (url.searchParams.get('query')?.startsWith('rid:')) { durationReady = true; return Response.json({ recordings: [recording(mbid, firstSong.title, firstSong.artist, firstSong.album, firstSong.durationMs)] }); }
      return Response.json({ count: 0, recordings: [], artists: [] });
    }
    if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [
      { name: firstSong.title, artist: { name: firstSong.artist }, mbid },
      { name: 'Priority independent song', artist: { name: firstSong.artist } }
    ] } });
    if (url.hostname === 'labs.api.listenbrainz.org') return Response.json([]);
    if (url.hostname === 'itunes.apple.com') {
      searches.push({ term: url.searchParams.get('term')!, time: performance.now() }); searched();
      return appleJson(searches.length === 1 ? [firstSong] : []);
    }
    assert.equal(url.hostname, 'music.apple.com'); assert.equal(durationReady, true); pages++;
    return new Response(songHtml(firstSong));
  };
  const operation = recommendations({ title: 'Initial queue seed', artist: 'Initial queue seed artist', album: '', country: 'ar' }, 'track', controller.signal, undefined, 'c'.repeat(32));
  try {
    await firstSearch;
    assert.equal(searches[0].term, `${firstSong.artist} ${firstSong.title}`);
    assert.equal(durationReady, false); assert.equal(pages, 0);
    releaseDuration(); const result = await operation;
    assert.deepEqual(result.items.map(item => item.id), [firstSong.id]);
    for (let index = 1; index < searches.length; index++) assert.ok(searches[index].time - searches[index - 1].time >= 3090);
  } finally { controller.abort(); releaseDuration(); await operation.catch(() => {}); globalThis.fetch = original; }
});
test('a prepared exact match reaches Apple validation without waiting for the optional mapped lookup', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let releaseDuration!: () => void, releaseExact!: () => void, releaseLookup!: () => void, searched!: () => void, mapped!: () => void, verified!: () => void;
  const durationGate = new Promise<void>(resolve => { releaseDuration = resolve; });
  const exactGate = new Promise<void>(resolve => { releaseExact = resolve; });
  const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
  const firstSearch = new Promise<void>(resolve => { searched = resolve; });
  const mappingReady = new Promise<void>(resolve => { mapped = resolve; });
  const firstVerified = new Promise<void>(resolve => { verified = resolve; });
  const songs: Song[] = [0, 1].map(index => ({ id: String(840001 + index), albumId: '850001', title: `Prepared exact ${index} (Live)`, artist: 'Prepared mapped artist', album: 'Prepared mapped album', durationMs: 200000 }));
  const mbids = ['77777777-7777-7777-7777-777777777777', '88888888-8888-8888-8888-888888888888'];
  let durationReady = false, lookupReturned = false, pages = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.hostname === 'musicbrainz.org') {
      await durationGate;
      if (url.searchParams.get('query')?.startsWith('rid:')) { durationReady = true; return Response.json({ recordings: songs.map((song, index) => recording(mbids[index], song.title, song.artist, song.album, song.durationMs)) }); }
      return Response.json({ count: 0, recordings: [], artists: [] });
    }
    if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: songs.map((song, index) => ({ name: song.title, artist: { name: song.artist }, mbid: mbids[index] })) } });
    if (url.hostname === 'labs.api.listenbrainz.org') {
      if (url.pathname !== '/apple-music-id-from-metadata/json') return Response.json([]);
      const inputs = JSON.parse(String(options?.body)); mapped();
      return Response.json(inputs.map((item: Record<string, unknown>, index: number) => ({ ...item, apple_music_track_ids: [songs[index].id] })));
    }
    if (url.hostname === 'itunes.apple.com') {
      if (url.pathname === '/lookup') { await lookupGate; lookupReturned = true; return appleJson(songs); }
      searched(); await exactGate; return appleJson(url.searchParams.get('term') === `${songs[0].artist} ${songs[0].title}` ? [songs[0]] : []);
    }
    assert.equal(url.hostname, 'music.apple.com'); assert.equal(durationReady, true); assert.equal(lookupReturned, false); pages++;
    return new Response(songHtml(songs[0]));
  };
  const operation = recommendations({ title: 'Prepared optional seed', artist: 'Prepared optional seed artist', album: '', country: 'ar' }, 'track', controller.signal,
    value => { if (value.items.some(item => item.id === songs[0].id)) verified(); }, 'd'.repeat(32));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([firstSearch, mappingReady]); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(pages, 0); releaseDuration();
    // Dejar que MB habilite la candidata mientras la búsqueda exacta sigue pendiente.
    while (!durationReady) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 0)); releaseExact();
    await Promise.race([firstVerified, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('OPTIONAL_LOOKUP_BLOCKED_PREPARED_EXACT')), 500); })]);
    assert.equal(pages, 1); assert.equal(lookupReturned, false);
  } finally { if (timer) clearTimeout(timer); controller.abort(); releaseDuration(); releaseExact(); releaseLookup(); await operation.catch(() => {}); globalThis.fetch = original; }
});
test('ready roster priority lets the hydrated first song pass queued independent searches without interrupting the active one', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let releaseDuration!: () => void, releaseActive!: () => void, activeStarted!: () => void, firstReady!: () => void;
  const durationGate = new Promise<void>(resolve => { releaseDuration = resolve; });
  const activeGate = new Promise<void>(resolve => { releaseActive = resolve; });
  const activeRequest = new Promise<void>(resolve => { activeStarted = resolve; });
  const ready = new Promise<void>(resolve => { firstReady = resolve; });
  const firstSong: Song = { id: '800001', albumId: '810001', title: 'Ready Dissolved Girl (Live)', artist: 'Ready Massive Attack', album: 'Ready Mezzanine', durationMs: 200000 };
  const mbid = '55555555-5555-5555-5555-555555555555';
  const others = ['A', 'B', 'C'].map(suffix => ({ name: `Independent ${suffix}`, artist: { name: `Artist ${suffix}` } }));
  const events: string[] = []; let durationReady = false, activeReturned = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.hostname === 'musicbrainz.org') {
      if (url.searchParams.get('query')?.startsWith('rid:')) { await durationGate; durationReady = true; return Response.json({ recordings: [recording(mbid, firstSong.title, firstSong.artist, firstSong.album, firstSong.durationMs)] }); }
      return Response.json({ count: 0, recordings: [], artists: [] });
    }
    if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: firstSong.title, artist: { name: firstSong.artist }, mbid }, ...others] } });
    if (url.hostname === 'labs.api.listenbrainz.org') return Response.json([]);
    if (url.hostname === 'itunes.apple.com') {
      const term = url.searchParams.get('term')!; events.push(term);
      if (term === 'Artist B Independent B') { activeStarted(); await activeGate; activeReturned = true; }
      return appleJson(term === `${firstSong.artist} ${firstSong.title}` ? [firstSong] : []);
    }
    assert.equal(url.hostname, 'music.apple.com'); assert.equal(durationReady, true); assert.equal(activeReturned, true);
    events.push('first-apple'); return new Response(songHtml(firstSong));
  };
  const operation = recommendations({ title: 'Ready priority seed', artist: 'Ready priority seed artist', album: '', country: 'ar' }, 'track', controller.signal,
    value => { if (value.cards?.find(card => card.title === firstSong.title)?.verificationStatus === 'checking') firstReady(); }, 'b'.repeat(32));
  try {
    await activeRequest; releaseDuration(); await ready;
    assert.equal(events.includes('first-apple'), false);
    releaseActive(); const result = await operation;
    assert.deepEqual(result.items.map(item => item.id), [firstSong.id]);
    assert.ok(events.indexOf('first-apple') < events.indexOf('Artist C Independent C'), events.join(' → '));
    assert.equal(events.filter(event => event === `${firstSong.artist} ${firstSong.title}`).length, 1);
  } finally { controller.abort(); releaseDuration(); releaseActive(); await operation.catch(() => {}); globalThis.fetch = original; }
});
test('exact-first prefetch verifies the first song before artist broad searches while still awaiting MB duration', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let release!: () => void, searched!: () => void, verified!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const firstSearch = new Promise<void>(resolve => { searched = resolve; });
  const firstVerified = new Promise<void>(resolve => { verified = resolve; });
  const firstSong: Song = { id: '780001', albumId: '790001', title: 'Dissolved Girl fixture (Live)', artist: 'Massive Attack fixture', album: 'Mezzanine fixture', durationMs: 200000 };
  const otherSong: Song = { ...firstSong, id: '780002', title: 'Artist catalogue fixture (Live)' };
  const mbids = ['33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];
  const searches: string[] = []; let pages = 0, durationReady = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.hostname === 'musicbrainz.org') {
      await blocked;
      if (url.searchParams.get('query')?.startsWith('rid:')) { durationReady = true; return Response.json({ recordings: [firstSong, otherSong].map((value, index) => recording(mbids[index], value.title, value.artist, value.album, value.durationMs)) }); }
      return Response.json({ count: 0, recordings: [], artists: [] });
    }
    if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [firstSong, otherSong].map((value, index) => ({ name: value.title, artist: { name: value.artist }, mbid: mbids[index] })) } });
    if (url.hostname === 'labs.api.listenbrainz.org') return Response.json([]);
    if (url.hostname === 'itunes.apple.com') {
      const term = url.searchParams.get('term')!; searches.push(term); searched();
      return appleJson(term === `${firstSong.artist} ${firstSong.title}` ? [firstSong] : [otherSong]);
    }
    assert.equal(url.hostname, 'music.apple.com'); assert.equal(durationReady, true); pages++;
    return new Response(songHtml(url.pathname.endsWith('/' + firstSong.id) ? firstSong : otherSong));
  };
  const operation = recommendations({ title: 'Exact-first seed', artist: 'Exact-first seed artist', album: '', country: 'ar' }, 'track', controller.signal,
    value => { if (value.items.some(item => item.id === firstSong.id)) verified(); }, 'a'.repeat(32));
  try {
    await firstSearch; assert.equal(searches[0], `${firstSong.artist} ${firstSong.title}`); assert.equal(pages, 0);
    release(); await firstVerified;
    assert.deepEqual(searches, [`${firstSong.artist} ${firstSong.title}`]);
    const result = await operation; assert.deepEqual(result.items.map(item => item.id), [firstSong.id, otherSong.id]);
    assert.deepEqual(searches, [`${firstSong.artist} ${firstSong.title}`, firstSong.artist]);
  } finally { controller.abort(); release(); await operation.catch(() => {}); globalThis.fetch = original; }
});
test('duration overlap starts independent playback and prefetches pending candidates without accepting them early', async t => {
  for (const independent of [true, false]) await t.test(independent ? 'independent candidate plays while MB waits' : 'prefetch waits for matching MB duration before Apple validation', async () => {
    const original = globalThis.fetch; const controller = new AbortController();
    let release!: () => void, first!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const prepared = new Promise<void>(resolve => { first = resolve; });
    const values: Song[] = [0, 1].map(index => ({ id: String(760000 + index), albumId: '770000', title: `Overlap song ${independent} ${index} (Live)`, artist: 'Overlap artist ' + independent, album: 'Overlap album', durationMs: index ? 205000 : 200000 }));
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
    let released = false, appleRequests = 0; const searches: string[] = [], snapshots: RecommendationResult[] = [];
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
      if (url.hostname === 'musicbrainz.org') {
        await blocked;
        return url.searchParams.get('query')?.startsWith('rid:') ? Response.json({ recordings: values.map((value, index) => recording(ids[index], value.title, value.artist, value.album, 200000)) }) : Response.json({ count: 0, recordings: [], artists: [] });
      }
      if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: values.map((value, index) => ({ name: value.title, artist: { name: value.artist }, ...(independent && index === 0 ? {} : { mbid: ids[index] }) })) } });
      if (url.hostname === 'labs.api.listenbrainz.org') return Response.json([]);
      if (url.hostname === 'itunes.apple.com') {
        const term = url.searchParams.get('term')!; searches.push(term); first();
        return appleJson(term === values[0].artist ? values : values.filter(value => term === `${value.artist} ${value.title}`));
      }
      assert.equal(url.hostname, 'music.apple.com'); appleRequests++;
      if (!independent) assert.equal(released, true);
      const value = values.find(item => url.pathname.endsWith('/' + item.id))!;
      return new Response(songHtml(value));
    };
    const operation = recommendations({ title: 'Overlap seed ' + independent, artist: 'Overlap seed artist', album: '', country: 'ar' }, 'track', controller.signal, value => { snapshots.push(value); if (independent && value.items.length) first(); }, 'f'.repeat(32));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([prepared, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DURATION_BARRIER_BLOCKED_SEARCH')), 6500); })]);
      if (timer) clearTimeout(timer);
      if (independent) {
        for (let tick = 0; tick < 20 && !snapshots.some(value => value.items.length); tick++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(snapshots.some(value => value.items.some(item => item.id === values[0].id)));
      } else { assert.ok(snapshots.every(value => !value.items.length)); assert.equal(appleRequests, 0); }
      released = true; release(); const result = await operation;
      assert.deepEqual(result.items.map(item => item.id), [values[0].id]);
      assert.equal(searches.filter(term => term === values[0].artist).length, 1); assert.equal(searches.length, 3);
      assert.equal(result.cards?.find(card => card.title === values[1].title)?.verificationStatus, 'unavailable');
    } finally { if (timer) clearTimeout(timer); controller.abort(); release(); await operation.catch(() => {}); globalThis.fetch = original; }
  });
});
test('progressive Last.fm artist cards declare fallback before later artists finish', async () => {
  const original = globalThis.fetch; const controller = new AbortController();
  let release!: () => void, seen!: (value: RecommendationResult) => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const preview = new Promise<RecommendationResult>(resolve => { seen = resolve; });
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.hostname === 'musicbrainz.org') { await blocked; return Response.json({ count: 0, recordings: [], artists: [] }); }
    if (url.hostname === 'ws.audioscrobbler.com') {
      const method = url.searchParams.get('method');
      if (method === 'track.getSimilar') return Response.json({ similartracks: { track: [] } });
      if (method === 'artist.getSimilar') return Response.json({ similarartists: { artist: [{ name: 'Early fallback artist' }, { name: 'Late fallback artist' }] } });
      if (url.searchParams.get('artist') === 'Late fallback artist') await blocked;
      return Response.json({ toptracks: { track: [{ name: 'Fallback song' }] } });
    }
    if (url.hostname === 'itunes.apple.com') return Response.json({ results: [] });
    throw new Error('UNEXPECTED_PUBLIC_REQUEST');
  };
  const operation = recommendations({ title: 'Progressive fallback seed', artist: 'Progressive scope seed', album: '', country: 'ar' }, 'track', controller.signal,
    value => { if (value.cards?.some(card => card.source === 'Last.fm' && card.signal === 'artist')) seen(value); }, 'e'.repeat(32));
  try {
    const value = await preview;
    assert.equal(value.artistFallback, true);
    assert.ok(value.cards?.every(card => card.signal === 'artist'));
    assert.equal(value.items.length, 0);
  } finally {
    controller.abort(); release(); await operation.catch(() => {}); globalThis.fetch = original;
  }
});
const seedId = 'fc541d05-ed9c-4c48-b0ef-ad12c414ca66';
const artistId = '06e99a1b-4020-4380-ab27-1a3e0c5e557c';
const seed = { title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', country: 'ar' };
const candidate: RecommendationCandidate = { title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', durationMs: 394000,
  source: 'ListenBrainz', signal: 'track', rank: 0, sourceUrl: 'https://labs.api.listenbrainz.org/similar-recordings', algorithm: 'fixture' };
const song: Song = { id: '1740127239', albumId: '1740127233', title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', durationMs: 394121 };
test('studio edition ranking keeps exact songs across albums and bounded duration differences', () => {
  const current = { ...candidate, album: undefined, durationMs: 303973, title: 'Roads', artist: 'Portishead' };
  const dummy: Song = { id: '1440653203', albumId: '1440653096', title: 'Roads', artist: 'Portishead', album: 'Dummy', durationMs: 303973 };
  const compilation = { ...dummy, id: '1870933906', albumId: '1870933738', album: 'LA GRAZIA dal film di Sorrentino', durationMs: 304000 };
  assert.equal(selectAppleMatch(current, [compilation, dummy]).song?.id, dummy.id);
  assert.deepEqual(selectAppleMatch(current, [compilation, dummy]).alternativeIds, [compilation.id]);
  assert.equal(selectAppleMatch({ ...current, album: compilation.album }, [dummy, compilation]).song?.id, compilation.id);
  assert.equal(selectAppleMatch({ ...current, album: 'A different studio edition' }, [dummy]).song?.id, dummy.id);
  const lovely: Song = { id: '1435646607', albumId: '1435646598', title: 'Lovely Head', artist: 'Goldfrapp', album: 'Felt Mountain', durationMs: 229827 };
  assert.equal(selectAppleMatch({ ...current, title: lovely.title, artist: lovely.artist, durationMs: 229827 }, [lovely, { ...lovely, id: '1439114836', album: 'Lovely Head - Single', durationMs: 229693 }]).song?.id, lovely.id);
});
test('plain Roads never selects Roseland Live even with the same duration or a leading live result', () => {
  const current = { ...candidate, album: undefined, durationMs: undefined, title: 'Roads', artist: 'Portishead' };
  const dummy: Song = { id: '1440653203', albumId: '1440653096', title: 'Roads', artist: 'Portishead', album: 'Dummy', durationMs: 303973 };
  const live = { ...dummy, id: '1440913668', albumId: '1440913466', album: 'Roseland, NYC Live' };
  assert.equal(selectAppleMatch(current, [live, dummy]).song?.id, dummy.id);
  assert.equal(selectAppleMatch(current, [live]).status, 'missing');
  assert.equal(selectAppleMatch({ ...current, album: live.album }, [dummy, live]).song?.id, live.id);
  assert.equal(selectAppleMatch(current, [{ ...dummy, album: 'Live Through This' }]).status, 'matched');
  for (const album of ['Dummy (Live)', 'Live at Roseland', 'In Concert', 'Unplugged in New York', 'Dummy - Acoustic', 'Dummy (Remix)', 'Dummy (Re-recorded)']) assert.equal(selectAppleMatch(current, [{ ...dummy, album }]).status, 'missing', album);
});
test('edition tolerance uses a bounded range and preserves explicit versions and missing-duration ambiguity', () => {
  const current = { ...candidate, album: undefined, durationMs: 201000 };
  const rows = [200000, 201500, 203000].map((durationMs, index) => ({ ...song, id: String(700 + index), durationMs }));
  assert.equal(selectAppleMatch({ ...current, durationMs: undefined }, rows).status, 'ambiguous');
  assert.equal(selectAppleMatch(current, rows).alternativeIds.includes(rows[2].id), false);
  assert.equal(selectAppleMatch(current, rows.slice(0, 2)).status, 'matched');
  assert.equal(selectAppleMatch({ ...current, durationMs: undefined }, [{ ...song, durationMs: undefined }, { ...song, id: '2', durationMs: undefined }]).status, 'ambiguous');
  assert.equal(selectAppleMatch({ ...current, title: 'No (Live)' }, [{ ...song, title: 'No (Live)', durationMs: 200000 }, { ...song, id: '2', title: 'No (Live)', album: 'Another live concert', durationMs: 200000 }]).status, 'ambiguous');
});
test('separated studio clusters need a real duration and an inclusive 1000ms advantage', () => {
  const current = { ...candidate, album: undefined, durationMs: 200000 };
  const closest = { ...song, id: '501', durationMs: 199499 }, other = { ...song, id: '502', album: 'Another album', durationMs: 201501 };
  assert.equal(selectAppleMatch(current, [other, closest]).song?.id, closest.id);
  assert.equal(selectAppleMatch(current, [closest, other]).song?.id, closest.id);
  assert.deepEqual(selectAppleMatch(current, [closest, other]).alternativeIds, []);
  assert.equal(selectAppleMatch(current, [closest, { ...other, durationMs: 201500 }]).status, 'ambiguous');
  assert.equal(selectAppleMatch(current, [{ ...closest, durationMs: 198500 }, { ...other, durationMs: 201500 }]).status, 'ambiguous');
  assert.equal(selectAppleMatch({ ...current, durationMs: undefined }, [closest, other]).status, 'ambiguous');
  for (const invalid of [NaN, Infinity, 0, -1]) assert.notEqual(selectAppleMatch({ ...current, durationMs: invalid }, [closest, other]).status, 'matched');
  assert.equal(selectAppleMatch({ ...current, album: other.album }, [closest, { ...other, durationMs: 202001 }]).song?.id, closest.id);
});
test('normal Last.fm selects public catalog metadata without claiming its MBID identifies the edition', () => {
  const current: RecommendationCandidate = { ...candidate, source: 'Last.fm', album: undefined, durationMs: 270066 };
  const query = `${current.artist} ${current.title}`.toLowerCase();
  const preferred: Song = { ...song, id: '99001', durationMs: 298373, catalogQuery: query, catalogOrdinal: 1 };
  const deluxe: Song = { ...preferred, id: '99002', album: song.album + ' (Deluxe Edition)', durationMs: 300533, catalogOrdinal: 0 };
  assert.equal(selectAppleMatch(current, [deluxe, preferred]).song?.id, preferred.id);
  assert.equal(selectAppleMatch(current, [preferred, deluxe]).song?.id, preferred.id);
  assert.equal(selectAppleMatch({ ...current, source: 'ListenBrainz' }, [preferred, deluxe]).status, 'missing');
  const explicit = { ...current, title: current.title + ' (Live)' };
  assert.equal(selectAppleMatch(explicit, [{ ...preferred, title: explicit.title }]).status, 'missing');
  for (const wrong of [{ ...preferred, title: current.title + ' (Remix)' }, { ...preferred, artist: 'Other artist' }, { ...preferred, album: 'Roseland, NYC Live' }, { ...preferred, durationMs: undefined }, { ...preferred, durationMs: NaN }]) {
    assert.equal(selectAppleMatch(current, [wrong]).status, 'missing');
  }
  const distant = { ...preferred, id: '1', album: 'Other normal album', durationMs: 225840, catalogOrdinal: 2 };
  const adjacent = { ...preferred, id: '99003', album: 'Single', durationMs: 298500, catalogOrdinal: 3 };
  const selected = selectAppleMatch(current, [distant, adjacent, preferred]);
  assert.equal(selected.song?.id, preferred.id); assert.deepEqual(selected.alternativeIds, [adjacent.id]);
  assert.equal(selectAppleMatch({ ...current, album: distant.album }, [preferred, distant]).song?.id, distant.id);
  assert.equal(selectAppleMatch(current, [{ ...distant, catalogQuery: 'unrelated query', catalogOrdinal: 0 }, preferred]).song?.id, preferred.id);
  const unknown = [preferred, distant].map(row => ({ ...row, catalogQuery: undefined, catalogOrdinal: undefined }));
  assert.equal(selectAppleMatch(current, unknown).song?.id, selectAppleMatch(current, [...unknown].reverse()).song?.id);
});
const artwork = 'https://is1-ssl.mzstatic.com/image/thumb/Music112/v4/fa/f3/01/faf301a4-6647-93ed-814d-e5640b7fb0d2/cover_4050215331501.jpg/100x100bb.jpg';
function songHtml(value: Song, country = 'ar', kind = 'SongDetailPageIntent', extra: Record<string, unknown> = {}): string {
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: kind, contentDescriptor: { kind: 'song', identifiers: { storeAdamID: value.id }, locale: { storefront: country } } },
    data: { canonicalURL: `https://music.apple.com/${country}/song/public-song/${value.id}`, sections: [{ items: [{
      title: value.title, artists: value.artist, album: value.album, artistLinks: [{ title: value.artist }],
      contentDescriptor: { kind: 'song', identifiers: { storeAdamID: value.id }, albumID: value.albumId }, ...extra
    }] }] }
  }] }) + '</script>';
}
function appleJson(values: Song[]): Response {
  return Response.json({ resultCount: values.length, results: values.map(value => ({ kind: 'song', wrapperType: 'track',
    trackId: Number(value.id), collectionId: Number(value.albumId), trackName: value.title, artistName: value.artist,
    collectionName: value.album, trackTimeMillis: value.durationMs, country: 'ARG', isStreamable: true, artworkUrl100: value.artworkUrl })) });
}
function recording(id: string, title: string, artist: string, album: string, length = 200000): Record<string, unknown> {
  return { id, title, length, 'artist-credit': [{ name: artist, artist: { id: artistId, name: artist }, joinphrase: '' }], releases: [{ title: album }] };
}
function artistHtml(id: string, albumId: string, artist: string, album: string, country = 'ar', extra: Record<string, unknown> = {}): string {
  const card = { titleLinks: [{ title: album }], contentDescriptor: { kind: 'album', identifiers: { storeAdamID: albumId }, url: `https://music.apple.com/${country}/album/public-album/${albumId}` } };
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: 'ArtistDetailPageIntent', contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: id }, locale: { storefront: country } } },
    data: { canonicalURL: `https://music.apple.com/${country}/artist/public-artist/${id}`, sections: [{ items: [{ title: artist, contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: id } } }] }, { items: [card] }], ...extra }
  }] }) + '</script>';
}
function albumIdentityHtml(albumId: string, title: string, artist: string, artistId = '274067889'): string {
  return '<script id="serialized-server-data">' + JSON.stringify({ data: [{
    intent: { $kind: 'AlbumDetailPageIntent', contentDescriptor: { kind: 'album', identifiers: { storeAdamID: albumId }, locale: { storefront: 'ar' } } },
    data: { canonicalURL: `https://music.apple.com/ar/album/${albumId}`, sections: [{ items: [{ title, subtitleLinks: [{ title: artist, segue: { destination: { contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: artistId }, url: `https://music.apple.com/ar/artist/${artistId}` } } } }], contentDescriptor: { kind: 'album', identifiers: { storeAdamID: albumId } } }] }] }
  }] }) + '</script>';
}
test('artist identity uses closed Apple artist relations and primary regional album cards only', () => {
  assert.equal(appleArtistId('https://itunes.apple.com/us/artist/id274067889'), '274067889');
  assert.equal(appleArtistId('https://music.apple.com/ar/artist/bonaparte/274067889'), '274067889');
  for (const url of ['https://evil.test/ar/artist/274067889', 'https://music.apple.com/ar/song/274067889', 'https://person@music.apple.com/ar/artist/274067889', 'https://music.apple.com/ar/artist/274067889?token=x', 'http://itunes.apple.com/us/artist/id274067889']) assert.equal(appleArtistId(url), undefined);
  const html = artistHtml('274067889', '6799087260', seed.artist, seed.album);
  assert.deepEqual(seedAlbumsOnArtist(html, 'ar', '274067889', seed), [{ country: 'ar', id: '6799087260' }]);
  assert.throws(() => seedAlbumsOnArtist(html, 'ar', '999', seed), /MISMATCH/);
  assert.throws(() => seedAlbumsOnArtist(artistHtml('274067889', '6799087260', seed.artist, seed.album, 'us'), 'ar', '274067889', seed), /MISMATCH/);
  assert.deepEqual(seedAlbumsOnArtist(artistHtml('274067889', '6799087260', seed.artist, seed.album, 'ar', { sections: [{ items: [{ title: seed.artist, contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: '274067889' } } }] }, { items: [{ related: { titleLinks: [{ title: seed.album }], contentDescriptor: { kind: 'album', identifiers: { storeAdamID: '6799087260' }, url: 'https://music.apple.com/ar/album/6799087260' } } }] }] }), 'ar', '274067889', seed), []);
});
// Metadata pública observada el 13/10/2026; la prueba no acredita audio ni disponibilidad de una cuenta.
const noCandidates = [
  { id: 'ab804a7e-b245-4e53-81f1-492a89636cb7', title: '33 “GOD”', artist: 'Bon Iver', album: '22, a Million', length: 210826, apple: { id: '1141108078', albumId: '1141107722', durationMs: 213000 } },
  { id: '3705d30d-4d59-4651-9cce-2ab75c3f19ee', title: '29 #Strafford APTS', artist: 'Bon Iver', album: '22, a Million', length: 245200, apple: { id: '1141108079', albumId: '1141107722', durationMs: 245200 } },
  { id: '04d4f028-004d-4955-8ea9-09977d565008', title: '715 - CR∑∑KS', artist: 'Bon Iver', album: '22, a Million', length: 132000, apple: { id: '1141108077', albumId: '1141107722', durationMs: 132000 } },
  { id: 'e29880b8-0bc6-4daf-bb43-41ecef41c41c', title: 'Obvs', artist: 'Jamie xx', album: 'In Colour', length: 231040, apple: { id: '1525506968', albumId: '1525506447', durationMs: 231107 } },
  { id: 'df8011b1-41de-4506-a5cd-1f98db8b0621', title: 'Rolling Stone', artist: 'Danny Brown featuring Petite Noir', album: 'Atrocity Exhibition', length: 227982, apple: undefined },
  { id: 'd8538f10-e51c-45e9-88ec-7cc4905dbc29', title: '666 ʇ', artist: 'Bon Iver', album: '22, a Million', length: 252000, apple: undefined },
  { id: 'bfa8e2c0-1842-4854-a5fd-de92cdb2411b', title: '10 d E A T h b R E a s T ⚄ ⚄', artist: 'Bon Iver', album: '22, a Million', length: 144000, apple: undefined },
  { id: 'ae180777-0603-4787-873a-b2bb3e47dd89', title: 'Girl', artist: 'Jamie xx', album: 'In Colour', length: 241453, apple: { id: '1525507116', albumId: '1525506447', durationMs: 240973 } }
];

test('compatible editorial editions keep exact versions, durations and provider album preference', () => {
  const deluxe = { ...song, id: '1745362322', albumId: '1745361904', album: 'Sirens (Deluxe Edition)' };
  assert.deepEqual(selectAppleMatch(candidate, [deluxe, song]).alternativeIds, [deluxe.id]);
  assert.equal(selectAppleMatch(candidate, [deluxe, song]).song?.id, song.id);
  assert.equal(selectAppleMatch({ ...candidate, album: deluxe.album }, [song, deluxe]).song?.id, deluxe.id);
  for (const changed of [{ title: 'No (Live)' }, { title: 'No (Mixed)' }, { title: 'No (Remix)' }, { title: 'No (feat. Guest)' },
    { artist: 'Cover Band' }, { artist: 'Nicolas Jaar & Guest' }, { durationMs: 396001 }]) {
    assert.equal(selectAppleMatch(candidate, [{ ...song, ...changed }]).status, 'missing');
  }
  assert.equal(selectAppleMatch(candidate, [{ ...song, durationMs: 396000 }]).status, 'matched');
});
test('studio albums and small clock differences are secondary while missing durations remain unresolved', () => {
  assert.equal(selectAppleMatch({ ...candidate, album: undefined }, [song, { ...song, id: '20', album: 'Compilation' }]).status, 'matched');
  assert.equal(selectAppleMatch(candidate, [song, { ...song, id: '20', durationMs: 394120 }]).status, 'matched');
  assert.equal(selectAppleMatch({ ...candidate, durationMs: undefined }, [{ ...song, durationMs: undefined }, { ...song, id: '20', durationMs: undefined }]).status, 'ambiguous');
  assert.equal(selectAppleMatch(candidate, [{ ...song, durationMs: undefined }]).status, 'missing');
  assert.equal(selectAppleMatch(candidate, [song, song]).alternativeIds.length, 0);
});
test('public song validation requires the exact resource, region, complete credit and canonical URL', () => {
  assert.equal(parsePublicSong(songHtml(song), 'ar', song), `https://music.apple.com/ar/song/public-song/${song.id}`);
  assert.throws(() => parsePublicSong(songHtml(song, 'us'), 'ar', song), /MISMATCH/);
  assert.throws(() => parsePublicSong(songHtml(song, 'ar', 'AlbumDetailPageIntent'), 'ar', song), /MISMATCH/);
  for (const changed of [{ title: 'No (Live)' }, { artists: 'Different Artist', artistLinks: [{ title: 'Different Artist' }] },
    { album: 'Sirens (Deluxe Edition)' }, { contentDescriptor: { kind: 'song', identifiers: { storeAdamID: '99' }, albumID: song.albumId } }]) {
    assert.throws(() => parsePublicSong(songHtml(song, 'ar', 'SongDetailPageIntent', changed), 'ar', song), /MISMATCH/);
  }
  const html = songHtml(song);
  for (const url of [`http://music.apple.com/ar/song/${song.id}`, `https://music.apple.com.evil.test/ar/song/${song.id}`,
    `https://music.apple.com/ar/song/${song.id}?token=x`, `https://music.apple.com/us/song/${song.id}`, `https://user:secret@music.apple.com/ar/song/${song.id}`]) {
    assert.throws(() => parsePublicSong(html.replace(`https://music.apple.com/ar/song/public-song/${song.id}`, url), 'ar', song), /MISMATCH/);
  }
});
test('artwork accepts only the observed Apple thumbnail policy and never rebuilds the URL', () => {
  assert.equal(appleArtworkUrl(artwork), artwork);
  assert.equal(appleArtworkUrl(artwork.replace('Music112', 'Music221')), artwork.replace('Music112', 'Music221'));
  assert.equal(appleArtworkUrl(artwork.replace('cover_4050215331501.jpg', '656605230061.jpg')), artwork.replace('cover_4050215331501.jpg', '656605230061.jpg'));
  for (const value of [undefined, '', artwork.replace('https:', 'http:'), artwork.replace('is1-ssl.mzstatic.com', 'is1-ssl.mzstatic.com.evil.test'),
    artwork.replace('is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com'), artwork.replace('https://', 'https://person:secret@'),
    artwork.replace('.com/', '.com:444/'), artwork + '?token=secret', artwork + '#fragment', artwork.replace('/image/thumb/', '/download/'),
    artwork.replace('100x100bb.jpg', '1200x1200bb.jpg'), artwork.replace('100x100bb.jpg', '100x100bb.svg'), artwork + 'x'.repeat(2048)]) assert.equal(appleArtworkUrl(value), undefined);
});
test('closed match diagnostics preserve observed duration failures, provenance, callback isolation and cancellation', async t => {
  const original = globalThis.fetch; let now = Date.now(); t.mock.method(Date, 'now', () => now);
  try {
    for (const scenario of ['mb-missing', 'mb-cached', 'mbid-no-duration', 'nested-credit', 'joined-credit', 'credited-alias', 'malformed-credit', 'no-mbid-ambiguous', 'callback-throw', 'cancel', 'cancel-before'] as const) await t.test(scenario, async () => {
      const mbid = '11111111-2222-3333-4444-555555555555';
      const value: Song = { id: '975001', albumId: '975000', title: 'Numeric diagnostic ' + scenario + ' (Live)', artist: scenario === 'joined-credit' ? 'Numeric primary feat. Numeric guest' : 'Numeric artist ' + scenario, album: 'Numeric album', durationMs: 210000 };
      const hasMbid = scenario === 'mb-missing' || scenario === 'mb-cached' || scenario === 'mbid-no-duration' || scenario.endsWith('-credit') || scenario === 'credited-alias';
      const mbKnown = hasMbid && !['mbid-no-duration', 'credited-alias', 'malformed-credit'].includes(scenario);
      const rows = [value, { ...value, id: '975002', albumId: '975003', album: 'Numeric compilation', durationMs: 215000 }];
      const events: RecommendationMatchDiagnostic[] = [], controller = new AbortController(); let durationQueries = 0, pages = 0;
      globalThis.fetch = async input => {
        now += 4000; const url = new URL(String(input));
        if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: value.title, artist: { name: value.artist }, ...(hasMbid ? { mbid } : {}) }] } });
        if (url.hostname === 'musicbrainz.org') {
          if (url.searchParams.get('query')?.startsWith('rid:')) {
            durationQueries++; const row = recording(mbid, value.title, value.artist, value.album, scenario === 'mbid-no-duration' ? 0 : 200000);
            if (scenario === 'nested-credit') row['artist-credit'] = [{ artist: { name: value.artist } }];
            if (scenario === 'joined-credit') row['artist-credit'] = [{ artist: { name: 'Numeric primary' }, joinphrase: ' feat. ' }, { artist: { name: 'Numeric guest' } }];
            if (scenario === 'credited-alias') row['artist-credit'] = [{ name: 'Explicit different alias', artist: { name: value.artist } }];
            if (scenario === 'malformed-credit') row['artist-credit'] = [{ name: null, artist: { name: value.artist } }];
            return Response.json({ recordings: [row] });
          }
          return Response.json({ count: 0, recordings: [], artists: [] });
        }
        if (url.hostname === 'itunes.apple.com') { if (scenario === 'cancel-before') controller.abort(); return appleJson(scenario === 'callback-throw' || scenario === 'cancel' ? [value] : rows); }
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
        if (url.hostname === 'music.apple.com') { pages++; return new Response(songHtml(value)); }
        return Response.json([]);
      };
      const callback = (event: RecommendationMatchDiagnostic): void => { events.push(event); if (scenario === 'callback-throw') throw new Error('PRIVATE_CALLBACK_ERROR'); if (scenario === 'cancel') controller.abort(); };
      const run = (title: string) => recommendations({ title, artist: 'Numeric seed artist', album: '', country: 'ar' }, 'track', controller.signal, undefined, '6'.repeat(32), undefined, callback);
      if (scenario === 'cancel' || scenario === 'cancel-before') {
        await assert.rejects(run('Numeric cancellation seed'), { name: 'AbortError' });
        const count = scenario === 'cancel' ? 1 : 0;
        assert.equal(events.length, count); assert.equal(pages, 0); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(events.length, count);
      } else {
        const result = await run('Numeric seed ' + scenario);
        assert.equal(events.length, 1); assert.equal(events[0].candidateIndex, 0); assert.equal(events[0].hasMbid, hasMbid);
        assert.equal(events[0].durationSource, mbKnown ? 1 : 0); assert.equal(events[0].mbDurationMs, mbKnown ? 200000 : undefined);
        assert.equal(events[0].selectionPolicy, 0);
        assert.equal(events[0].status, mbKnown ? 0 : scenario === 'callback-throw' ? 2 : 1);
        assert.equal(events[0].exactRowCount, scenario === 'callback-throw' ? 1 : 2);
        assert.equal(events[0].durationRowCount, mbKnown ? 0 : events[0].exactRowCount);
        assert.equal(events[0].minAppleDurationMs, 210000); assert.equal(events[0].maxAppleDurationMs, scenario === 'callback-throw' ? 210000 : 215000);
        assert.equal(result.items.length, scenario === 'callback-throw' ? 1 : 0);
        assert.ok(events.every(event => recommendationMatchFields(event)));
        assert.equal(JSON.stringify(events).includes(value.title), false); assert.equal(JSON.stringify(events).includes(mbid), false); assert.equal(JSON.stringify(events).includes('http'), false);
        if (scenario === 'mb-cached') {
          const before = durationQueries; now += 1000; await run('Numeric second seed ' + scenario);
          assert.equal(durationQueries, before); assert.equal(events.length, 2); assert.equal(events[1].durationSource, 1); assert.equal(events[1].mbDurationMs, 200000);
        }
      }
    });
  } finally { globalThis.fetch = original; }
});
test('anonymous recommendation pipeline preserves source order, failures and cancellation', async t => {
  const original = globalThis.fetch; let now = Date.now(); const calls: URL[] = [];
  t.mock.method(Date, 'now', () => now);
  let handler: (url: URL, options?: RequestInit) => Response | Promise<Response> = () => { throw new Error('UNEXPECTED_PUBLIC_REQUEST'); };
  let mappingHandler: ((options?: RequestInit) => Response | Promise<Response>) | undefined;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); now += 4000;
    if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
    if (url.pathname === '/apple-music-id-from-metadata/json') {
      assert.equal(options?.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
      return mappingHandler?.(options) ?? Response.json([]);
    }
    if (url.hostname === 'itunes.apple.com' && url.searchParams.get('entity') === 'musicArtist') return Response.json({ resultCount: 0, results: [] });
    calls.push(url);
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
    assert.equal(options?.method, 'GET'); assert.ok(options?.signal);
    return handler(url, options);
  };
  const signal = (): AbortSignal => new AbortController().signal;
  const fixture = (title: string, values = noCandidates): void => {
    calls.length = 0; mappingHandler = undefined; now += 1000000;
    handler = url => {
      if (url.hostname === 'musicbrainz.org') {
        assert.equal(url.pathname, '/ws/2/recording'); assert.equal(url.searchParams.get('fmt'), 'json');
        if (url.searchParams.get('query')?.startsWith('rid:')) return Response.json({ count: values.length,
          recordings: values.map(value => recording(value.id, value.title, value.artist, value.album, value.length)) });
        assert.ok(url.searchParams.get('query')?.includes(`recording:"${title}"`));
        return Response.json({ count: 1, recordings: [recording(seedId, title, seed.artist, seed.album)] });
      }
      if (url.hostname === 'labs.api.listenbrainz.org') {
        assert.equal(url.pathname, '/similar-recordings/json'); assert.equal(url.searchParams.get('recording_mbids'), seedId);
        return Response.json(values.map(value => ({ reference_mbid: seedId, recording_mbid: value.id, recording_name: value.title, artist_credit_name: value.artist, release_name: value.album })));
      }
      if (url.hostname === 'itunes.apple.com') {
        assert.equal(url.searchParams.get('country'), 'ar'); assert.equal(url.searchParams.get('entity'), 'song'); assert.equal(url.searchParams.get('limit'), '50');
        const artistRows = values.filter(item => url.searchParams.get('term') === item.artist && item.apple);
        if (artistRows.length) return appleJson(artistRows.map(value => ({ ...value, ...value.apple! })));
        const value = values.find(item => url.searchParams.get('term') === `${item.artist} ${item.title}`);
        assert.ok(value); return appleJson(value.apple ? [{ ...value, ...value.apple }] : []);
      }
      assert.equal(url.hostname, 'music.apple.com');
      const value = values.find(item => item.apple && url.pathname.endsWith('/' + item.apple.id)); assert.ok(value?.apple);
      return new Response(songHtml({ ...value, ...value.apple }));
    };
  };
  try {
    await t.test('No real metadata fixture admits 4 of 8 and caches only bounded DTOs', async () => {
      fixture('No'); const progress: RecommendationResult[] = [];
      const result = await recommendations(seed, 'track', signal(), value => progress.push(value));
      assert.deepEqual(result.items.map(item => item.id), ['1525506968', '1141108079', '1525507116', '1141108077']);
      assert.equal(result.unresolved, 4); assert.equal(result.partial, true); assert.equal(result.providerUnavailable, false);
      assert.equal(result.lastFmConfigured, false); assert.equal(result.artistFallback, false);
      assert.ok(result.items.every(item => !item.recordingIdentityVerified && item.matchMethod === 'metadata' && item.source === 'ListenBrainz'));
      assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 6);
      assert.equal(calls.filter(url => url.hostname === 'music.apple.com').length, 4);
      assert.ok(!calls.some(url => url.hostname === 'ws.audioscrobbler.com'));
      assert.equal(progress.at(-1)?.items.length, 4); const count = calls.length;
      result.items[0].title = 'Caller mutation'; const cached = await recommendations(seed, 'track', signal());
      assert.equal(calls.length, count); assert.equal(cached.items[0].title, 'Obvs');
    });
    await t.test('a ready source publishes verified songs while the other source is still pending', async () => {
      fixture('Fast source', [noCandidates[1]]);
      const base = handler; let release!: () => void; let published!: () => void;
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const first = new Promise<void>(resolve => { published = resolve; });
      const fastSong: Song = { ...song, id: '99101', albumId: '99100', title: 'Ready track', artist: 'Ready artist', album: 'Ready album' };
      let waiting = true;
      handler = async (url, options) => {
        if (url.hostname === 'musicbrainz.org' && waiting) { waiting = false; await blocked; }
        if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: fastSong.title, artist: { name: fastSong.artist } }] } });
        if (url.hostname === 'itunes.apple.com' && url.searchParams.get('term') === `${fastSong.artist} ${fastSong.title}`) return appleJson([fastSong]);
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/' + fastSong.id)) return new Response(songHtml(fastSong));
        return base(url, options);
      };
      const controller = new AbortController(); let late = 0;
      const operation = recommendations({ ...seed, title: 'Fast source' }, 'track', controller.signal, value => {
        if (controller.signal.aborted) late++;
        if (value.items.some(item => item.id === fastSong.id)) published();
      }, 'd'.repeat(32));
      try {
        await Promise.race([first, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('READY_SOURCE_BLOCKED')), 3000))]);
        assert.equal(waiting, false); assert.ok(!calls.some(url => url.hostname === 'labs.api.listenbrainz.org'));
        controller.abort(); release(); await assert.rejects(operation, { name: 'AbortError' });
        assert.equal(late, 0);
      } finally { controller.abort(); release(); await operation.catch(() => {}); }
    });
    await t.test('candidate cards arrive before duration lookups and keep stable keys until verified', async () => {
      const values = noCandidates.slice(1, 3); fixture('Preview first', values); const base = handler;
      let release!: () => void; let seen!: (value: RecommendationResult) => void;
      const blocked = new Promise<void>(resolve => { release = resolve; }); const preview = new Promise<RecommendationResult>(resolve => { seen = resolve; });
      handler = async (url, options) => {
        if (url.hostname === 'musicbrainz.org' && url.searchParams.get('query')?.startsWith('rid:')) await blocked;
        return base(url, options);
      };
      const controller = new AbortController();
      const operation = recommendations({ ...seed, title: 'Preview first' }, 'track', controller.signal, value => { if (value.cards?.length === 2 && !value.items.length) seen(value); });
      try {
        const initial = await preview;
        assert.ok(initial.cards?.every(card => /^[a-f\d]{32}$/.test(card.key) && card.verificationStatus === 'pending' && card.verifiedId === undefined));
        assert.equal(calls.some(url => url.hostname === 'music.apple.com'), false);
        release(); const result = await operation;
        assert.deepEqual(result.cards?.map(card => card.key), initial.cards?.map(card => card.key));
        assert.ok(result.cards?.every(card => card.verificationStatus === 'verified' && result.items.some(item => item.id === card.verifiedId && item.candidateKey === card.key)));
      } finally { controller.abort(); release(); await operation.catch(() => {}); }
    });
    await t.test('forty-eight previews replenish failed matches up to thirty-two verified songs', async () => {
      const values = Array.from({ length: 50 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(1000 + index).padStart(12, '0')}`,
        title: `Large candidate ${index}`, artist: `Large artist ${index}`, album: `Large album ${index}`, length: 200000,
        apple: index < 16 ? undefined : { id: String(87000 + index), albumId: String(88000 + index), durationMs: 200000 } }));
      fixture('Large roster', values); const progress: RecommendationResult[] = [];
      const result = await recommendations({ ...seed, title: 'Large roster' }, 'track', signal(), value => progress.push(value));
      assert.equal(result.cards?.length, 48); assert.equal(result.items.length, 32); assert.equal(result.unresolved, 16);
      assert.ok(progress.some(value => value.cards?.length === 48 && value.items.length === 0));
      assert.ok(result.items.every(item => Number(item.id) >= 87016 && Number(item.id) <= 87047));
      assert.ok(progress.every(value => value.items.length <= 32 && (value.cards?.length ?? 0) <= 48));
    });
    await t.test('verified song links require exact regional artist and album descriptors', async () => {
      const value = noCandidates[1], selected: Song = { ...value, ...value.apple! };
      const link = (kind: 'artist' | 'album', title: string, id: string, url: string): Record<string, unknown> => ({ title, segue: { destination: { contentDescriptor: { kind, identifiers: { storeAdamID: id }, url } } } });
      const artistUrl = 'https://music.apple.com/ar/artist/public-artist/321', albumUrl = `https://music.apple.com/ar/album/public-album/${selected.albumId}`;
      for (const bad of [undefined, 'country', 'origin', 'id', 'query', 'credit'] as const) {
        const title = 'Safe links ' + String(bad); fixture(title, [value]); const base = handler;
        handler = (url, options) => url.hostname === 'music.apple.com' ? new Response(songHtml(selected, 'ar', 'SongDetailPageIntent', {
          artistLinks: [link('artist', bad === 'credit' ? 'Wrong artist' : selected.artist, '321', bad === 'country' ? artistUrl.replace('/ar/', '/us/') : bad === 'origin' ? artistUrl.replace('music.apple.com', 'evil.test') : bad === 'id' ? artistUrl.replace('/321', '/999') : bad === 'query' ? artistUrl + '?token=x' : artistUrl)],
          albumLinks: [link('album', selected.album, bad === 'id' ? '999' : selected.albumId, bad === 'country' ? albumUrl.replace('/ar/', '/us/') : bad === 'origin' ? albumUrl.replace('music.apple.com', 'evil.test') : bad === 'query' ? albumUrl + '?i=123' : albumUrl)]
        })) : base(url, options);
        const result = await recommendations({ ...seed, title }, 'track', signal());
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].artistUrl, bad ? undefined : artistUrl);
        assert.equal(result.items[0].albumUrl, bad && bad !== 'credit' ? undefined : albumUrl);
      }
    });
    await t.test('optional metadata mapping joins by exact metadata and resolves many IDs with one regional lookup', async () => {
      const values = Array.from({ length: 4 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(1200 + index).padStart(12, '0')}`,
        title: `Mapped song ${index}`, artist: `Mapped artist ${index}`, album: `Mapped album ${index}`, length: 200000,
        apple: { id: String(910000 + index), albumId: String(920000 + index), durationMs: 200000 } }));
      fixture('Mapping batch', values); const base = handler;
      let mapped!: () => void; const received = new Promise<void>(resolve => { mapped = resolve; }); let previews = false;
      mappingHandler = options => {
        assert.equal(previews, true);
        const inputs = JSON.parse(String(options?.body)); assert.equal(inputs.length, 4);
        assert.ok(inputs.every((item: Record<string, unknown>) => Object.keys(item).sort().join(',') === 'artist_name,release_name,track_name'));
        mapped();
        return Response.json([...inputs.reverse().map((item: Record<string, unknown>) => ({ ...item, apple_music_track_ids: [values.find(value => value.title === item.track_name)!.apple.id] })),
          { artist_name: 'Unrequested artist', track_name: 'Unrequested song', release_name: '', apple_music_track_ids: ['999999'] }]);
      };
      handler = async (url, options) => {
        if (url.hostname === 'musicbrainz.org' && url.searchParams.get('query')?.startsWith('rid:')) { await received; await new Promise(resolve => setTimeout(resolve, 0)); }
        if (url.pathname === '/lookup') {
          assert.deepEqual(new Set(url.searchParams.get('id')!.split(',')), new Set(values.map(value => value.apple.id)));
          assert.equal(url.searchParams.get('country'), 'ar'); assert.equal(url.searchParams.get('limit'), '200');
          return appleJson(values.map(value => ({ ...value, ...value.apple })));
        }
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Mapping batch' }, 'track', signal(), value => { previews ||= value.cards?.length === 4 && value.items.length === 0; });
      assert.equal(result.items.length, 4); assert.equal(calls.filter(url => url.pathname === '/lookup').length, 1);
      assert.ok(calls.filter(url => url.pathname === '/search').length <= 1);
      assert.equal(calls.filter(url => url.hostname === 'music.apple.com').length, 4);
    });
    await t.test('optional lookup rejects foreign IDs, country and metadata then preserves exact search fallback', async () => {
      for (const invalid of ['country', 'foreign-id', 'metadata', 'streamability'] as const) {
        const values = Array.from({ length: 2 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(1300 + index).padStart(12, '0')}`,
          title: `Rejected mapping ${invalid} ${index}`, artist: `Rejected artist ${invalid} ${index}`, album: `Rejected album ${invalid}`, length: 200000,
          apple: { id: String(930000 + index), albumId: '940000', durationMs: 200000 } }));
        fixture('Mapping rejection ' + invalid, values); const base = handler;
        let mapped!: () => void; const received = new Promise<void>(resolve => { mapped = resolve; });
        mappingHandler = options => { mapped(); return Response.json(JSON.parse(String(options?.body)).map((item: Record<string, unknown>, index: number) => ({ ...item, apple_music_track_ids: [values[index].apple.id] }))); };
        handler = async (url, options) => {
          if (url.hostname === 'musicbrainz.org' && url.searchParams.get('query')?.startsWith('rid:')) { await received; await new Promise(resolve => setTimeout(resolve, 0)); }
          if (url.pathname === '/lookup') {
            const data = await appleJson(values.map(value => ({ ...value, ...value.apple }))).json();
            for (const row of data.results) {
              if (invalid === 'country') row.country = 'USA';
              if (invalid === 'foreign-id') row.trackId = 999999;
              if (invalid === 'metadata') row.trackName += ' (Live)';
              if (invalid === 'streamability') row.isStreamable = false;
            }
            return Response.json(data);
          }
          return base(url, options);
        };
        const result = await recommendations({ ...seed, title: 'Mapping rejection ' + invalid }, 'track', signal());
        assert.deepEqual(result.items.map(item => item.id), values.map(value => value.apple.id));
        assert.equal(calls.filter(url => url.pathname === '/lookup').length, 1);
        assert.equal(calls.filter(url => url.pathname === '/search').length, 2);
        assert.equal(calls.some(url => url.hostname === 'music.apple.com' && url.pathname.endsWith('/999999')), false);
      }
    });
    await t.test('a pending optional mapping never delays exact search or publishes after completion', async () => {
      const values = noCandidates.slice(1, 3); fixture('Slow optional mapping', values);
      let mappingCalls = 0, aborted = false;
      mappingHandler = options => new Promise((_resolve, reject) => {
        mappingCalls++;
        options!.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
      });
      let progress = 0;
      const result = await recommendations({ ...seed, title: 'Slow optional mapping' }, 'track', signal(), () => { progress++; });
      const completed = progress; await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(result.items.length, 2); assert.equal(mappingCalls, 1); assert.equal(aborted, true); assert.equal(progress, completed);
      assert.equal(calls.some(url => url.pathname === '/lookup'), false);
    });
    await t.test('one regional search supplies several exact matches and validated pages survive a new seed', async () => {
      const values = noCandidates.slice(1, 3); fixture('Rows reused', values); const base = handler;
      handler = (url, options) => url.hostname === 'itunes.apple.com' ? appleJson(values.map(value => ({ ...value, ...value.apple! }))) : base(url, options);
      const first = await recommendations({ ...seed, title: 'Rows reused' }, 'track', signal());
      assert.equal(first.items.length, 2); assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 1);
      const before = calls.length;
      const nextTitle = 'Pages reused';
      handler = (url, options) => url.hostname === 'musicbrainz.org' && !url.searchParams.get('query')?.startsWith('rid:') ?
        Response.json({ count: 1, recordings: [recording(seedId, nextTitle, seed.artist, seed.album)] }) : base(url, options);
      first.items[0].title = 'Caller mutation';
      const second = await recommendations({ ...seed, title: nextTitle }, 'track', signal());
      assert.equal(second.items.length, 2); assert.equal(second.items[0].title, values[0].title);
      assert.equal(calls.slice(before).some(url => ['itunes.apple.com', 'music.apple.com'].includes(url.hostname)), false);
      const beforeRegion = calls.length;
      handler = (url, options) => url.hostname === 'itunes.apple.com' ? appleJson(values.map(value => ({ ...value, ...value.apple! }))) :
        url.hostname === 'music.apple.com' ? new Response(songHtml({ ...values[0], ...values[0].apple! }, 'ar')) :
        url.hostname === 'musicbrainz.org' && !url.searchParams.get('query')?.startsWith('rid:') ? Response.json({ count: 1, recordings: [recording(seedId, 'Other region', seed.artist, seed.album)] }) : base(url, options);
      const region = await recommendations({ ...seed, title: 'Other region', country: 'us' }, 'track', signal());
      assert.equal(region.items.length, 0); assert.ok(calls.slice(beforeRegion).some(url => url.hostname === 'itunes.apple.com' && url.searchParams.get('country') === 'us'));
      assert.ok(calls.slice(beforeRegion).some(url => url.hostname === 'music.apple.com' && url.pathname.startsWith('/us/')));
    });
    await t.test('cached rows keep ambiguous versions excluded and Apple validation concurrency bounded', async () => {
      const values = noCandidates.slice(1, 4).map((value, index) => index === 1 ? { ...value, apple: { ...value.apple!, durationMs: value.length - 1000 } } : value); fixture('Bounded pages', values); const base = handler;
      const ambiguous = { ...values[1], ...values[1].apple!, id: '99111', durationMs: values[1].length + 1500 };
      let inFlight = 0, maximum = 0;
      handler = async (url, options) => {
        if (url.hostname === 'itunes.apple.com') return appleJson([...values.map(value => ({ ...value, ...value.apple! })), ambiguous]);
        if (url.hostname === 'music.apple.com') {
          inFlight++; maximum = Math.max(maximum, inFlight);
          await new Promise(resolve => setTimeout(resolve, 20)); inFlight--;
        }
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Bounded pages' }, 'track', signal());
      assert.deepEqual(result.items.map(item => item.id), [values[0].apple!.id, values[2].apple!.id]);
      assert.equal(result.rejected, 1); assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 1);
      assert.ok(maximum >= 2 && maximum <= 3);
      assert.equal(calls.some(url => url.hostname === 'music.apple.com' && url.pathname.endsWith('/' + values[1].apple!.id)), false);
    });
    await t.test('the first exact query precedes artist batches while preserving the real iTunes interval', async () => {
      const values = Array.from({ length: 4 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(700 + index).padStart(12, '0')}`,
        title: `Batch track ${index}`, artist: index < 2 ? 'Batch artist A' : 'Batch artist B', album: 'Batch album', length: 200000,
        apple: { id: String(93000 + index), albumId: '92000', durationMs: 200000 } }));
      fixture('Real interval', values); const base = handler; const previousFetch = globalThis.fetch; const starts: number[] = [];
      handler = (url, options) => url.hostname === 'itunes.apple.com' ? appleJson(values.filter(value =>
        url.searchParams.get('term') === value.artist || url.searchParams.get('term') === `${value.artist} ${value.title}`).map(value => ({ ...value, ...value.apple }))) : base(url, options);
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
        calls.push(url); if (url.hostname === 'itunes.apple.com') starts.push(performance.now());
        return handler(url, options);
      };
      try {
        const result = await recommendations({ ...seed, title: 'Real interval' }, 'track', signal());
        assert.equal(result.items.length, 4); assert.equal(starts.length, 3);
        for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 3090);
        assert.deepEqual(calls.filter(url => url.hostname === 'itunes.apple.com').map(url => url.searchParams.get('term')), ['Batch artist A Batch track 0', 'Batch artist B', 'Batch artist A']);
      } finally { globalThis.fetch = previousFetch; }
    });
    await t.test('a missing broad-search title falls back exactly without discarding other verified titles', async () => {
      const values = noCandidates.slice(1, 3); fixture('Broad fallback', values); const base = handler; let published!: () => void;
      const first = new Promise<void>(resolve => { published = resolve; });
      handler = async (url, options) => {
        if (url.hostname === 'itunes.apple.com') {
          const term = url.searchParams.get('term');
          if (term === values[0].artist || term === `${values[0].artist} ${values[0].title}`) return appleJson([{ ...values[0], ...values[0].apple! }]);
          assert.equal(term, `${values[1].artist} ${values[1].title}`); await first; return appleJson([{ ...values[1], ...values[1].apple! }]);
        }
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Broad fallback' }, 'track', signal(), value => { if (value.items.length) published(); });
      assert.deepEqual(result.items.map(item => item.id), values.map(value => value.apple!.id));
      assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 3); assert.equal(result.unresolved, 0);
    });
    await t.test('an empty broad search is attempted only once per run before both exact fallbacks', async () => {
      const values = noCandidates.slice(1, 3); fixture('Empty broad', values);
      const base = handler; const previousFetch = globalThis.fetch; const searches: { term: string; started: number }[] = [];
      handler = (url, options) => {
        if (url.hostname === 'itunes.apple.com' && url.searchParams.get('term') === values[0].artist) return appleJson([]);
        return base(url, options);
      };
      globalThis.fetch = async (input, options) => {
        const url = new URL(String(input));
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/search')) return new Response('');
        calls.push(url);
        if (url.hostname === 'itunes.apple.com') searches.push({ term: url.searchParams.get('term')!, started: performance.now() });
        return handler(url, options);
      };
      try {
        const result = await recommendations({ ...seed, title: 'Empty broad' }, 'track', signal());
        assert.deepEqual(result.items.map(item => item.id), values.map(value => value.apple!.id));
        assert.deepEqual(searches.map(search => search.term), [`${values[0].artist} ${values[0].title}`, values[0].artist, `${values[1].artist} ${values[1].title}`]);
        for (let index = 1; index < searches.length; index++) assert.ok(searches[index].started - searches[index - 1].started >= 3090);
        assert.equal(result.unresolved, 0); assert.equal(result.providerUnavailable, false);
      } finally { globalThis.fetch = previousFetch; }
    });
    await t.test('an empty first exact query preserves the artist broad fallback and both verified songs', async () => {
      const values = noCandidates.slice(1, 3); fixture('Empty first exact', values); const base = handler;
      const exact = `${values[0].artist} ${values[0].title}`;
      handler = (url, options) => url.hostname === 'itunes.apple.com' && url.searchParams.get('term') === exact ? appleJson([]) : base(url, options);
      const result = await recommendations({ ...seed, title: 'Empty first exact' }, 'track', signal());
      assert.deepEqual(result.items.map(item => item.id), values.map(value => value.apple!.id));
      assert.deepEqual(calls.filter(url => url.hostname === 'itunes.apple.com').map(url => url.searchParams.get('term')), [exact, values[0].artist]);
      assert.equal(result.unresolved, 0);
    });
    await t.test('hybrid list cache honors provider no-store and isolates API key configuration', async () => {
      fixture('Hybrid cache', [noCandidates[1]]); const base = handler; let control = 'max-age=60';
      const key = 'e'.repeat(32);
      handler = (url, options) => url.hostname === 'ws.audioscrobbler.com' ? Response.json({ similartracks: { track: [
        { name: noCandidates[1].title, artist: { name: noCandidates[1].artist } }
      ] } }, { headers: { 'cache-control': control } }) : base(url, options);
      const current = { ...seed, title: 'Hybrid cache' };
      const first = await recommendations(current, 'track', signal(), undefined, key); const before = calls.length;
      assert.equal(first.items.length, 1); first.items[0].title = 'Caller mutation';
      const cached = await recommendations(current, 'track', signal(), value => { value.items[0].title = 'Callback mutation'; }, key);
      assert.equal(calls.length, before); assert.equal(cached.items[0].title, noCandidates[1].title);
      await recommendations(current, 'track', signal(), undefined, 'f'.repeat(32));
      assert.ok(calls.slice(before).some(url => url.hostname === 'ws.audioscrobbler.com' && url.searchParams.get('api_key') === 'f'.repeat(32)));
      fixture('Hybrid no-store', [noCandidates[1]]); control = 'no-store'; const noStoreBase = handler;
      handler = (url, options) => url.hostname === 'ws.audioscrobbler.com' ? Response.json({ similartracks: { track: [
        { name: noCandidates[1].title, artist: { name: noCandidates[1].artist } }
      ] } }, { headers: { 'cache-control': control } }) : noStoreBase(url, options);
      const fresh = { ...seed, title: 'Hybrid no-store' }; await recommendations(fresh, 'track', signal(), undefined, key); const next = calls.length;
      await recommendations(fresh, 'track', signal(), undefined, key);
      assert.ok(calls.slice(next).some(url => url.hostname === 'ws.audioscrobbler.com'));
      assert.equal(JSON.stringify(cached).includes(key), false);
    });
    await t.test('album artwork comes from the chosen edition and invalid artwork keeps the valid song', async () => {
      for (const valid of [true, false]) {
        const title = 'Artwork ' + valid; fixture(title, [noCandidates[1]]); const base = handler;
        handler = (url, options) => url.hostname === 'itunes.apple.com' ? appleJson([
          { ...noCandidates[1], ...noCandidates[1].apple!, artworkUrl: valid ? artwork : artwork + '?private=secret' },
          { ...noCandidates[1], ...noCandidates[1].apple!, id: '99999', album: noCandidates[1].album + ' (Deluxe Edition)', artworkUrl: artwork.replace('4050215331501', '4050215285248') }
        ]) : base(url, options);
        const result = await recommendations({ ...seed, title }, 'track', signal());
        assert.equal(result.items.length, 1); assert.equal(result.items[0].id, noCandidates[1].apple!.id);
        assert.equal(result.items[0].artworkUrl, valid ? artwork : undefined); assert.equal(result.providerUnavailable, false);
        assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 1);
        assert.equal(calls.filter(url => url.hostname === 'music.apple.com').length, 1);
        assert.equal(calls.some(url => url.hostname === 'is1-ssl.mzstatic.com'), false);
      }
    });
    await t.test('the expanded roster uses available candidates with or without Last.fm and cancels in-flight work', async () => {
      const values = Array.from({ length: 16 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        title: `Budget track ${index}`, artist: `Budget artist ${index}`, album: `Budget album ${index}`, length: 200000,
        apple: { id: String(97000 + index), albumId: String(98000 + index), durationMs: 200000 } }));
      for (const key of [undefined, 'invalid', 'b'.repeat(32)]) {
        const configured = key?.length === 32; const title = 'Budget ' + (key ? configured ? 'configured' : 'invalid' : 'absent'); fixture(title, values); const base = handler;
        handler = (url, options) => url.hostname === 'ws.audioscrobbler.com' ? Response.json({ similartracks: { track: [
          { name: values[0].title, mbid: values[0].id, artist: { name: values[0].artist } }
        ] } }, { headers: { 'cache-control': 'no-store' } }) : base(url, options);
        const result = await recommendations({ ...seed, title }, 'track', signal(), undefined, key);
        assert.equal(result.lastFmConfigured, configured); assert.equal(result.items.length, 16); assert.equal(result.cards?.length, 16);
        assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 16);
        assert.equal(calls.filter(url => url.hostname === 'music.apple.com').length, 16);
        assert.equal(calls.filter(url => url.hostname === 'ws.audioscrobbler.com').length, configured ? 1 : 0);
        if (configured) {
          fixture('Budget cancelled', values); const cancelBase = handler; const controller = new AbortController();
          handler = (url, options) => url.hostname === 'ws.audioscrobbler.com' ? Response.json({ similartracks: { track: [
            { name: values[0].title, mbid: values[0].id, artist: { name: values[0].artist } }
          ] } }, { headers: { 'cache-control': 'no-store' } }) : cancelBase(url, options);
          await assert.rejects(recommendations({ ...seed, title: 'Budget cancelled' }, 'track', controller.signal,
            progress => { if (progress.items.length === 8) controller.abort(); }, key), { name: 'AbortError' });
          assert.ok(calls.filter(url => url.hostname === 'itunes.apple.com').length <= 13);
          assert.ok(calls.filter(url => url.hostname === 'music.apple.com').length <= 13);
        }
      }
    });
    await t.test('one failed Apple candidate preserves other validated recommendations', async () => {
      fixture('Partial'); const base = handler;
      handler = (url, options) => url.hostname === 'music.apple.com' && url.pathname.endsWith('/1141108079') ? new Response(null, { status: 503 }) : base(url, options);
      const result = await recommendations({ ...seed, title: 'Partial' }, 'track', signal());
      assert.deepEqual(result.items.map(item => item.id), ['1525506968', '1525507116', '1141108077']);
      assert.equal(result.providerUnavailable, true); assert.equal(result.partial, true);
    });
    await t.test('one transient HTTP retry recovers each provider and emits only closed diagnostics', async () => {
      for (const provider of ['MusicBrainz', 'ListenBrainz', 'iTunes', 'Apple Music'] as const) {
        const title = 'Recover ' + provider; fixture(title, [noCandidates[1]]); const base = handler;
        const hostname = { MusicBrainz: 'musicbrainz.org', ListenBrainz: 'labs.api.listenbrainz.org', iTunes: 'itunes.apple.com', 'Apple Music': 'music.apple.com' }[provider];
        let failed = false; const diagnostics: RecommendationDiagnostic[] = [];
        handler = (url, options) => {
          if (url.hostname === hostname && !failed) { failed = true; return new Response(null, { status: provider === 'MusicBrainz' ? 503 : 500 }); }
          return base(url, options);
        };
        const result = await recommendations({ ...seed, title }, 'track', signal(), undefined, undefined, event => diagnostics.push(event));
        assert.equal(result.items.length, 1); assert.equal(result.providerUnavailable, false);
        const retry = diagnostics.find(event => event.outcome === 'reintento'); assert.ok(retry);
        assert.equal(retry.provider, provider); assert.equal(retry.failure, 'http'); assert.equal(retry.attempt, 1);
        assert.equal(retry.httpStatus, provider === 'MusicBrainz' ? 503 : 500);
        assert.ok(diagnostics.some(event => event.provider === provider && event.stage === retry.stage && event.outcome === 'respuesta' && event.attempt === 2));
        assert.ok(diagnostics.every(event => Object.keys(event).every(key => ['provider', 'stage', 'httpStatus', 'failure', 'attempt', 'outcome'].includes(key))));
        assert.equal(JSON.stringify(diagnostics).includes('https:'), false); assert.equal(JSON.stringify(diagnostics).includes(title), false);
      }
    });
    await t.test('network errors are retried below the provider without leaking an error URL or key', async () => {
      fixture('Network recover', [noCandidates[1]]); const base = handler; let failed = false; const diagnostics: RecommendationDiagnostic[] = [];
      handler = (url, options) => {
        if (url.hostname === 'musicbrainz.org' && !failed) { failed = true; throw new TypeError('https://private.example/?api_key=SECRET_VALUE'); }
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Network recover' }, 'track', signal(), undefined, undefined, event => diagnostics.push(event));
      assert.equal(result.items.length, 1); assert.equal(result.providerUnavailable, false);
      // La falla de red se reintenta en la lectura (network-retry.ts): el proveedor ve la respuesta al primer intento.
      assert.equal(failed, true); assert.equal(diagnostics.some(event => event.failure === 'red'), false);
      assert.equal(JSON.stringify(diagnostics).includes('SECRET_VALUE'), false); assert.equal(JSON.stringify(diagnostics).includes('private.example'), false);
    });
    await t.test('failed and empty results never block a fresh manual request for the same seed', async () => {
      fixture('Manual retry', [noCandidates[1]]); const base = handler;
      handler = (url, options) => url.hostname === 'musicbrainz.org' ? new Response(null, { status: 503 }) : base(url, options);
      const current = { ...seed, title: 'Manual retry' }; const diagnostics: RecommendationDiagnostic[] = [];
      const failed = await recommendations(current, 'track', signal(), undefined, undefined, event => diagnostics.push(event));
      assert.equal(failed.providerUnavailable, true); assert.equal(calls.length, 2);
      assert.deepEqual(diagnostics.map(event => [event.attempt, event.outcome]), [[1, 'reintento'], [2, 'fallo']]);
      handler = base; const before = calls.length;
      assert.equal((await recommendations(current, 'track', signal())).items.length, 1); assert.ok(calls.length > before);
      fixture('Empty retry', [noCandidates[1]]); const healthy = handler;
      handler = () => Response.json({ count: 0, artists: [], recordings: [] });
      const missing = { ...seed, title: 'Empty retry' };
      assert.equal((await recommendations(missing, 'track', signal())).items.length, 0);
      handler = healthy; assert.equal((await recommendations(missing, 'track', signal())).items.length, 1);
    });
    await t.test('HTTP 4xx and invalid JSON never trigger automatic retries', async () => {
      for (const status of [400, 401, 403, 404]) {
        fixture('No retry ' + status, [noCandidates[1]]); const base = handler; const diagnostics: RecommendationDiagnostic[] = [];
        handler = (url, options) => url.hostname === 'labs.api.listenbrainz.org' ? new Response(null, { status }) : base(url, options);
        assert.equal((await recommendations({ ...seed, title: 'No retry ' + status }, 'track', signal(), undefined, undefined, event => diagnostics.push(event))).providerUnavailable, true);
        assert.equal(calls.filter(url => url.hostname === 'labs.api.listenbrainz.org').length, 1);
        assert.ok(diagnostics.every(event => event.outcome !== 'reintento')); assert.equal(diagnostics.at(-1)?.httpStatus, status);
      }
      fixture('Invalid JSON', [noCandidates[1]]); const base = handler; const diagnostics: RecommendationDiagnostic[] = [];
      handler = (url, options) => url.hostname === 'labs.api.listenbrainz.org' ? new Response('{broken-json') : base(url, options);
      assert.equal((await recommendations({ ...seed, title: 'Invalid JSON' }, 'track', signal(), undefined, undefined, event => diagnostics.push(event))).providerUnavailable, true);
      assert.equal(calls.filter(url => url.hostname === 'labs.api.listenbrainz.org').length, 1); assert.equal(diagnostics.at(-1)?.failure, 'datos-invalidos');
      assert.ok(diagnostics.every(event => event.outcome !== 'reintento'));
    });
    await t.test('a provider timeout retries once while a caller abort stays cancelled', async context => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      fixture('Timeout recover', [noCandidates[1]]); const base = handler; let pending = true; const diagnostics: RecommendationDiagnostic[] = [];
      handler = (url, options) => {
        if (url.hostname === 'labs.api.listenbrainz.org' && pending) {
          pending = false;
          return new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Provider timeout', 'AbortError')), { once: true });
            queueMicrotask(() => context.mock.timers.tick(10000));
          });
        }
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Timeout recover' }, 'track', signal(), undefined, undefined, event => {
        diagnostics.push(event); if (event.outcome === 'reintento') queueMicrotask(() => context.mock.timers.tick(1100));
      });
      assert.equal(result.items.length, 1); assert.equal(result.providerUnavailable, false);
      assert.equal(diagnostics.find(event => event.outcome === 'reintento')?.failure, 'tiempo-agotado');
      assert.equal(calls.filter(url => url.hostname === 'labs.api.listenbrainz.org').length, 2);
    });
    await t.test('cancellation during the retry wait stops the second request and late diagnostics', async () => {
      fixture('Cancel retry', [noCandidates[1]]); const base = handler; const controller = new AbortController(); const diagnostics: RecommendationDiagnostic[] = [];
      handler = (url, options) => url.hostname === 'labs.api.listenbrainz.org' ? new Response(null, { status: 503 }) : base(url, options);
      await assert.rejects(recommendations({ ...seed, title: 'Cancel retry' }, 'track', controller.signal, undefined, undefined, event => {
        diagnostics.push(event); if (event.outcome === 'reintento') controller.abort();
      }), { name: 'AbortError' });
      assert.equal(calls.filter(url => url.hostname === 'labs.api.listenbrainz.org').length, 1);
      assert.equal(diagnostics.at(-1)?.outcome, 'reintento'); assert.equal(diagnostics.some(event => event.attempt === 2), false);
    });
    await t.test('all exact recording seeds use repeated parameters and keep track affinity distinct from artist affinity', async () => {
      calls.length = 0; now += 1000000; const relatedId = '3bcff06f-675a-451f-9075-99e8657047e8';
      const relatedSong = { ...song, id: '1288518126', albumId: '1288517633', artist: 'Four Tet', title: 'Two Thousand and Seventeen', album: 'New Energy' };
      const trackSong = { ...relatedSong, id: '1288518127', title: 'Track related song' };
      handler = url => {
        if (url.pathname === '/ws/2/recording') return url.searchParams.get('query')?.startsWith('rid:') ?
          Response.json({ count: 1, recordings: [recording(noCandidates[1].id, trackSong.title, trackSong.artist, trackSong.album, trackSong.durationMs)] }) :
          Response.json({ count: 2, recordings: [recording(seedId, 'Multiple exact IDs', seed.artist, seed.album), recording(relatedId, 'Multiple exact IDs', seed.artist, seed.album)] });
        if (url.pathname === '/ws/2/artist') return Response.json({ count: 2, artists: [{ id: artistId, name: seed.artist }, { id: relatedId, name: 'Nicolás Jaar Group' }] });
        if (url.hostname === 'labs.api.listenbrainz.org') {
          if (url.pathname === '/similar-recordings/json') {
            assert.deepEqual(url.searchParams.getAll('recording_mbids'), [seedId, relatedId]);
            return Response.json([
              ...[seedId, relatedId].map(reference_mbid => ({ reference_mbid, recording_mbid: noCandidates[1].id, recording_name: trackSong.title, artist_credit_name: trackSong.artist, release_name: trackSong.album })),
              { reference_mbid: noCandidates[0].id, recording_mbid: noCandidates[2].id, recording_name: 'Foreign cohort', artist_credit_name: 'Wrong artist' }
            ]);
          }
          assert.equal(url.pathname, '/similar-artists/json'); assert.equal(url.searchParams.get('artist_mbids'), artistId);
          return Response.json([{ artist_mbid: relatedId, name: 'Four Tet', reference_mbid: artistId }]);
        }
        if (url.hostname === 'itunes.apple.com') return appleJson([trackSong, relatedSong]);
        return new Response(songHtml(url.pathname.endsWith('/' + trackSong.id) ? trackSong : relatedSong));
      };
      const current = { ...seed, title: 'Multiple exact IDs' };
      const track = await recommendations(current, 'track', signal());
      assert.equal(track.artistFallback, false); assert.deepEqual(track.items.map(item => item.id), [trackSong.id]); assert.equal(track.items[0].signal, 'track');
      const artist = await recommendations(current, 'artist', signal());
      assert.equal(artist.items[0]?.signal, 'artist'); assert.ok(artist.items.some(item => item.id === relatedSong.id));
      assert.ok(!track.cards?.some(card => card.title === 'Foreign cohort'));
      assert.equal(calls.filter(url => url.pathname === '/similar-recordings/json').length, 1);
    });
    await t.test('homonymous artists and full collaboration credits remain unresolved', async () => {
      calls.length = 0; now += 100000;
      handler = url => url.pathname === '/ws/2/recording' ? Response.json({ count: 1, recordings: [recording(seedId, 'Collaboration', 'Nicolas Jaar featuring Guest', seed.album)] }) :
        Response.json({ count: 2, artists: [{ id: artistId, name: seed.artist }, { id: seedId, name: seed.artist }] });
      const result = await recommendations({ ...seed, title: 'Collaboration' }, 'track', signal());
      assert.equal(result.items.length, 0); assert.equal(result.artistFallback, true);
      assert.ok(calls.every(url => url.hostname === 'musicbrainz.org'));
    });
    await t.test('homonymous artists require a unique public album corroboration; missing or failing evidence is explicit', async () => {
      const other = '3bcff06f-675a-451f-9075-99e8657047e8';
      const relatedSong: Song = { ...song, id: '91999', albumId: '91888', title: 'Related title', artist: 'Related artist', album: 'Related album' };
      const outcomes = ['one', 'two', 'error', 'nested', 'incomplete', 'wrong-album-credit', 'wrong-artist-id', 'redirect'];
      for (const outcome of outcomes) {
        calls.length = 0; now += 100000; const title = `Identity ${outcome}`, albumId = String(93000 + outcomes.indexOf(outcome));
        handler = url => {
          if (url.pathname === '/ws/2/artist') return Response.json({ count: outcome === 'incomplete' ? 3 : 2, artists: [{ id: artistId, name: seed.artist }, { id: other, name: seed.artist }] });
          if (url.pathname.startsWith('/ws/2/artist/')) {
            const isOther = url.pathname.endsWith(other);
            if (isOther && outcome === 'error') return new Response(null, { status: 503 });
            return Response.json({ id: isOther ? other : artistId, name: seed.artist, relations: isOther && outcome !== 'two' ? [] : [{ url: { resource: 'https://itunes.apple.com/us/artist/id274067889' } }] });
          }
          if (url.hostname === 'music.apple.com' && url.pathname.includes('/artist/')) {
            if (outcome === 'redirect') return new Response(null, { status: 301, headers: { location: 'https://music.apple.com/us/artist/274067889' } });
            return new Response(artistHtml('274067889', albumId, seed.artist, title, 'ar', outcome === 'nested' ? { sections: [{ items: [{ title: seed.artist, contentDescriptor: { kind: 'artist', identifiers: { storeAdamID: '274067889' } } }] }, { items: [] }] } : {}));
          }
          if (url.hostname === 'music.apple.com' && url.pathname.includes('/album/')) return new Response(albumIdentityHtml(albumId, title, outcome === 'wrong-album-credit' ? 'Other artist' : seed.artist, outcome === 'wrong-artist-id' ? '999' : '274067889'));
          if (url.hostname === 'labs.api.listenbrainz.org') return Response.json([{ artist_mbid: seedId, name: relatedSong.artist, reference_mbid: artistId }]);
          if (url.hostname === 'itunes.apple.com') return appleJson([relatedSong]);
          return new Response(songHtml(relatedSong));
        };
        const result = await recommendations({ ...seed, title: 'Missing current recording', album: title }, 'artist', signal());
        assert.equal(result.items.length, outcome === 'one' ? 1 : 0);
        if (outcome === 'one') assert.equal(result.items[0].signal, 'artist');
        else assert.equal(calls.some(url => url.hostname === 'labs.api.listenbrainz.org'), false);
        if (['error', 'redirect'].includes(outcome)) assert.equal(result.providerUnavailable, true);
        else if (outcome !== 'one') assert.equal(result.emptyReason, 'unresolved-seed');
      }
    });
    await t.test('wrong MB entity type never becomes a recording or artist seed', async () => {
      calls.length = 0; now += 100000; handler = () => Response.json({ count: 1, releases: [recording(seedId, 'Wrong entity', seed.artist, seed.album)] });
      const result = await recommendations({ ...seed, title: 'Wrong entity' }, 'track', signal());
      assert.equal(result.items.length, 0); assert.ok(calls.every(url => url.hostname === 'musicbrainz.org'));
    });
    await t.test('cancellation stops before Apple resolution and does not become a cached error', async () => {
      fixture('Cancel'); const controller = new AbortController();
      await assert.rejects(recommendations({ ...seed, title: 'Cancel' }, 'track', controller.signal, () => controller.abort()), { name: 'AbortError' });
      assert.equal(calls.some(url => url.hostname === 'itunes.apple.com'), false);
      fixture('Cancel'); assert.equal((await recommendations({ ...seed, title: 'Cancel' }, 'track', signal())).items.length, 4);
      const already = new AbortController(); already.abort(); const before = calls.length;
      await assert.rejects(recommendations(seed, 'track', already.signal), { name: 'AbortError' }); assert.equal(calls.length, before);
    });
    await t.test('Apple redirects cannot change the country, ID or origin', async () => {
      fixture('Redirect', [noCandidates[1]]); const base = handler;
      handler = (url, options) => url.hostname === 'music.apple.com' ? new Response(null, { status: 301, headers: { location: 'https://music.apple.com/us/song/1141108079' } }) : base(url, options);
      const result = await recommendations({ ...seed, title: 'Redirect' }, 'track', signal());
      assert.equal(result.items.length, 0); assert.equal(result.providerUnavailable, true); assert.equal(calls.filter(url => url.hostname === 'music.apple.com').length, 1);
    });
    await t.test('artist fallback limits expansion and keeps successful artists after a provider error', async () => {
      calls.length = 0; now += 100000;
      const artists = ['First Artist', 'Broken Artist', 'Third Artist', 'Fourth Artist'];
      const ids = noCandidates.slice(0, 4).map(value => value.id);
      const found: Song[] = [1, 2, 3].map(index => ({ ...song, id: String(90000 + index), title: `Public song ${index}`, artist: artists[0], album: 'Public album' }));
      handler = url => {
        if (url.pathname === '/ws/2/artist') return Response.json({ count: 1, artists: [{ id: artistId, name: seed.artist }] });
        if (url.hostname === 'labs.api.listenbrainz.org') return Response.json(artists.map((name, index) => ({ reference_mbid: artistId, artist_mbid: ids[index], name })));
        if (url.hostname === 'itunes.apple.com') {
          const name = url.searchParams.get('term');
          if (name === artists[1]) return new Response(null, { status: 503 });
          return appleJson(name === artists[0] ? found : [{ ...found[0], id: name === artists[2] ? '90010' : '90011', artist: name === artists[2] ? artists[2] : artists[3] }]);
        }
        const value = url.pathname.endsWith('/90010') ? { ...found[0], id: '90010', artist: artists[2] } : url.pathname.endsWith('/90011') ? { ...found[0], id: '90011', artist: artists[3] } : found.find(item => url.pathname.endsWith('/' + item.id));
        assert.ok(value); return new Response(songHtml(value));
      };
      const result = await recommendations({ ...seed, title: 'Artist partial' }, 'artist', signal());
      assert.deepEqual(result.items.map(item => item.id), ['90001', '90002', '90003', '90010', '90011']);
      assert.ok(result.items.every(item => item.signal === 'artist')); assert.equal(result.providerUnavailable, true);
      assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 5);
      assert.equal(new Set(calls.filter(url => url.hostname === 'itunes.apple.com').map(url => url.searchParams.get('term'))).size, 4);
    });
    await t.test('optional Last.fm preserves published card order and never exports the own key', async () => {
      fixture('Hybrid', noCandidates.slice(1, 4)); const base = handler; const key = '0123456789abcdef0123456789abcdef';
      const lastFmSong = { ...song, id: '91000', title: 'Other song', artist: 'Other Artist', album: 'Other Album' };
      handler = (url, options) => {
        if (url.hostname === 'ws.audioscrobbler.com') {
          assert.equal(url.pathname, '/2.0/'); assert.equal(url.searchParams.get('api_key'), key);
          assert.equal(url.searchParams.get('method'), 'track.getSimilar');
          return Response.json({ similartracks: { track: [{ name: lastFmSong.title, artist: { name: lastFmSong.artist } }] } }, { headers: { 'cache-control': 'no-store' } });
        }
        if (url.hostname === 'itunes.apple.com' && url.searchParams.get('term') === `${lastFmSong.artist} ${lastFmSong.title}`) return appleJson([lastFmSong]);
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/' + lastFmSong.id)) return new Response(songHtml(lastFmSong));
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Hybrid' }, 'track', signal(), undefined, key);
      assert.equal(result.items.filter(item => item.source === 'ListenBrainz').length, 3); assert.equal(result.items.filter(item => item.source === 'Last.fm').length, 1);
      assert.equal(result.lastFmConfigured, true); assert.equal(JSON.stringify(result).includes(key), false);
      assert.equal(result.items.find(item => item.source === 'Last.fm')?.sourceUrl, 'https://www.last.fm/music/Other%20Artist/_/Other%20song');
      assert.ok(result.items.every(item => !item.recordingIdentityVerified));
    });
    await t.test('hybrid results deduplicate compatible editions when Last.fm precedes the recording MBID', async () => {
      const a = noCandidates[1], b = noCandidates[2];
      const deluxe = { ...b, album: b.album + ' (Deluxe Edition)', apple: { ...b.apple!, id: '91002' } };
      fixture('Hybrid editions', [a, deluxe]); const base = handler;
      const standardSong: Song = { ...b, ...b.apple! }, deluxeSong: Song = { ...deluxe, ...deluxe.apple };
      handler = (url, options) => {
        if (url.hostname === 'ws.audioscrobbler.com') return Response.json({ similartracks: { track: [{ name: b.title, artist: { name: b.artist } }] } }, { headers: { 'cache-control': 'no-store' } });
        if (url.hostname === 'itunes.apple.com' && url.searchParams.get('term') === `${b.artist} ${b.title}`) return appleJson([standardSong, deluxeSong]);
        if (url.hostname === 'music.apple.com' && url.pathname.endsWith('/' + standardSong.id)) return new Response(songHtml(standardSong));
        return base(url, options);
      };
      const result = await recommendations({ ...seed, title: 'Hybrid editions' }, 'track', signal(), undefined, 'a'.repeat(32));
      assert.equal(result.items.length, 2); assert.ok(result.items.some(item => item.id === a.apple!.id));
      assert.equal(result.items.filter(item => item.title === b.title).length, 1);
      assert.equal(result.cards?.filter(card => card.title === b.title).length, 1);
    });
    await t.test('iTunes Retry-After stops later requests while keeping prior public results', async () => {
      fixture('Rate limited', noCandidates.slice(1, 4)); const base = handler; let searches = 0;
      handler = (url, options) => url.hostname === 'itunes.apple.com' && ++searches === 2 ?
        new Response(null, { status: 429, headers: { 'retry-after': '100' } }) : base(url, options);
      const result = await recommendations({ ...seed, title: 'Rate limited' }, 'track', signal());
      assert.deepEqual(result.items.map(item => item.id), ['1141108079']); assert.equal(result.providerUnavailable, true);
      assert.equal(calls.filter(url => url.hostname === 'itunes.apple.com').length, 2);
    });
    await t.test('MusicBrainz 429 remains under its shared cooldown even after a manual retry', async () => {
      fixture('MB rate limited', [noCandidates[1]]); const base = handler; const diagnostics: RecommendationDiagnostic[] = [];
      handler = (url, options) => url.hostname === 'musicbrainz.org' ? new Response(null, { status: 429, headers: { 'retry-after': '60' } }) : base(url, options);
      const current = { ...seed, title: 'MB rate limited' };
      assert.equal((await recommendations(current, 'track', signal(), undefined, undefined, event => diagnostics.push(event))).providerUnavailable, true);
      assert.equal(calls.length, 1); assert.equal(diagnostics.at(-1)?.failure, 'limite'); assert.equal(diagnostics.at(-1)?.httpStatus, 429);
      assert.equal((await recommendations(current, 'track', signal(), undefined, undefined, event => diagnostics.push(event))).providerUnavailable, true);
      assert.equal(calls.length, 1); assert.ok(diagnostics.every(event => event.outcome !== 'reintento'));
    });
    await t.test('oversized public bodies fail closed and no invalid seed triggers a request', async () => {
      fixture('Large'); const base = handler;
      handler = (url, options) => url.hostname === 'labs.api.listenbrainz.org' ? new Response(new Uint8Array(5 * 1024 * 1024 + 1)) : base(url, options);
      const result = await recommendations({ ...seed, title: 'Large' }, 'track', signal());
      assert.equal(result.providerUnavailable, true); assert.equal(calls.some(url => url.hostname === 'itunes.apple.com'), false);
      const before = calls.length;
      for (const bad of [{ country: 'AR' }, { title: 'x'.repeat(241) }, { artist: '\u0000Guest' }]) await assert.rejects(recommendations({ ...seed, ...bad }, 'track', signal()), /INVALID_RECOMMENDATION_SEED/);
      assert.equal(calls.length, before);
    });
  } finally { globalThis.fetch = original; }
});
