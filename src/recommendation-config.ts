import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function validLastFmKey(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^[a-f\d]{32}$/i.test(value));
}
const configPath = (preferences: string): string => path.join(preferences, 'recommendations.json');
export function readLastFmKey(preferences: string): string | undefined {
  const file = configPath(preferences);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('RECOMMENDATION_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('RECOMMENDATION_CONFIG_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('RECOMMENDATION_CONFIG_INVALID'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('RECOMMENDATION_CONFIG_INVALID');
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some(key => key !== 'lastFmApiKey') || ('lastFmApiKey' in values && !validLastFmKey(values.lastFmApiKey))) throw new Error('RECOMMENDATION_CONFIG_INVALID');
  return values.lastFmApiKey ? values.lastFmApiKey as string : undefined;
}
export function saveLastFmKey(preferences: string, key: unknown): void {
  if (!validLastFmKey(key)) throw new Error('LASTFM_KEY_INVALID');
  // Un archivo ajeno/ilegible no se pisa como efecto de guardar una preferencia.
  readLastFmKey(preferences);
  const file = configPath(preferences), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(key ? { lastFmApiKey: key } : {})}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('RECOMMENDATION_TEMP_CLEANUP_FAILED'); } }
}
