export interface ApplePublicSearchSong {
  id: string; albumId: string; artistId: string; artist: string; title: string; album?: string; url: string; artworkUrl?: string;
}
export interface ApplePublicSearchPage { canonical: string; songs: ApplePublicSearchSong[] }

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const rows = (value: unknown): Data[] => Array.isArray(value) ? value.slice(0, 100).map(object) : [];
const identifier = (value: unknown): string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : '';
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try { encodeURIComponent(value); return value.trim(); } catch { return ''; }
}
function appleUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'music.apple.com' && !url.port && !url.username && !url.password && !url.hash && url.href === value) return url;
  } catch { /* Referencia pública inválida: se omite. */ }
}
function catalog(value: unknown, country: string, kind: 'album' | 'artist', id: string): boolean {
  const url = appleUrl(value);
  return !!url && !url.search && new RegExp(`^/${country}/${kind}/(?:[^/]+/)?${id}/?$`).test(url.pathname);
}
function descriptor(value: unknown): { data: Data; id: string } {
  const data = object(value); return { data, id: identifier(object(data.identifiers).storeAdamID) };
}
function artwork(value: unknown): string | undefined {
  const template = object(object(value).dictionary).url;
  if (typeof template !== 'string' || !/\/\{w\}x\{h\}(?:\{c\}|bb)\.\{f\}$/.test(template)) return;
  try {
    const url = new URL(template.replace('{w}', '100').replace('{h}', '100').replace('{c}', 'bb').replace('{f}', 'jpg'));
    if (url.protocol === 'https:' && url.hostname === 'is1-ssl.mzstatic.com' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/image\/thumb\/Music\d{1,3}\/v4\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/[A-Za-z\d._-]{1,240}\.(?:jpg|png)\/100x100bb\.jpg$/.test(url.pathname)) return url.href;
  } catch { /* Una portada opcional nunca amplía los destinos permitidos. */ }
}

// Devuelve candidatos sin duración: el llamador filtra coincidencias exactas antes del Lookup y valida SongDetail antes de Play.
export function parseSearchPage(html: string, country: string, expectedTerm: string): ApplePublicSearchPage {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 5 * 1024 * 1024 || !/^[a-z]{2}$/.test(country) || typeof expectedTerm !== 'string' ||
    !expectedTerm.trim() || expectedTerm.length > 481 || /[\u0000-\u001f\u007f]/.test(expectedTerm)) throw new Error('PUBLIC_SEARCH_METADATA_MISMATCH');
  let page: Data;
  try {
    encodeURIComponent(expectedTerm);
    const scripts = [...html.matchAll(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/g)];
    if (scripts.length !== 1) throw new Error();
    const data = object(JSON.parse(scripts[0][1])).data;
    if (!Array.isArray(data) || data.length !== 1) throw new Error();
    page = object(data[0]);
  } catch { throw new Error('PUBLIC_SEARCH_DATA_INVALID'); }
  const intent = object(page.intent), data = object(page.data), canonical = appleUrl(typeof data.canonicalURL === 'string' ? data.canonicalURL.replaceAll("'", '%27') : data.canonicalURL);
  const query = canonical ? [...canonical.searchParams] : [];
  if (intent.$kind !== 'SearchResultsPageIntent' || intent.inLibrary !== false || intent.term !== expectedTerm || intent.storefront !== country ||
    !canonical || canonical.pathname !== `/${country}/search` || query.length !== 1 || query[0][0] !== 'term' || query[0][1] !== expectedTerm ||
    !Array.isArray(data.sections) || data.sections.length > 50) throw new Error('PUBLIC_SEARCH_METADATA_MISMATCH');
  const sections = rows(data.sections), albums = new Map<string, string>(), badAlbums = new Set<string>();
  for (const section of sections) {
    if (section.id !== 'square-section - album' || section.itemKind !== 'squareLockup') continue;
    for (const item of rows(section.items)) {
      const ref = descriptor(item.contentDescriptor), links = rows(item.titleLinks), album = text(links[0]?.title);
      const rowId = typeof item.id === 'string' ? item.id.match(/^square-section - album - ([1-9]\d{0,19})$/)?.[1] : undefined;
      if (!ref.id || ref.data.kind !== 'album' || rowId !== ref.id || !catalog(ref.data.url, country, 'album', ref.id)) {
        if (ref.id) badAlbums.add(ref.id); if (rowId) badAlbums.add(rowId); continue;
      }
      if (badAlbums.has(ref.id)) continue;
      if (!links.length || links.length === 1 && !album) continue;
      if (links.length !== 1) { badAlbums.add(ref.id); albums.delete(ref.id); continue; }
      if (albums.has(ref.id) && albums.get(ref.id) !== album) { albums.delete(ref.id); badAlbums.add(ref.id); }
      else albums.set(ref.id, album);
    }
  }
  const songs = new Map<string, ApplePublicSearchSong>(), badSongs = new Set<string>();
  for (const section of sections) {
    if (section.id !== 'track-section - song' || section.itemKind !== 'trackLockup') continue;
    for (const item of rows(section.items)) {
      const ref = descriptor(item.contentDescriptor), url = appleUrl(ref.data.url), title = text(item.title);
      const albumId = url?.pathname.match(new RegExp(`^/${country}/album/(?:[^/]+/)?([1-9]\\d{0,19})/?$`))?.[1] ?? '';
      const album = albums.get(albumId), songQuery = url ? [...url.searchParams] : [], credits = rows(item.subtitleLinks);
      if (!ref.id || ref.data.kind !== 'song' || item.id !== `track-section - song - ${ref.id}` || item.isDisabled !== false || !url || !title || !albumId || badAlbums.has(albumId) ||
        songQuery.length !== 1 || songQuery[0][0] !== 'i' || songQuery[0][1] !== ref.id || credits.length !== 1 || badSongs.has(ref.id) ||
        ref.data.albumID !== undefined && ref.data.albumID !== albumId) continue;
      const credit = credits[0], artist = text(credit.title), artistRef = descriptor(object(object(credit.segue).destination).contentDescriptor);
      if (!artist || !artistRef.id || artistRef.data.kind !== 'artist' || !catalog(artistRef.data.url, country, 'artist', artistRef.id) ||
        ref.data.artistID !== undefined && ref.data.artistID !== artistRef.id) continue;
      const value: ApplePublicSearchSong = { id: ref.id, albumId, artistId: artistRef.id, artist, title, ...(album ? { album } : {}), url: url.href };
      const image = artwork(item.artwork); if (image) value.artworkUrl = image;
      const previous = songs.get(ref.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) { songs.delete(ref.id); badSongs.add(ref.id); }
      else songs.set(ref.id, value);
    }
  }
  return { canonical: canonical.href, songs: [...songs.values()].slice(0, 48) };
}
