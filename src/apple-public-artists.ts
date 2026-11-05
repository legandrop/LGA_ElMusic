export interface ApplePublicRelatedArtist { id: string; name: string; url: string }
export interface ApplePublicArtistSong {
  id: string; albumId: string; artistId: string; artist: string; title: string; album: string; durationMs: number; artworkUrl?: string;
}
export interface ApplePublicArtistPage { canonical: string; related: ApplePublicRelatedArtist[]; songs: ApplePublicArtistSong[] }

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const rows = (value: unknown): Data[] => Array.isArray(value) ? value.slice(0, 100).map(object) : [];
const identifier = (value: unknown): string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : '';
const normalized = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) return '';
  try { encodeURIComponent(value); return value.trim(); } catch { return ''; }
}
function appleUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'music.apple.com' && !url.port && !url.username && !url.password && !url.hash) return url;
  } catch { /* Una referencia inválida no es un destino de navegación. */ }
}
function catalogUrl(value: unknown, country: string, kind: 'artist' | 'album', id: string): string | undefined {
  const url = appleUrl(value);
  if (url && !url.search && new RegExp(`^/${country}/${kind}/(?:[^/]+/)?${id}/?$`).test(url.pathname)) return url.href;
}
function descriptor(value: unknown): { data: Data; id: string } {
  const data = object(value); return { data, id: identifier(object(data.identifiers).storeAdamID) };
}
function sameDescriptor(value: unknown, kind: string, id: string, url: string): boolean {
  const other = descriptor(value); return other.id === id && other.data.kind === kind && other.data.url === url;
}
function artwork(value: unknown): string | undefined {
  const template = object(object(value).dictionary).url;
  if (typeof template !== 'string' || !/\/\{w\}x\{h\}(?:\{c\}|bb)\.\{f\}$/.test(template)) return;
  const rendered = template.replace('{w}', '100').replace('{h}', '100').replace('{c}', 'bb').replace('{f}', 'jpg');
  try {
    const url = new URL(rendered);
    if (url.protocol === 'https:' && url.hostname === 'is1-ssl.mzstatic.com' && !url.port && !url.username && !url.password && !url.search && !url.hash &&
      /^\/image\/thumb\/Music\d{1,3}\/v4\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{2}\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\/[A-Za-z\d._-]{1,240}\.(?:jpg|png)\/100x100bb\.jpg$/.test(url.pathname)) return url.href;
  } catch { /* La portada es opcional y nunca amplía la allowlist existente. */ }
}

