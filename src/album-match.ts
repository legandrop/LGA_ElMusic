// Elección de un álbum entre resultados de búsqueda del catálogo de Apple o de iTunes, por nombre y artista. La usan la
// columna Label (filas sin enlace de álbum) y el panel de un sello (discos de MusicBrainz sin enlace a Apple).
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, 200).trim();
// Artistas de la fila: según la vista Apple los separa con «·», «,», «&» o «feat.». El primero va en la búsqueda; con
// todos juntos el catálogo a veces no devuelve nada (p. ej. «Oscar Brown, Jr.· Matthew Herbert Verve Remixed 2»).
const creditSplit = /\s*(?:·|,|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\bwith\b)\s*/i;
export function primaryArtist(artist: string): string { return clean(artist.split(creditSplit).find(part => part.trim()) ?? artist); }

// released = fecha ISO del álbum en el catálogo; genre = primer género que no sea el genérico «Music».
// artists: nombre e ID de catálogo de cada artista del álbum, de la relación pública artists del mismo pedido
// /albums (include=artists); sólo para enlazar el artista en las filas donde Apple no lo enlaza. Sin el dato (búsquedas),
// undefined; un álbum sin artistas en el catálogo, [].
export type AlbumArtist = [name: string, id: string];
export interface CatalogAlbum { id: string; name: string; artist: string; label: string; copyright: string; released?: string; genre?: string; artists?: AlbumArtist[] }
export const releasedPattern = /^\d{4}(?:-\d{2}){0,2}$/;
export const albumArtistLimit = 6;
export function albumArtists(value: unknown): AlbumArtist[] | undefined {
  if (!Array.isArray(value) || value.length > albumArtistLimit) return;
  const pairs = value.filter((pair): pair is AlbumArtist => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
    !!pair[0].trim() && pair[0].length <= 240 && typeof pair[1] === 'string' && /^\d{1,20}$/.test(pair[1]));
  return pairs.length === value.length ? pairs.map(([name, id]) => [name.replace(/\s+/g, ' ').trim(), id]) : undefined;
}
export function catalogAlbums(value: unknown): CatalogAlbum[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((item): item is CatalogAlbum => !!item && /^\d{1,20}$/.test(String(item.id)) &&
    ['name', 'artist', 'label', 'copyright'].every(field => typeof item[field] === 'string') &&
    (item.released === undefined || (typeof item.released === 'string' && releasedPattern.test(item.released))) &&
    (item.genre === undefined || (typeof item.genre === 'string' && item.genre.length <= 80)) &&
    (item.artists === undefined || albumArtists(item.artists) !== undefined))
    .map(item => item.artists === undefined ? item : { ...item, artists: albumArtists(item.artists)! });
}
// Comparación sin acentos (NFKD y sin marcas), sin distinguir apóstrofos tipográficos del recto ni mayúsculas: la biblioteca
// puede escribir «Ezechiel Pailhes» y «Baker's Dozen» donde el catálogo tiene «Ézéchiel Pailhès» y «Baker’s Dozen».
const plain = (value: string): string => value.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[‘’´`]/g, '\'').replace(/[“”]/g, '"')
  .toLowerCase().replace(/[\s·,&]+/g, ' ').trim();
// Nombre flexible: sin « - Single»/« - EP» (también «EP» pegado al final, como «Sketch on glass EP» por «Sketch on Glass - EP»)
// ni agregados de edición entre paréntesis o corchetes (Deluxe, Remastered…).
const loose = (value: string): string => plain(value).replace(/\s*[([][^)\]]*(?:deluxe|remaster|edition|edición|version|versión|expanded|bonus)[^)\]]*[)\]]/g, '')
  .replace(/\s+-\s+single$/, '').replace(/\s+(?:-\s+)?ep$/, '').trim();
// Primero el mismo nombre de álbum y, si no, el nombre flexible; además, un artista compartido con cualquiera de los de la
// fila. Un recopilatorio de «Various Artists» sólo si todos los álbumes con ese nombre lo son y tienen el mismo sello.
export function pickSearchedAlbum(value: unknown, artist: string, album: string): CatalogAlbum | undefined {
  const albums = catalogAlbums(value), credit = plain(artist);
  const parts = [...new Set(artist.split(creditSplit).map(plain).filter(part => part.length > 1))];
  const owns = (item: CatalogAlbum): boolean => {
    const owner = plain(item.artist);
    return !!owner && (credit.includes(owner) || owner.includes(credit) || parts.some(part => owner.includes(part) || part.includes(owner)));
  };
  const various = (item: CatalogAlbum): boolean => /^(?:various artists|varios artistas|artistas varios)$/.test(plain(item.artist));
  for (const same of [albums.filter(item => plain(item.name) === plain(album)), albums.filter(item => loose(item.name) === loose(album))]) {
    const found = same.find(owns) ?? (same.length && same.every(various) && new Set(same.map(item => item.label)).size === 1 ? same[0] : undefined);
    if (found) return found;
  }
}
