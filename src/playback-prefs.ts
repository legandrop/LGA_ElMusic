import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';

// Modo shuffle persistente entre sesiones. Archivo propio en preferencias; sólo un booleano.
const configPath = (preferences: string): string => path.join(preferences, 'playback.json');
export function readShuffle(preferences: string): boolean {
  const file = configPath(preferences);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new Error('PLAYBACK_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('PLAYBACK_CONFIG_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('PLAYBACK_CONFIG_INVALID'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('PLAYBACK_CONFIG_INVALID');
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some(key => key !== 'shuffle') || ('shuffle' in values && typeof values.shuffle !== 'boolean')) throw new Error('PLAYBACK_CONFIG_INVALID');
  return values.shuffle === true;
}
export function saveShuffle(preferences: string, shuffle: boolean): void {
  readShuffle(preferences); // Un archivo ajeno o ilegible no se pisa.
  const file = configPath(preferences), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ shuffle: shuffle === true })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('PLAYBACK_TEMP_CLEANUP_FAILED'); } }
}

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;
    const kit = globalThis.MusicKit, music = typeof kit?.getInstance === 'function' ? kit.getInstance() : undefined;
    if (!music || typeof music.shuffleMode !== 'number') return null;`;
// Sólo la propiedad pública shuffleMode (0 apagado, 1 canciones) del singleton que configuró la página oficial.
// Con una cola de Related o una cola de discos viva devuelve 'related': esas colas apagan el shuffle a propósito y no es un
// cambio del usuario; al terminar se vuelve a aplicar el modo guardado.
export const readShuffleScript = `(() => { ${guard}
    const root = document.documentElement;
    if (root.dataset.elMusicRecommendationQueueBusy || root[Symbol.for('el-music.recommendation-queue')] || root.dataset.elMusicAlbumQueue === '1') return 'related';
    return music.shuffleMode === 1; })()`;
export function applyShuffleScript(shuffle: boolean): string {
  return `(() => { ${guard} if ((music.shuffleMode === 1) !== ${shuffle === true}) music.shuffleMode = ${shuffle === true ? 1 : 0}; return music.shuffleMode === 1; })()`;
}

// Al cargar la página se restaura el modo guardado; después se guarda cada cambio que haga el usuario (botón de Apple o
// shuffle del encabezado). Hasta restaurar no se guarda nada, para no pisar el valor con el apagado inicial de MusicKit.
export function installShufflePersistence(contents: WebContents, preferences: string, log: (message: string) => void): void {
  let saved: boolean;
  try { saved = readShuffle(preferences); } catch { log('No se pudo leer la preferencia de shuffle'); return; }
  let restored = false, polling = false, stopped = false, related = false;
  const poll = async (): Promise<void> => {
    if (polling || stopped || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
    polling = true;
    try {
      if (!restored) {
        const result: unknown = await contents.mainFrame.executeJavaScript(saved ? applyShuffleScript(true) : readShuffleScript);
        // Restaurado sólo si MusicKit quedó en el modo guardado; si no, se reintenta y mientras tanto no se guarda nada.
        if (result === saved) restored = true;
        return;
      }
      const current: unknown = await contents.mainFrame.executeJavaScript(readShuffleScript);
      if (current === 'related') { related = true; return; }
      if (typeof current !== 'boolean') return;
      // Al terminar la cola de Related el shuffle quedó apagado por ella: se vuelve a aplicar el modo guardado.
      if (related) { related = false; if (saved && !current) { restored = false; return; } }
      if (current === saved) return;
      try { saveShuffle(preferences, current); saved = current; }
      catch { log('No se pudo guardar la preferencia de shuffle'); stopped = true; }
    } catch { /* Página en navegación: se reintenta en el próximo ciclo. */ }
    finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 1500);
  // Una carga nueva del documento vuelve a crear MusicKit apagado: se restaura otra vez.
  const reset = (): void => { restored = false; related = false; };
  contents.on('did-start-navigation', (details, _url, inPlace, mainFrame) => { if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) reset(); });
  contents.on('dom-ready', reset);
  contents.on('did-finish-load', reset);
  contents.on('destroyed', () => { stopped = true; clearInterval(timer); });
}
