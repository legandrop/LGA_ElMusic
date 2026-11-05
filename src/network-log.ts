import type { Session } from 'electron';

// Conexiones de la página musical que fallan por la red (firewall, sin red, conexión cortada). Sin este registro, un
// Play que Apple corta con «Ocurrió un error» no deja rastro: el pedido de licencia o de audio lo hace el reproductor de
// Apple con su propio código. Se registra sólo el servidor (si es de Apple o Google; si no, «otro»), el tipo de recurso y
// el código de Chromium; nunca la dirección completa. Las cancelaciones (ERR_ABORTED) son normales y no se registran.

const knownHosts = /^(?:[a-z0-9-]+\.)*(?:apple\.com|mzstatic\.com|cdn-apple\.com|apple-mapkit\.com|googleapis\.com|gvt1\.com|google\.com)$/;
const ignored = new Set(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_CACHE_MISS']);
const resourceTypes = new Set(['mainFrame', 'subFrame', 'stylesheet', 'script', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket', 'other']);
// Lo que Chromium devuelve cuando Windows rechaza la conexión (WSAEACCES, 10013): un firewall por aplicación que la bloqueó.
const firewallCode = 'ERR_NETWORK_ACCESS_DENIED';

export function describeFailure(url: string, error: string, resourceType: string): Record<string, string> | undefined {
  if (ignored.has(error) || !/^net::ERR_[A-Z0-9_]{1,60}$/.test(error)) return;
  let host: string;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' && parsed.protocol !== 'wss:') return; host = parsed.hostname.toLowerCase(); }
  catch { return; }
  return { servidor: knownHosts.test(host) ? host : 'otro', recurso: resourceTypes.has(resourceType) ? resourceType : 'other', código: error.slice(5) };
}

// Una misma falla (servidor + código) se registra una vez cada 10 s, y como mucho 60 por hora, para no inundar el log
// si la red se cae entera. Un bloqueo de firewall hacia Apple o Google avisa además al usuario, como mucho una vez por minuto.
export function installNetworkFailureLog(session: Session, log: (event: string, fields: Record<string, string>) => void,
  options: { onFirewallBlock?: () => void; now?: () => number } = {}): void {
  const now = options.now ?? Date.now;
  const lastByKey = new Map<string, number>();
  let windowStart = now(); let inWindow = 0; let lastNotice: number | undefined;
  session.webRequest.onErrorOccurred(details => {
    const fields = describeFailure(details.url, details.error, details.resourceType);
    if (!fields) return;
    const time = now();
    if (fields.código === firewallCode && fields.servidor !== 'otro' && (lastNotice === undefined || time - lastNotice >= 60_000)) {
      lastNotice = time; options.onFirewallBlock?.();
    }
    if (time - windowStart > 3_600_000) { windowStart = time; inWindow = 0; }
    const key = fields.servidor + ' ' + fields.código;
    const last = lastByKey.get(key);
    if (last !== undefined && time - last < 10_000) return;
    if (inWindow >= 60) return;
    lastByKey.set(key, time); inWindow++;
    if (lastByKey.size > 200) lastByKey.delete(lastByKey.keys().next().value!);
    log('Falló una conexión de la página musical', fields);
  });
}

// Aviso en la página cuando el firewall bloqueó una conexión: un firewall que pregunta por cada servidor nuevo descarta el
// primer intento, y el reproductor de Apple no reintenta (el tema queda trabado hasta recargar la página). Mismo aviso
// propio que el de los enlaces pegados, sólo con textContent; queda 9 s.
export function firewallNoticeScript(): string {
  const title = 'Your firewall blocked El Music';
  const detail = 'Allow it, then choose El Music › Retry loading and play again.';
  return `(() => {
    if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port) return null;
    document.getElementById('el-music-toast')?.remove();
    const box = document.createElement('div'); box.id = 'el-music-toast'; box.className = 'el-music-toast'; box.setAttribute('role', 'alert'); box.dataset.elMusicOwner = 'firewall';
    const row = document.createElement('div'); row.textContent = ${JSON.stringify(title)}; box.appendChild(row);
    const more = document.createElement('div'); more.className = 'el-music-toast__detail'; more.textContent = ${JSON.stringify(detail)}; box.appendChild(more);
    document.body.appendChild(box);
    setTimeout(() => box.classList.add('el-music-toast--hide'), 9000); setTimeout(() => box.remove(), 9800);
    return true;
  })()`;
}
