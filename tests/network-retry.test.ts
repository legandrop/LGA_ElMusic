import test from 'node:test';
import assert from 'node:assert/strict';
import { isChromiumNetworkError, networkRetry, withNetworkRetries } from '../src/network-retry';

networkRetry.delayMs = 5;
const network = (error: unknown): boolean => error instanceof Error && error.message === 'blocked';

test('una falla de red se reintenta 3 veces y el cuarto intento puede salir bien', async () => {
  let calls = 0; const retries: number[] = [];
  const value = await withNetworkRetries(async () => { calls++; if (calls < 4) throw new Error('blocked'); return 'ok'; }, network,
    { onRetry: attempt => retries.push(attempt) });
  assert.equal(value, 'ok'); assert.equal(calls, 4); assert.deepEqual(retries, [1, 2, 3]);
});

test('después de 3 reintentos la falla de red llega a quien llamó', async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetries(async () => { calls++; throw new Error('blocked'); }, network), /blocked/);
  assert.equal(calls, 4);
});

test('lo que no es una falla de red no se reintenta', async () => {
  let calls = 0;
  await assert.rejects(withNetworkRetries(async () => { calls++; throw new Error('HTTP 404'); }, network), /HTTP 404/);
  assert.equal(calls, 1);
});

test('una cancelación durante la espera corta los reintentos', async () => {
  const controller = new AbortController(); let calls = 0;
  const saved = networkRetry.delayMs; networkRetry.delayMs = 200;
  try {
    const pending = withNetworkRetries(async () => { calls++; throw new Error('blocked'); }, network, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('cancelled')), 20);
    await assert.rejects(pending, /cancelled/); assert.equal(calls, 1);
  } finally { networkRetry.delayMs = saved; }
});

test('los errores de conexión de Chromium se reintentan; ERR_ABORTED y los de certificado no', () => {
  for (const code of ['ERR_NETWORK_ACCESS_DENIED', 'ERR_CONNECTION_REFUSED', 'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT']) {
    assert.equal(isChromiumNetworkError(Object.assign(new Error(code), { code })), true, code);
  }
  for (const code of ['ERR_ABORTED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_BLOCKED_BY_CLIENT', undefined, 42]) {
    assert.equal(isChromiumNetworkError(Object.assign(new Error('x'), { code })), false, String(code));
  }
  assert.equal(isChromiumNetworkError('ERR_CONNECTION_REFUSED'), false);
});
