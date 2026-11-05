// Reintentos de red de toda la app.
//
// Un pedido que falla por la red se reintenta 3 veces, cada 5 s. Un firewall por aplicación bloquea el primer intento de
// un programa nuevo (o hacia un destino nuevo) hasta que el usuario lo permite en su aviso; sin esta espera la app
// mostraría el error antes de que alguien llegue a hacer clic. Sólo se reintentan fallas de red: una respuesta HTTP, un
// tiempo agotado o una cancelación siguen sus propias reglas.

export const networkRetry = { retries: 3, delayMs: 5000 };

export async function pauseFor(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function withNetworkRetries<T>(run: () => Promise<T>, isNetworkFailure: (error: unknown) => boolean,
  options: { signal?: AbortSignal; stopped?: () => boolean; onRetry?: (attempt: number) => void } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (error) {
      if (options.signal?.aborted || options.stopped?.() || attempt > networkRetry.retries || !isNetworkFailure(error)) throw error;
      options.onRetry?.(attempt);
      await pauseFor(networkRetry.delayMs, options.signal);
      if (options.stopped?.()) throw error;
    }
  }
}

// Errores de Chromium al cargar una página que indican que la conexión no se pudo hacer (bloqueada, sin red, nombre sin
// resolver, conexión cortada). ERR_ABORTED y los errores de certificado o de contenido no se reintentan.
const chromiumNetworkError = /^ERR_(NETWORK_(ACCESS_DENIED|CHANGED|IO_SUSPENDED)|CONNECTION_(REFUSED|RESET|CLOSED|ABORTED|FAILED|TIMED_OUT)|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|ADDRESS_INVALID|TIMED_OUT|PROXY_CONNECTION_FAILED|SOCKET_NOT_CONNECTED|EMPTY_RESPONSE)$/;
export function isChromiumNetworkError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && chromiumNetworkError.test(code);
}
