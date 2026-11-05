import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMbid } from './labels';
import type { LabelLink } from './record-labels';
import { albumArtists, type AlbumArtist } from './album-match';

// Sellos ya resueltos de la columna Label guardados en disco, para que una playlist ya vista
// se complete al abrirla y sólo se consulte lo nuevo. Archivo propio en la carpeta de datos de la app: clave de álbum,
// texto del sello, su enlace (nombre o MBID) y la fecha. Las claves por nombre llevan artista y álbum de la biblioteca
// del usuario y quedan sólo en esta máquina. Un sello vence a los 90 días; un «sin dato» o un «℗ …» provisional, a los 7,
// para volver a probar (MusicBrainz puede confirmarlo más adelante). Versión 4: las claves por nombre guardan
// además el ID de catálogo del álbum, para que el panel de un sello muestre los álbumes de la biblioteca que ya se sabe que
// son suyos.
// Versión 5: cada entrada lleva además fecha de lanzamiento y género del álbum (columnas Released y Genre),
// en siete campos fijos: [clave, sello, enlace, fecha, id|null, lanzamiento, género].
// Versión 7: un octavo campo con los artistas del álbum, [[nombre, id de catálogo], …] (hasta 6), o null si
// todavía no se pidieron; la página los usa para enlazar el artista en las filas donde Apple no lo enlaza.
export const labelCacheLimits = { entries: 20000, bytes: 8 * 1024 * 1024, labelDays: 90, emptyDays: 7, name: 240 } as const;
export interface CachedLabel { name: string; link?: LabelLink; saved: number; id?: string; released?: string; genre?: string; artists?: AlbumArtist[] }
export const albumKeyPattern = /^(?:\d{1,20}|n:[^\u0000]{3,410})$/;
const releasedPattern = /^\d{4}(?:-\d{2}){0,2}$/;
const day = 24 * 60 * 60 * 1000;

export function labelFresh(entry: CachedLabel, now = Date.now()): boolean {
  const age = now - entry.saved;
  const settled = entry.name && !entry.name.startsWith('℗ ');
  return age >= 0 && age < (settled ? labelCacheLimits.labelDays : labelCacheLimits.emptyDays) * day;
}
function linkOf(value: unknown): LabelLink | undefined | false {
  if (value === null || value === undefined) return undefined;
  const link = value as Record<string, unknown>;
  if (typeof link !== 'object' || typeof link.name !== 'string' || !link.name.trim() || link.name.length > 120) return false;
  if (link.kind === 'name' && Object.keys(link).length === 2) return { kind: 'name', name: link.name };
  if (link.kind === 'mb' && isMbid(link.id) && Object.keys(link).length === 3) return { kind: 'mb', id: link.id, name: link.name };
  return false;
}

// Temporales de un guardado cortado (la app se cerró entre escribir y renombrar): sólo los de este archivo.
function removeTemporaries(file: string): void {
  const folder = path.dirname(file), prefix = path.basename(file) + '.';
  try {
    for (const name of fs.readdirSync(folder))
      if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) fs.rmSync(path.join(folder, name), { force: true });
  } catch { /* Sin carpeta todavía. */ }
}

// Sin archivo, caché vacía. Un archivo que no es el nuestro (forma, tamaño o enlace) se rechaza y no se pisa.
export function readLabelCache(file: string, now = Date.now()): Map<string, CachedLabel> {
  const cache = new Map<string, CachedLabel>();
  removeTemporaries(file);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return cache; throw new Error('LABEL_CACHE_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > labelCacheLimits.bytes) throw new Error('LABEL_CACHE_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('LABEL_CACHE_INVALID'); }
  const root = data as { version?: unknown; entries?: unknown };
  const version = root.version as number;
  if (!root || typeof root !== 'object' || Array.isArray(root) || ![1, 2, 3, 4, 5, 6, 7].includes(version) || !Array.isArray(root.entries) ||
    Object.keys(root).length !== 2) throw new Error('LABEL_CACHE_INVALID');
  for (const item of root.entries.slice(-labelCacheLimits.entries)) {
    if (!Array.isArray(item) || (version >= 7 ? item.length !== 8 : version >= 5 ? item.length !== 7 : item.length !== 4 && !(version === 4 && item.length === 5))) throw new Error('LABEL_CACHE_INVALID');
    const [key, name, rawLink, saved, rawId, released, genre, rawArtists] = item as unknown[];
    const artists = rawArtists === null || rawArtists === undefined ? undefined : albumArtists(rawArtists);
    if (rawArtists !== null && rawArtists !== undefined && !artists) throw new Error('LABEL_CACHE_INVALID');
    const id = rawId === null ? undefined : rawId;
    if (id !== undefined && (typeof key !== 'string' || !key.startsWith('n:') || typeof id !== 'string' || !/^\d{1,20}$/.test(id))) throw new Error('LABEL_CACHE_INVALID');
    if (version >= 5 && (typeof released !== 'string' || (released && !releasedPattern.test(released)) || typeof genre !== 'string' || genre.length > 80)) throw new Error('LABEL_CACHE_INVALID');
    const link = linkOf(rawLink);
    if (typeof key !== 'string' || !albumKeyPattern.test(key) || typeof name !== 'string' || name.length > labelCacheLimits.name ||
      link === false || typeof saved !== 'number' || !Number.isFinite(saved)) throw new Error('LABEL_CACHE_INVALID');
    const entry: CachedLabel = { name, ...(link ? { link } : {}), saved, ...(typeof id === 'string' ? { id } : {}),
      ...(released ? { released: released as string } : {}), ...(genre ? { genre: genre as string } : {}), ...(artists ? { artists } : {}) };
    // Versiones 1 y 2 (0.1.33–0.1.35): un tope 429 de Apple se leía como «álbum inexistente», así que sus «sin dato» se
    // vuelven a probar. Versión 5 (0.1.40): el matcher no entendía acentos, apóstrofos tipográficos ni «EP» sin guion
    // (0.1.41); sus «sin dato» también. La versión 6 tiene la misma forma que la 5; la 7 suma los artistas.
    if (![3, 4, 6, 7].includes(version) && !name) continue;
    if (labelFresh(entry, now)) { cache.delete(key); cache.set(key, entry); }
  }
  return cache;
}

// Escritura atómica (temporal + rename); se guardan las más recientes, en el orden del Map (la última usada al final).
// Nunca se escribe algo que la lectura rechazaría: claves válidas, textos acotados y el total por debajo del tope de bytes.
export function saveLabelCache(file: string, cache: ReadonlyMap<string, CachedLabel>): void {
  let entries = [...cache].filter(([key, entry]) => albumKeyPattern.test(key) && entry.name.length <= labelCacheLimits.name &&
    linkOf(entry.link) !== false && Number.isFinite(entry.saved))
    .slice(-labelCacheLimits.entries).map(([key, entry]) => [key, entry.name, entry.link ?? null, entry.saved,
      key.startsWith('n:') && entry.id && /^\d{1,20}$/.test(entry.id) ? entry.id : null,
      entry.released && releasedPattern.test(entry.released) ? entry.released : '', (entry.genre ?? '').slice(0, 80),
      entry.artists ? albumArtists(entry.artists) ?? null : null]);
  let text = JSON.stringify({ version: 7, entries });
  while (Buffer.byteLength(text) > labelCacheLimits.bytes) { entries = entries.slice(Math.ceil(entries.length / 10)); text = JSON.stringify({ version: 7, entries }); }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('LABEL_CACHE_TEMP_CLEANUP_FAILED'); } }
}
