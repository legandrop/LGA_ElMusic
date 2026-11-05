import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForWidevine } from '../src/widevine';

const fast = { timeoutMs: 200, delayMs: 5 };

test('Widevine: un fallo pasajero se reintenta hasta 3 veces y el cuarto intento puede salir bien', async () => {
  let calls = 0; const retries: number[] = [];
  await waitForWidevine({ ...fast, stopped: () => false, onRetry: attempt => retries.push(attempt),
    whenReady: async () => { calls++; if (calls < 4) throw new Error('blocked'); } });
  assert.equal(calls, 4); assert.deepEqual(retries, [1, 2, 3]);
});

test('Widevine: después de 3 reintentos se muestra el error', async () => {
  let calls = 0;
  await assert.rejects(waitForWidevine({ ...fast, stopped: () => false, onRetry: () => undefined,
    whenReady: async () => { calls++; throw new Error('blocked'); } }), /blocked/);
  assert.equal(calls, 4);
});

test('Widevine: un intento que agota su tiempo no se repite', async () => {
  let calls = 0;
  await assert.rejects(waitForWidevine({ ...fast, timeoutMs: 20, stopped: () => false, onRetry: () => undefined,
    whenReady: () => { calls++; return new Promise(() => undefined); } }), /WIDEVINE_TIMEOUT/);
  assert.equal(calls, 1);
});

test('Widevine: si la app se está cerrando no se reintenta', async () => {
  let calls = 0; let stopping = false;
  await assert.rejects(waitForWidevine({ ...fast, stopped: () => stopping, onRetry: () => { stopping = true; },
    whenReady: async () => { calls++; throw new Error('blocked'); } }), /blocked/);
  assert.equal(calls, 1);
});

test('Widevine: listo al primer intento no espera nada', async () => {
  let calls = 0; const retries: number[] = [];
  await waitForWidevine({ ...fast, stopped: () => false, onRetry: attempt => retries.push(attempt), whenReady: async () => { calls++; } });
  assert.equal(calls, 1); assert.deepEqual(retries, []);
});
