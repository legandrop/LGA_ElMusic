import type { WebContents } from 'electron';

// Electron anuncia conditional UI aunque Windows abre un selector modal que Apple reintenta.
export const conditionalUiScript = `(() => {
  const url = new URL(location.href);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !['music.apple.com', 'idmsa.apple.com', 'accounts.apple.com', 'appleid.apple.com'].includes(url.hostname)) return;
  const Credential = globalThis.PublicKeyCredential;
  if (!Credential) return;
  const marker = Symbol.for('elMusic.auth.conditionalUI');
  if (Credential[marker]) return;
  Object.defineProperty(Credential, marker, { value: true });
  if (typeof Credential.isConditionalMediationAvailable === 'function')
    Credential.isConditionalMediationAvailable = () => Promise.resolve(false);
  const capabilities = Credential.getClientCapabilities;
  if (typeof capabilities === 'function')
    Credential.getClientCapabilities = async () => ({ ...await capabilities.call(Credential), conditionalGet: false });
})();`;

// Sólo la vista musical y sus iframes; los popups mantienen su apertura/autenticación nativas.
export async function installWindowsAuthCompatibility(contents: WebContents, onFailure: () => void): Promise<void> {
  if (process.platform !== 'win32') return;
  const debuggerApi = contents.debugger;
  const sessions = new Set<string>();
  let stopped = false;
  let reported = false;
  const fail = (): void => {
    if (!stopped && !reported && !contents.isDestroyed()) { reported = true; onFailure(); }
  };
  // Chromium pausa también workers antes de aplicar el filtro: hay que recibirlos para reanudarlos.
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page', exclude: true }, { type: 'tab', exclude: true }, { type: 'browser', exclude: true }, { exclude: false }] };
  const command = async (method: string, parameters: Record<string, unknown>, sessionId?: string): Promise<void> => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([debuggerApi.sendCommand(method, parameters, sessionId),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('AUTH_COMPATIBILITY_TIMEOUT')), 8000); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  const setup = async (sessionId?: string): Promise<void> => {
    await command('Page.enable', {}, sessionId);
    await command('Page.addScriptToEvaluateOnNewDocument', { source: conditionalUiScript }, sessionId);
    await command('Target.setAutoAttach', autoAttach, sessionId);
  };
  const message = (_event: Electron.Event, method: string, parameters: Record<string, unknown>): void => {
    const sessionId = parameters.sessionId;
    if (typeof sessionId !== 'string') return;
    if (method === 'Target.detachedFromTarget') { sessions.delete(sessionId); return; }
    if (method !== 'Target.attachedToTarget' || stopped) return;
    sessions.add(sessionId);
    void (async () => {
      try {
        const type = (parameters.targetInfo as { type?: string } | undefined)?.type;
        if (type === 'iframe') await setup(sessionId);
        else if (['worker', 'shared_worker', 'service_worker'].includes(type ?? ''))
          await command('Target.setAutoAttach', autoAttach, sessionId);
      }
      catch { if (sessions.has(sessionId)) fail(); }
      finally {
        if (sessions.has(sessionId) && !stopped) {
          try { await command('Runtime.runIfWaitingForDebugger', {}, sessionId); }
          catch { if (sessions.has(sessionId)) fail(); }
        }
      }
    })();
  };
  const detached = (): void => fail();
  const stop = (): void => {
    stopped = true;
    sessions.clear();
    debuggerApi.removeListener('message', message);
    debuggerApi.removeListener('detach', detached);
    if (debuggerApi.isAttached()) debuggerApi.detach();
  };
  debuggerApi.attach('1.3');
  debuggerApi.on('message', message);
  debuggerApi.on('detach', detached);
  contents.once('destroyed', stop);
  try { await setup(); }
  catch (error) { stop(); throw error; }
}
