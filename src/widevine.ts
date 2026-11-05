// Espera del módulo Widevine con reintentos.
//
// La primera descarga del módulo puede fallar al instante por una causa pasajera: un firewall por aplicación bloquea el
// primer intento de un programa nuevo hasta que el usuario lo permite, o la red todavía no está lista. Antes de mostrar el
// error se reintenta como toda conexión de la app (network-retry.ts: 3 veces, cada 5 s); cada intento vuelve a pedir el
// módulo, como «Retry loading». Un intento que agota su tiempo no se repite: ahí el problema no es pasajero y repetirlo
// sólo alargaría la espera.
import { networkRetry, pauseFor } from './network-retry';

export const widevineTimeoutMs = 90000;

export interface WidevineWaitOptions {
  whenReady: () => Promise<unknown>;
  stopped: () => boolean;
  onRetry: (attempt: number) => void;
  timeoutMs?: number;
  retries?: number;
  delayMs?: number;
}

export async function waitForWidevine(options: WidevineWaitOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? widevineTimeoutMs, retries = options.retries ?? networkRetry.retries;
  const delayMs = options.delayMs ?? networkRetry.delayMs;
  for (let attempt = 1; ; attempt++) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([options.whenReady(),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('WIDEVINE_TIMEOUT')), timeoutMs); })]);
      return;
    } catch (error) {
      if (attempt > retries || options.stopped() || (error instanceof Error && error.message === 'WIDEVINE_TIMEOUT')) throw error;
      options.onRetry(attempt);
      await pauseFor(delayMs);
      if (options.stopped()) throw error;
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
