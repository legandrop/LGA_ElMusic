import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLastFmKey } from '../src/lastfm';
import { networkRetry } from '../src/network-retry';
// Las fallas de red simuladas se reintentan sin la espera real de 5 s.
networkRetry.delayMs = 1;

const fixture = 'a'.repeat(32); // Clave ficticia, no una credencial.
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status });
test('key validation uses only the fixed anonymous read endpoint and an explicit single result', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, 'https://ws.audioscrobbler.com'); assert.equal(url.pathname, '/2.0/');
      assert.equal(url.searchParams.get('method'), 'artist.getTopTracks'); assert.equal(url.searchParams.get('artist'), 'Cher');
      assert.equal(url.searchParams.get('limit'), '1'); assert.equal(options?.redirect, 'manual'); assert.equal(options?.credentials, 'omit');
      return json({ toptracks: { track: [] } });
    };
    await validateLastFmKey(fixture);
  } finally { globalThis.fetch = original; }
});
test('invalid/suspended keys are distinguished even on HTTP errors, without provider echoes', async () => {
  const original = globalThis.fetch;
  try {
    for (const [status, code] of [[200, 10], [403, 10], [403, 26]]) {
      globalThis.fetch = async () => json({ error: code, message: fixture }, status);
      await assert.rejects(validateLastFmKey(fixture), error => error instanceof Error && error.message === 'LASTFM_KEY_REJECTED');
    }
    globalThis.fetch = async () => { throw new Error(fixture); };
    await assert.rejects(validateLastFmKey(fixture), { message: 'LASTFM_UNAVAILABLE' });
    globalThis.fetch = async () => json({ unknown: true });
    await assert.rejects(validateLastFmKey(fixture), { message: 'LASTFM_UNAVAILABLE' });
  } finally { globalThis.fetch = original; }
});
test('invalid syntax and pre-cancelled validation make zero requests', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return json({ toptracks: {} }); };
    await assert.rejects(validateLastFmKey('invalid'), { message: 'LASTFM_KEY_REJECTED' });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(validateLastFmKey(fixture, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test('a blocked connection to Last.fm is retried 3 times before failing', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; if (calls < 4) throw new TypeError('blocked by firewall'); return json({ toptracks: { track: [] } }); };
    await validateLastFmKey(fixture); assert.equal(calls, 4);
    calls = 0; globalThis.fetch = async () => { calls++; throw new TypeError('blocked by firewall'); };
    await assert.rejects(validateLastFmKey(fixture)); assert.equal(calls, 4);
  } finally { globalThis.fetch = original; }
});
