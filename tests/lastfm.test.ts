import test from 'node:test';
import assert from 'node:assert/strict';
import { lastFmCandidates } from '../src/lastfm';
import type { RecommendationSeed } from '../src/recommendation-types';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

const fakeKey = '0123456789abcdef0123456789abcdef'; // Fixture inventada, nunca una credencial real.
const seed: RecommendationSeed = { title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', country: 'ar' };
function response(data: unknown, control?: string): Response { return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...(control ? { 'Cache-Control': control } : {}) } }); }
function track(name = 'Related song'): Record<string, unknown> { return { name, artist: { name: 'Public artist' }, url: 'https://evil.test/?api_key=not-a-real-key' }; }

test('no API key means zero requests and no provider failure', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('not called'); };
    for (const key of [undefined, '', 'not-a-key']) assert.deepEqual(await lastFmCandidates(seed, 'track', key), { candidates: [], configured: false, unavailable: false, cacheForMs: 0 });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('HTTP 200 API errors are unavailable and never expose provider messages or API keys', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return response({ error: 10, message: 'provider echo ' + fakeKey }); };
    const result = await lastFmCandidates(seed, 'track', fakeKey);
    assert.equal(result.configured, true); assert.equal(result.unavailable, true); assert.equal(result.cacheForMs, 0); assert.deepEqual(result.candidates, []);
    assert.equal(JSON.stringify(result).includes(fakeKey), false); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('requests stay anonymous on the fixed endpoint and candidate URLs cannot redirect to arbitrary hosts', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://ws.audioscrobbler.com'); assert.equal(url.pathname, '/2.0/'); assert.equal(url.searchParams.get('method'), 'track.getSimilar');
      assert.equal(url.searchParams.get('autocorrect'), '0'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
      assert.equal(new Headers(options?.headers).has('authorization'), false);
      return response({ similartracks: { track: [track(), track('provider echo ' + fakeKey)] } });
    };
    const result = await lastFmCandidates(seed, 'track', fakeKey);
    assert.equal(result.candidates[0].sourceUrl, 'https://www.last.fm/music/Public%20artist/_/Related%20song');
    assert.equal(result.candidates[0].signal, 'track'); assert.equal(result.candidates.length, 1); assert.equal(result.cacheForMs, 0); assert.equal(JSON.stringify(result).includes(fakeKey), false);
  } finally { globalThis.fetch = original; }
});
test('artist mode limits expansion and rejects contradictory artist credits', async () => {
  const original = globalThis.fetch; const methods: string[] = [];
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input)); const method = url.searchParams.get('method')!; methods.push(method);
      if (method === 'artist.getSimilar') return response({ similarartists: { artist: Array.from({ length: 4 }, (_, index) => ({ name: 'Artist ' + index })) } });
      return response({ toptracks: { track: [ { name: 'Contradiction', artist: { name: 'Other artist' } }, ...Array.from({ length: 7 }, (_, index) => ({ name: 'Song ' + index })) ] } });
    };
    const result = await lastFmCandidates({ ...seed, title: 'Artist mode fixture' }, 'artist', fakeKey);
    assert.deepEqual(methods, ['artist.getSimilar', ...Array(4).fill('artist.getTopTracks')]);
    assert.equal(result.candidates.length, 12); assert.ok(result.candidates.every(item => item.signal === 'artist' && item.title !== 'Contradiction'));
    assert.equal(result.candidates.some(item => item.artist === 'Artist 3'), true);
  } finally { globalThis.fetch = original; }
});

