import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';

// Medición de la carga de playlists. La página deja, al terminar de cargar una playlist,
// sólo números en un dataset; main los toma una vez, los valida y los vuelca al log de diagnóstico.
const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
export const playlistTimingScript = `(() => {
  ${guard}
  const root = document.documentElement, value = root.dataset.elMusicPlaylistTiming;
  if (value === undefined) return null;
  delete root.dataset.elMusicPlaylistTiming;
  return value.slice(0, 2000);
})()`;
const fields = ['filas', 'tandasExtra', 'primerasFilasMs', 'todasMs', 'esperaAppleMs', 'nuestroMs', 'nuestroMaxMs', 'pasadas', 'bloqueos',
  'bloqueoTotalMs', 'bloqueoMaxMs', 'cuadrosLentos', 'cuadrosLentosMs', 'disenoMs', 'disenoForzadoMs', 'scriptAppleMs', 'scriptPropioMs', 'scriptOtroMs'] as const;
export function playlistTiming(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'string') return;
  let data: unknown;
  try { data = JSON.parse(value); } catch { return; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const result: Record<string, number> = {};
  for (const field of fields) {
    const number = (data as Record<string, unknown>)[field];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return;
    result[field] = Math.min(Math.round(number), 100_000_000);
  }
  return Object.keys(data).length === fields.length ? result : undefined;
}

export function installPlaylistTiming(contents: WebContents, log: (event: string, fields: Record<string, number>) => void): void {
  let polling = false;
  const poll = async (): Promise<void> => {
    if (polling || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
    polling = true;
    try { const timing = playlistTiming(await contents.mainFrame.executeJavaScript(playlistTimingScript)); if (timing) log('Playlist: carga medida', timing); }
    catch { /* Página en navegación: se lee en el próximo ciclo. */ }
    finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 3000);
  contents.once('destroyed', () => clearInterval(timer));
}
