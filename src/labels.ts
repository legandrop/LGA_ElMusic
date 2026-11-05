import { isMusicPage } from './music-shell';
import { withNetworkRetries } from './network-retry';

export interface AlbumRef { country: string; id: string }
export interface RecordLabel { name: string; id: string; source: 'Apple Music' | 'MusicBrainz'; url?: string }
export interface PublicAlbum { ref: AlbumRef; title: string; artist: string; artistIds: string[]; url: string; labels: RecordLabel[]; copyrightHolder?: string }
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const numeric = /^\d{1,20}$/;
const countryCode = /^[a-z]{2}$/;
const userAgent = 'ElMusic (personal music client; https://github.com/legandrop)';
let mbQueue: Promise<unknown> = Promise.resolve();
let lastMbRequest = 0;
let mbPausedUntil = 0;
const cache = new Map<string, { promise: Promise<PublicAlbum>; expires: number }>();

type Data = Record<string, any>; // Datos públicos JSON; sólo campos cerrados salen hacia la UI.
export class PublicMetadataError extends Error {
  constructor(readonly kind: 'network' | 'timeout' | 'http' | 'limit', readonly status?: number) {
    super(kind === 'limit' ? 'PUBLIC_METADATA_TOO_LARGE' : 'PUBLIC_METADATA_UNAVAILABLE');
  }
}
export function albumRef(url: unknown): AlbumRef | undefined {
  if (typeof url !== 'string' || url.length > 2048 || !isMusicPage(url)) return;
  const value = new URL(url); const match = value.pathname.match(/^\/([a-z]{2})\/album\/(?:[^/]+\/)?(\d{1,20})\/?$/);
  if (!match || value.hash || [...value.searchParams.keys()].some(key => key !== 'i') || value.searchParams.getAll('i').length > 1 || (value.searchParams.has('i') && !numeric.test(value.searchParams.get('i')!))) return;
  return { country: match[1], id: match[2] };
}
export function albumUrl(ref: AlbumRef): string {
  if (!countryCode.test(ref.country) || !numeric.test(ref.id)) throw new Error('INVALID_ALBUM_REFERENCE');
  return `https://music.apple.com/${ref.country}/album/${ref.id}`;
}
function text(value: unknown, max = 240): string { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
export function isMbid(value: unknown): value is string { return typeof value === 'string' && uuid.test(value); }

// Una falla de red se reintenta 3 veces cada 5 s (network-retry.ts); cada intento con su propio tope de 10 s.
async function readPublic(url: string, signal?: AbortSignal): Promise<string> {
  return withNetworkRetries(() => readPublicOnce(url, signal), error => error instanceof PublicMetadataError && error.kind === 'network', { signal });
}
async function readPublicOnce(url: string, signal?: AbortSignal): Promise<string> {
  const value = new URL(url);
  if (value.protocol !== 'https:' || value.port || value.username || value.password ||
    !((value.hostname === 'music.apple.com' && !!albumRef(value.href)) ||
      (value.hostname === 'musicbrainz.org' && value.pathname.startsWith('/ws/2/')))) throw new Error('PUBLIC_ENDPOINT_DENIED');
  const controller = new AbortController(); let response: Response | undefined; let currentUrl = url; const timer = setTimeout(() => controller.abort(), 10000);
  const request = async (target: string): Promise<Response> => {
    try { return await fetch(target, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      headers: { 'User-Agent': userAgent, Accept: value.hostname === 'musicbrainz.org' ? 'application/json' : 'text/html' } }); }
    catch { signal?.throwIfAborted(); throw new PublicMetadataError(controller.signal.aborted ? 'timeout' : 'network'); }
  };
  try {
    response = await request(url);
    if (value.hostname === 'music.apple.com') {
      const original = albumRef(url)!;
      for (let redirects = 0; response.status >= 300 && response.status < 400 && redirects < 3; redirects++) {
        const location = response.headers.get('location'); const target = location ? new URL(location, currentUrl) : undefined;
        const ref = target ? albumRef(target.href) : undefined;
        if (!ref || ref.id !== original.id || ref.country !== original.country) throw new Error('PUBLIC_REDIRECT_DENIED');
        await response.body?.cancel();
        currentUrl = target!.href; response = await request(currentUrl);
      }
    }
    if (response.status === 429 && value.hostname === 'musicbrainz.org') {
      const header = response.headers.get('retry-after');
      const wait = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 60000;
      mbPausedUntil = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(1000, Number.isFinite(wait) ? wait : 60000));
    }
    if (!response.ok) throw new PublicMetadataError('http', response.status);
    if (!response.body) throw new Error('PUBLIC_METADATA_UNAVAILABLE');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch { signal?.throwIfAborted(); throw new PublicMetadataError(controller.signal.aborted ? 'timeout' : 'network'); }
      if (part.done) break;
      size += part.value.length; if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new PublicMetadataError('limit'); } chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); controller.abort(); try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* Abort ya cierra la lectura activa. */ } }
}
export async function musicBrainz(endpoint: string, parameters: Record<string, string>, signal?: AbortSignal): Promise<Data> {
  if (!/^(url|release|recording|artist|label)(?:\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})?$/.test(endpoint)) throw new Error('MB_ENDPOINT_DENIED');
  const allowed = new Set(['query', 'limit', 'inc', 'label', 'offset']);
  if (Object.entries(parameters).some(([key, value]) => !allowed.has(key) || typeof value !== 'string' || value.length > 2048)) throw new Error('MB_PARAMETERS_DENIED');
  const operation = mbQueue.catch(() => {}).then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastMbRequest)); if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    signal?.throwIfAborted(); lastMbRequest = Date.now(); const url = new URL(`https://musicbrainz.org/ws/2/${endpoint}`);
    if (Date.now() < mbPausedUntil) throw new PublicMetadataError('http', 429);
    for (const [key, value] of Object.entries({ ...parameters, fmt: 'json' })) url.searchParams.set(key, value);
    return JSON.parse(await readPublic(url.href, signal)) as Data;
  });
  mbQueue = operation; return operation;
}
// «℗ 2017 Mount Kimbie under exclusive licence to Warp Records Limited» → «Warp Records Limited». Sólo la línea ℗ (grabación).
export function phonographicHolder(description: string): string | undefined {
  const line = description.split('\n').map(item => item.trim()).find(item => item.startsWith('℗'));
  if (!line) return;
  let holder = line.replace(/^℗\s*/, '').replace(/^\d{4}(?:\s*[-–,]\s*\d{4})*\s*/, '');
  holder = holder.match(/\bunder (?:an? )?(?:exclusive )?licen[cs]e to (.+)$/i)?.[1] ?? holder;
  holder = holder.replace(/[.,;\s]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return holder || undefined;
}
export function parsePublicAlbum(html: string, ref: AlbumRef): PublicAlbum {
  const match = html.match(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('PUBLIC_ALBUM_DATA_MISSING');
  const page = JSON.parse(match[1]).data?.[0];
  const descriptor = page?.intent?.contentDescriptor;
  if (page?.intent?.$kind !== 'AlbumDetailPageIntent' || descriptor?.kind !== 'album' ||
    String(descriptor.identifiers?.storeAdamID) !== ref.id || descriptor.locale?.storefront !== ref.country) throw new Error('PUBLIC_ALBUM_ID_MISMATCH');
  const header = page.data?.sections?.[0]?.items?.[0];
  if (header?.contentDescriptor?.kind !== 'album' || String(header.contentDescriptor.identifiers?.storeAdamID) !== ref.id) throw new Error('PUBLIC_ALBUM_ID_MISMATCH');
  const title = text(header?.title);
  const artist = (header?.subtitleLinks ?? []).map((link: Data) => text(link.title)).join(', ');
  const artistIds: string[] = (header?.subtitleLinks ?? []).flatMap((link: Data) => {
    const descriptor = link.segue?.destination?.contentDescriptor, id = String(descriptor?.identifiers?.storeAdamID);
    if (descriptor?.kind !== 'artist' || !numeric.test(id) || typeof descriptor.url !== 'string' || descriptor.url.length > 2048 || !isMusicPage(descriptor.url)) return [];
    const url = new URL(descriptor.url);
    return !url.search && !url.hash && new RegExp(`^/${ref.country}/artist/(?:[^/]+/)?${id}/?$`).test(url.pathname) ? [id] : [];
  });
  const labels: RecordLabel[] = [];
  const items: Data[] = (page.data?.sections ?? []).flatMap((section: Data) => Array.isArray(section.items) ? section.items : []);
  for (const object of items) {
    if (object.contentDescriptor?.kind !== 'album' || String(object.contentDescriptor.identifiers?.storeAdamID) !== ref.id) continue;
    const section = object.linkSection; const link = section?.link;
    const intent = link?.segue?.destination?.intent;
    const id = intent?.contentDescriptor?.identifiers?.storeAdamID;
    if (intent?.$kind === 'RecordLabelDetailPageIntent' && numeric.test(String(id)) && text(link?.title)) {
      const candidate = link.segue?.actionMetrics?.data?.[0]?.fields?.actionUrl;
      let url: string | undefined;
      if (typeof candidate === 'string' && isMusicPage(candidate)) {
        const value = new URL(candidate);
        if (new RegExp(`^/${ref.country}/label/(?:[^/]+/)?${id}/?$`).test(value.pathname) && !value.search && !value.hash) url = candidate;
      }
      labels.push({ name: text(link.title), id: String(id), source: 'Apple Music', url });
    }
  }
  const canonical = albumRef(page.data?.canonicalURL);
  const url = canonical?.id === ref.id && canonical.country === ref.country ? page.data.canonicalURL : '';
  // Titular ℗ del pie del tracklist del mismo álbum: dato orientativo, no acredita sello.
  const footer = (page.data?.sections ?? []).find((section: Data) => section?.itemKind === 'containerDetailTracklistFooterLockup' &&
    typeof section.id === 'string' && section.id.endsWith(' - ' + ref.id))?.items?.[0]?.description;
  const copyrightHolder = typeof footer === 'string' ? phonographicHolder(footer) : undefined;
  return { ref, title, artist, artistIds: [...new Set(artistIds)], url, labels: labels.filter((label, index) => labels.findIndex(item => item.id === label.id) === index),
    ...(copyrightHolder ? { copyrightHolder } : {}) };
}
function appleRelations(release: Data, id?: string): AlbumRef[] {
  return (Array.isArray(release.relations) ? release.relations : []).map((relation: Data) => albumRef(relation.url?.resource))
    .filter((ref: AlbumRef | undefined): ref is AlbumRef => !!ref && (!id || ref.id === id));
}
export function labelsOfExactRelease(release: Data, id: string): RecordLabel[] {
  if (!appleRelations(release, id).length) return [];
  return (Array.isArray(release['label-info']) ? release['label-info'] : []).flatMap((info: Data) =>
    isMbid(info.label?.id) && text(info.label?.name) ? [{ name: text(info.label.name), id: info.label.id, source: 'MusicBrainz' as const }] : []);
}
export async function findEditionLabels(id: string, signal?: AbortSignal): Promise<RecordLabel[]> {
  const search = await musicBrainz('url', { query: `url:*${id}* AND targettype:release`, limit: '10' }, signal);
  const urls = (Array.isArray(search.urls) ? search.urls : []).filter((item: Data) => isMbid(item.id) && albumRef(item.resource)?.id === id);
  const releaseIds = new Set<string>();
  for (const item of urls.slice(0, 3)) {
    const resource = await musicBrainz(`url/${item.id}`, { inc: 'release-rels' }, signal);
    if (albumRef(resource.resource)?.id !== id) continue;
    for (const relation of resource.relations ?? []) if (isMbid(relation.release?.id)) releaseIds.add(relation.release.id);
  }
  if (releaseIds.size > 5) return [];
  let labels: RecordLabel[] | undefined;
  for (const releaseId of releaseIds) {
    const release = await musicBrainz(`release/${releaseId}`, { inc: 'labels+url-rels' }, signal);
    const current = labelsOfExactRelease(release, id).sort((a, b) => a.id.localeCompare(b.id));
    if (!current.length) continue;
    if (labels && labels.map(label => label.id).join() !== current.map(label => label.id).join()) return [];
    labels = current;
  }
  return labels ?? [];
}
export function publicAlbum(ref: AlbumRef, findLabels = true, signal?: AbortSignal): Promise<PublicAlbum> {
  const key = `${ref.country}/${ref.id}/${findLabels}`; let entry = cache.get(key);
  if (entry && entry.expires <= Date.now()) { cache.delete(key); entry = undefined; }
  let pending = entry?.promise;
  if (!pending) {
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    pending = (async () => {
      const album = parsePublicAlbum(await readPublic(albumUrl(ref), signal), ref);
      if (findLabels && !album.labels.length) album.labels = await findEditionLabels(ref.id, signal);
      return album;
    })();
    // La caché negativa evita repetir peticiones fallidas en cada poll del player.
    const cached = { promise: pending, expires: Date.now() + 15 * 60 * 1000 };
    cache.set(key, cached); void pending.catch(() => { if (cache.get(key) !== cached) return; if (signal?.aborted || !findLabels) cache.delete(key); else cached.expires = Date.now() + 60000; });
  }
  return pending;
}
// Discos de un sello en MusicBrainz, de a 100. Con enlace a Apple, sólo el ID de álbum: es global y la
// disponibilidad regional se confirma después con Lookup, en un solo pedido. Los enlaces viejos de itunes.apple.com
// («/fr/album/id1219276283», a veces sin país) también valen (en Nowadays Records eran 11 de 52). Sin enlace,
// artista y título para buscarlo en Apple.
export interface LabelRelease { artist: string; title: string; released?: string }
export interface LabelAlbumPage { ids: string[]; unlinked: LabelRelease[]; nextOffset: number; more: boolean }
export function releaseAppleIds(release: Data): string[] {
  return [...new Set((Array.isArray(release?.relations) ? release.relations : []).flatMap((relation: Data): string[] => {
    const resource = relation?.url?.resource;
    if (typeof resource !== 'string' || resource.length > 2048) return [];
    try {
      const url = new URL(resource);
      if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password || !['music.apple.com', 'itunes.apple.com', 'geo.music.apple.com'].includes(url.hostname)) return [];
      const id = url.pathname.match(/^\/(?:[a-z]{2}\/)?album\/(?:[^/]+\/)?(?:id)?(\d{1,20})\/?$/)?.[1];
      return id ? [id] : [];
    } catch { return []; }
  }))];
}
export async function labelAlbumIds(labelId: string, offset: number, signal?: AbortSignal): Promise<LabelAlbumPage> {
  if (!isMbid(labelId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) throw new Error('INVALID_RELEASE_REQUEST');
  const page = await musicBrainz('release', { label: labelId, inc: 'url-rels artist-credits', limit: '100', offset: String(offset) }, signal);
  const releases: Data[] = Array.isArray(page.releases) ? page.releases.slice(0, 100) : [];
  const ids = [...new Set(releases.flatMap(releaseAppleIds))];
  const unlinked: LabelRelease[] = [], names = new Set<string>();
  for (const release of releases) {
    if (releaseAppleIds(release).length) continue;
    const credit = Array.isArray(release['artist-credit']) ? release['artist-credit'].slice(0, 20).map((part: Data) => text(part?.name) + (typeof part?.joinphrase === 'string' ? part.joinphrase.slice(0, 20) : '')).join('') : '';
    const artist = text(credit), title = text(release.title), key = (artist + '\u0001' + title).normalize('NFKC').toLowerCase();
    if (!artist || !title || names.has(key)) continue;
    names.add(key);
    unlinked.push(/^\d{4}(?:-\d{2}){0,2}$/.test(release.date) ? { artist, title, released: release.date } : { artist, title });
  }
  const nextOffset = offset + releases.length;
  return { ids, unlinked, nextOffset, more: releases.length > 0 && nextOffset < Number(page['release-count']) };
}
// Familia del sello: los relacionados como imprint o dueño cuyo nombre, sin «Records», «Music», «Ltd»…, es el mismo
// («Warp Records» → «Warp», donde MusicBrainz anota casi todo el catálogo). Nunca un dueño con otro nombre (una
// multinacional mostraría otro catálogo). Hasta tres sellos, el pedido primero.
export function labelBaseName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[.,]/g, ' ')
    .replace(/\b(?:records?|recordings?|music|musique|label|ltd|limited|inc|llc|gmbh|s ?a|b ?v)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
export async function labelFamily(labelId: string, signal?: AbortSignal): Promise<string[]> {
  if (!isMbid(labelId)) throw new Error('INVALID_LABEL');
  const label = await musicBrainz(`label/${labelId}`, { inc: 'label-rels' }, signal);
  const base = labelBaseName(text(label.name));
  const family = (Array.isArray(label.relations) ? label.relations : []).filter((relation: Data) =>
    ['imprint', 'label ownership'].includes(relation.type) && isMbid(relation.label?.id) && relation.label.id !== labelId &&
    !!base && labelBaseName(text(relation.label?.name)) === base).map((relation: Data) => relation.label.id as string);
  return [labelId, ...new Set(family)].slice(0, 3);
}
// Sello de MusicBrainz cuyo nombre coincide exacto (sin distinguir mayúsculas ni espacios) con el titular ℗. Si hay más
// de uno con ese nombre no se elige ninguno: el ℗ no acredita sello y un homónimo mostraría otro catálogo.
export async function findLabelByName(name: string, signal?: AbortSignal): Promise<RecordLabel | undefined> {
  const wanted = name.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!wanted || wanted.length > 120) return;
  const page = await musicBrainz('label', { query: `label:"${wanted.replace(/["\\]/g, '')}"`, limit: '10' }, signal);
  // Los homónimos que MusicBrainz marca como bootleg o falsificación no cuentan; entre los demás sólo se elige si es único
  // o si su puntaje de búsqueda le saca al menos 15 puntos al siguiente.
  const matches = (Array.isArray(page.labels) ? page.labels : []).filter((label: Data) => isMbid(label.id) &&
    text(label.name).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() === wanted && !/bootleg|counterfeit|fake|unofficial/i.test(text(label.disambiguation)))
    .sort((a: Data, b: Data) => (Number(b.score) || 0) - (Number(a.score) || 0));
  const clear = matches.length === 1 || matches.length > 1 && (Number(matches[0].score) || 0) - (Number(matches[1].score) || 0) >= 15;
  return clear ? { name: text(matches[0].name), id: matches[0].id, source: 'MusicBrainz' } : undefined;
}