test('artist candidates arrive before later artists finish and callback mutations cannot corrupt them', async () => {
  const original = globalThis.fetch; let release!: () => void; let published!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = new Promise<void>(resolve => { published = resolve; });
  const controller = new AbortController(); let late = 0;
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.searchParams.get('method') === 'artist.getSimilar') return response({ similarartists: { artist: [{ name: 'Early artist' }, { name: 'Late artist' }] } });
      if (url.searchParams.get('artist') === 'Late artist') await blocked;
      return response({ toptracks: { track: [{ name: 'Progress track' }] } });
    };
    const operation = lastFmCandidates({ ...seed, title: 'Progress fixture' }, 'artist', fakeKey, controller.signal, value => {
      if (controller.signal.aborted) late++;
      if (value.candidates.length) { assert.equal(value.candidates[0].title, 'Progress track'); value.candidates[0].title = 'Caller mutation'; published(); }
    });
    try {
      await first; controller.abort(); release(); await assert.rejects(operation, { name: 'AbortError' }); assert.equal(late, 0);
    } finally { controller.abort(); release(); await operation.catch(() => {}); }
  } finally { globalThis.fetch = original; }
});
test('one unavailable artist does not discard later artists or cache an incomplete expansion', async () => {
  const original = globalThis.fetch; const artists: string[] = [];
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      if (url.searchParams.get('method') === 'artist.getSimilar') return response({ similarartists: { artist: [{ name: 'First artist' }, { name: 'Broken artist' }, { name: 'Later artist' }] } }, 'max-age=60');
      const name = url.searchParams.get('artist')!; artists.push(name);
      if (name === 'Broken artist') return new Response(null, { status: 503 });
      return response({ toptracks: { track: [{ name: 'A useful song' }] } }, 'max-age=60');
    };
    const result = await lastFmCandidates({ ...seed, artist: 'Partial expansion seed' }, 'artist', fakeKey);
    assert.deepEqual(artists, ['First artist', 'Broken artist', 'Later artist']);
    assert.deepEqual(result.candidates.map(item => item.artist), ['First artist', 'Later artist']);
    assert.equal(result.unavailable, true); assert.equal(result.cacheForMs, 0);
  } finally { globalThis.fetch = original; }
});
test('all redirects and oversized bodies stop without forwarding the key', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://evil.test/' } }); };
    assert.equal((await lastFmCandidates(seed, 'track', fakeKey)).unavailable, true); assert.equal(calls, 1);
    globalThis.fetch = async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1));
    assert.equal((await lastFmCandidates(seed, 'track', fakeKey)).unavailable, true);
  } finally { globalThis.fetch = original; }
});
test('empty track similarity falls back to ordered artist affinity, not a claimed track match', async () => {
  const original = globalThis.fetch; const methods: string[] = []; const started: number[] = [];
  try {
    globalThis.fetch = async input => {
      const url = new URL(String(input)); const method = url.searchParams.get('method')!; methods.push(method); started.push(performance.now());
      if (method === 'track.getSimilar') return response({ similartracks: { track: [] } }, 'max-age=60');
      if (method === 'artist.getSimilar') return response({ similarartists: { artist: [{ name: 'First artist' }, { name: 'Second artist' }] } }, 'max-age=120');
      return response({ toptracks: { track: [{ name: 'First track' }, { name: 'Second track' }] } }, 'max-age=30');
    };
    const result = await lastFmCandidates(seed, 'track', fakeKey);
    assert.deepEqual(methods, ['track.getSimilar', 'artist.getSimilar', 'artist.getTopTracks', 'artist.getTopTracks']);
    assert.deepEqual(result.candidates.map(item => [item.artist, item.title, item.signal, item.rank]), [
      ['First artist', 'First track', 'artist', 1], ['First artist', 'Second track', 'artist', 2], ['Second artist', 'First track', 'artist', 3], ['Second artist', 'Second track', 'artist', 4]
    ]);
    for (let index = 1; index < started.length; index++) assert.ok(started[index] - started[index - 1] >= 1090);
    assert.ok(result.cacheForMs > 0 && result.cacheForMs <= 30000);
  } finally { globalThis.fetch = original; }
});
test('an empty editorial remaster seed retries the base title and keeps track affinity distinct from artist affinity', async () => {
  const original = globalThis.fetch; const queries: string[] = [];
  try {
    for (const [title, base] of [['Teardrop (2006 Remastered)', 'Teardrop'], ['Psycho Killer (2024 Remaster)', 'Psycho Killer']]) {
      queries.length = 0;
      globalThis.fetch = async input => {
        const url = new URL(String(input)), method = url.searchParams.get('method')!, queried = url.searchParams.get('track')!;
        queries.push(method === 'track.getSimilar' ? queried : method);
        assert.equal(url.searchParams.get('autocorrect'), '0');
        if (method === 'track.getSimilar') return response({ similartracks: { '@attr': { artist: seed.artist, track: queried }, track: queried === title ? [] : [track('Track affinity result')] } });
        if (method === 'artist.getSimilar') return response({ similarartists: { '@attr': { artist: seed.artist }, artist: [{ name: 'Other artist' }] } });
        return response({ toptracks: { track: [{ name: 'Artist affinity result' }] } });
      };
      const current = { ...seed, title };
      const result = await lastFmCandidates(current, 'track', fakeKey);
      assert.deepEqual(queries, [title, base]); assert.equal(result.unavailable, false);
      assert.equal(result.candidates[0]?.signal, 'track'); assert.equal(result.candidates[0]?.title, 'Track affinity result'); assert.equal(current.title, title);
      const artist = await lastFmCandidates(current, 'artist', fakeKey);
      assert.equal(artist.candidates[0]?.signal, 'artist'); assert.equal(artist.candidates[0]?.title, 'Artist affinity result');
    }
  } finally { globalThis.fetch = original; }
});
test('live remix and acoustic seed titles are never stripped and mismatched response scopes are rejected', async () => {
  const original = globalThis.fetch;
  try {
    for (const title of ['Scope fixture (Live)', 'Scope fixture (Remix)', 'Scope fixture (Acoustic)']) {
      const queried: string[] = [];
      globalThis.fetch = async input => {
        const url = new URL(String(input));
        if (url.searchParams.get('method') === 'artist.getSimilar') return response({ similarartists: { artist: [] } });
        queried.push(url.searchParams.get('track')!); return response({ similartracks: { track: [] } });
      };
      const result = await lastFmCandidates({ ...seed, title }, 'track', fakeKey);
      assert.deepEqual(queried, [title]); assert.equal(result.candidates.length, 0);
    }
    for (const invalid of ['artist', 'track']) {
      let requests = 0; const title = 'Wrong scope ' + invalid;
      globalThis.fetch = async () => { requests++; return response({ similartracks: { '@attr': { artist: invalid === 'artist' ? 'Another artist' : seed.artist, track: invalid === 'track' ? 'Another song' : title }, track: [track('Unsafe result')] } }); };
      const result = await lastFmCandidates({ ...seed, title }, 'track', fakeKey);
      assert.equal(result.unavailable, true); assert.equal(result.candidates.length, 0); assert.equal(requests, 1);
    }
  } finally { globalThis.fetch = original; }
});
test('cache follows response expiry, clamps output size and returns independent candidate objects', async () => {
  const original = globalThis.fetch; let calls = 0;
  const cachedSeed = { ...seed, title: 'Cache fixture' };
  try {
    globalThis.fetch = async () => { calls++; return response({ similartracks: { track: Array.from({ length: 30 }, (_, index) => track('Song ' + index)) } }, 'public, max-age=60'); };
    const first = await lastFmCandidates(cachedSeed, 'track', fakeKey); assert.equal(first.candidates.length, 30); assert.ok(first.cacheForMs > 0 && first.cacheForMs <= 60000);
    first.candidates[0].title = 'mutation';
    const second = await lastFmCandidates(cachedSeed, 'track', fakeKey); assert.equal(second.candidates[0].title, 'Song 0'); assert.equal(calls, 1);
    const noStoreSeed = { ...seed, title: 'No store fixture' };
    globalThis.fetch = async () => { calls++; return response({ similartracks: { track: [track()] } }, 'no-store, max-age=60'); };
    assert.equal((await lastFmCandidates(noStoreSeed, 'track', fakeKey)).cacheForMs, 0);
    globalThis.fetch = async () => response({ similartracks: { track: [track()] } }, 'max-age=3600');
    const capped = await lastFmCandidates({ ...seed, title: 'TTL cap fixture' }, 'track', fakeKey);
    assert.ok(capped.cacheForMs > 0 && capped.cacheForMs <= 900000);
  } finally { globalThis.fetch = original; }
});
test('aborting a queued seed rejects promptly without requesting that obsolete seed', async () => {
  const original = globalThis.fetch; let calls = 0; let release!: () => void; let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  try {
    globalThis.fetch = async () => { calls++; started(); await new Promise<void>(resolve => { release = resolve; }); return response({ similartracks: { track: [track()] } }); };
    const first = lastFmCandidates({ ...seed, title: 'Current seed' }, 'track', fakeKey); await pending;
    const controller = new AbortController(); const second = lastFmCandidates({ ...seed, title: 'Obsolete seed' }, 'track', fakeKey, controller.signal);
    const before = performance.now(); controller.abort(); await assert.rejects(second, { name: 'AbortError' }); assert.ok(performance.now() - before < 200); assert.equal(calls, 1);
    release(); await first;
  } finally { release?.(); globalThis.fetch = original; }
});
test('HTTP 429 returns unavailable and honors the provider cooldown without retrying', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 429, headers: { 'Retry-After': '30' } }); };
    assert.equal((await lastFmCandidates({ ...seed, title: 'Rate fixture' }, 'artist', fakeKey)).unavailable, true);
    assert.equal((await lastFmCandidates({ ...seed, title: 'Next rate fixture' }, 'track', fakeKey)).unavailable, true); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