export function parseArtistPage(html: string, country: string, expectedArtistId: string, expectedFullName: string): ApplePublicArtistPage {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 5 * 1024 * 1024 || !/^[a-z]{2}$/.test(country) || !identifier(expectedArtistId) || !text(expectedFullName))
    throw new Error('PUBLIC_ARTIST_METADATA_MISMATCH');
  let page: Data;
  try {
    const scripts = [...html.matchAll(/<script[^>]*id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/g)];
    if (scripts.length !== 1) throw new Error();
    const data = object(JSON.parse(scripts[0][1])).data;
    if (!Array.isArray(data) || data.length !== 1) throw new Error();
    page = object(data[0]);
  } catch { throw new Error('PUBLIC_ARTIST_DATA_INVALID'); }
  const intent = object(page.intent), expected = descriptor(intent.contentDescriptor), data = object(page.data);
  const sections = rows(data.sections), first = sections[0], headers = rows(first?.items), header = headers[0];
  const canonical = catalogUrl(data.canonicalURL, country, 'artist', expectedArtistId), prefix = `artists_${expectedArtistId}_default.marker.`;
  if (!Array.isArray(data.sections) || data.sections.length > 50 || intent.$kind !== 'ArtistDetailPageIntent' || expected.id !== expectedArtistId ||
    expected.data.kind !== 'artist' || object(expected.data.locale).storefront !== country || !canonical ||
    catalogUrl(expected.data.url, country, 'artist', expectedArtistId) !== canonical || first?.id !== prefix + 'ArtistDetailHeader-ArtistDetailHeader' ||
    first.itemKind !== 'artistDetailHeader' || headers.length !== 1 || !header || identifier(header.id) !== expectedArtistId ||
    !sameDescriptor(header.contentDescriptor, 'artist', expectedArtistId, canonical) || normalized(text(header.title)) !== normalized(expectedFullName))
    throw new Error('PUBLIC_ARTIST_METADATA_MISMATCH');

  const related = new Map<string, ApplePublicRelatedArtist>(), badRelated = new Set<string>();
  const albums = new Map<string, string>(), badAlbums = new Set<string>();
  for (const section of sections.slice(1)) {
    if (section.id === prefix + 'SimilarArtists-CircleLockupSection' && section.itemKind === 'bubbleLockup') {
      for (const item of rows(section.items)) {
        const ref = descriptor(item.contentDescriptor), name = text(item.title), url = catalogUrl(ref.data.url, country, 'artist', ref.id);
        if (!ref.id || ref.id === expectedArtistId || ref.data.kind !== 'artist' || identifier(item.id) !== ref.id || !name || !url ||
          !sameDescriptor(object(object(item.segue).destination).contentDescriptor, 'artist', ref.id, url) || badRelated.has(ref.id)) continue;
        const previous = related.get(ref.id);
        if (previous && (previous.name !== name || previous.url !== url)) { related.delete(ref.id); badRelated.add(ref.id); }
        else related.set(ref.id, { id: ref.id, name, url });
      }
    }
    if (typeof section.id === 'string' && new RegExp(`^artists_${expectedArtistId}_default\\.marker\\.(Albums|LiveAlbums|ArtistSingles|CompilationAlbums)-SquareLockupSection$`).test(section.id) && section.itemKind === 'squareLockup') {
      for (const item of rows(section.items)) {
        const ref = descriptor(item.contentDescriptor), links = rows(item.titleLinks), name = text(links[0]?.title);
        if (!ref.id || identifier(item.id) !== ref.id || ref.data.kind !== 'album' || !catalogUrl(ref.data.url, country, 'album', ref.id) || links.length !== 1 || !name || badAlbums.has(ref.id)) continue;
        if (albums.has(ref.id) && albums.get(ref.id) !== name) { albums.delete(ref.id); badAlbums.add(ref.id); }
        else albums.set(ref.id, name);
      }
    }
  }

  const songs = new Map<string, ApplePublicArtistSong>(), badSongs = new Set<string>();
  for (const section of sections.slice(1)) {
    let tracks: Data[] = [];
    if (section.id === prefix + 'TopSongs-TrackLockupSection' && section.itemKind === 'trackLockup') tracks = rows(section.items);
    if (section.id === prefix + 'shelfgroup.FeaturedContent.TopSongs-ArtistFeaturedContentAndTracks' && section.itemKind === 'artistFeaturedContentAndTracks' && rows(section.items).length === 1)
      tracks = rows(rows(section.items)[0].tracks);
    for (const item of tracks) {
      const ref = descriptor(item.contentDescriptor), url = appleUrl(ref.data.url), title = text(item.title), durationMs = item.duration;
      const albumId = url?.pathname.match(new RegExp(`^/${country}/album/(?:[^/]+/)?([1-9]\\d{0,19})/?$`))?.[1] ?? '';
      const album = albums.get(albumId), query = url ? [...url.searchParams] : [];
      if (!ref.id || ref.data.kind !== 'song' || identifier(item.id) !== ref.id || !url || !album || !title || badSongs.has(ref.id) ||
        query.length !== 1 || query[0][0] !== 'i' || query[0][1] !== ref.id || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 86400000 ||
        ref.data.albumID !== undefined && ref.data.albumID !== albumId || ref.data.artistID !== undefined && ref.data.artistID !== expectedArtistId) continue;
      const playItems = object(item.playAction).items;
      if (playItems !== undefined && (!Array.isArray(playItems) || playItems.length !== 1 || !sameDescriptor(object(playItems[0]).contentDescriptor, 'song', ref.id, url.href))) continue;
      const value: ApplePublicArtistSong = { id: ref.id, albumId, artistId: expectedArtistId, artist: text(header.title), title, album, durationMs };
      const image = artwork(item.artwork); if (image) value.artworkUrl = image;
      const previous = songs.get(ref.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) { songs.delete(ref.id); badSongs.add(ref.id); }
      else songs.set(ref.id, value);
    }
  }
  return { canonical, related: [...related.values()].slice(0, 12), songs: [...songs.values()].slice(0, 48) };
}
