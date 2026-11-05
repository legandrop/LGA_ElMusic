import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Violeta claro: contraste ~7:1 sobre los fondos #1f1f1f/#2b2b2b de la app.
export const defaultArtistColor = '#b48cff';
export function validArtistColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}
const configPath = (preferences: string): string => path.join(preferences, 'appearance.json');
export function readArtistColor(preferences: string): string {
  const file = configPath(preferences);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultArtistColor; throw new Error('APPEARANCE_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('APPEARANCE_CONFIG_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('APPEARANCE_CONFIG_INVALID'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('APPEARANCE_CONFIG_INVALID');
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some(key => key !== 'artistColor') || ('artistColor' in values && !validArtistColor(values.artistColor))) throw new Error('APPEARANCE_CONFIG_INVALID');
  return values.artistColor ? (values.artistColor as string).toLowerCase() : defaultArtistColor;
}
export function saveArtistColor(preferences: string, color: unknown): void {
  if (!validArtistColor(color)) throw new Error('ARTIST_COLOR_INVALID');
  // Un archivo ajeno/ilegible no se pisa como efecto de guardar una preferencia.
  readArtistColor(preferences);
  const file = configPath(preferences), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ artistColor: color.toLowerCase() })}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('APPEARANCE_TEMP_CLEANUP_FAILED'); } }
}
// Sólo una variable CSS constante y validada en la vista musical; no lee ni toca datos de la página.
export function artistColorScript(color: string): string {
  if (!validArtistColor(color)) throw new Error('ARTIST_COLOR_INVALID');
  return `(() => {
    if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return;
    document.documentElement.style.setProperty('--el-music-artist-color', ${JSON.stringify(color.toLowerCase())});
  })()`;
}
