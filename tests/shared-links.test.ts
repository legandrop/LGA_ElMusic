import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { appleTarget, catalogTarget, coreTitle, fullTitle, installSharedLinks, parseSharedLink, pasteListenerScript, pickAlbum, pickArtist, pickSong,
  readSpotify, readSpotifyItem, resolveSpotifyShort, searchTarget, spotifyEmbedItem, wakeMessage } from '../src/shared-links';
import type { AppleLink, Fetcher } from '../src/shared-links';

const spotifyTrack = '4PTG3Z6ehGkBFwjybzWkR8', spotifyAlbum = '6eUW0wxWtzkFdaEFsTJto6', spotifyArtist = '0gxyHStUsqpMadRV0Di1Qt';

test('Apple Music links keep only the kind, ID, slug, ?i= song and country', () => {
  assert.deepEqual(parseSharedLink('https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475'),
    { source: 'apple', kind: 'album', id: '6814570475', slug: 'from-healer-to-dealer-single', country: 'ar' });
  assert.deepEqual(parseSharedLink('https://music.apple.com/us/album/never-gonna/1559523357?i=1559523359&l=es-MX&ls=1&at=affiliate'),
    { source: 'apple', kind: 'album', id: '1559523357', slug: 'never-gonna', song: '1559523359', country: 'us' });
  assert.deepEqual(parseSharedLink('https://geo.music.apple.com/gb/song/1559523359'), { source: 'apple', kind: 'song', id: '1559523359', country: 'gb' });
  assert.deepEqual(parseSharedLink('https://itunes.apple.com/us/album/name/id1440857781?i=1440857796&uo=4'),
    { source: 'apple', kind: 'album', id: '1440857781', slug: 'name', song: '1440857796', country: 'us' });
  assert.deepEqual(parseSharedLink('https://embed.music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb'),
    { source: 'apple', kind: 'playlist', id: 'pl.f4d106fed2bd41149aaacabb233eb5eb', slug: 'todays-hits', country: 'us' });
  assert.deepEqual(parseSharedLink('https://music.apple.com/artist/123'), { source: 'apple', kind: 'artist', id: '123' });
  assert.equal(parseSharedLink('https://music.apple.com/ar/station/x/ra.978194965')?.source, 'apple');
  for (const value of ['https://music.apple.com/ar/library/playlist/p.abc', 'https://music.apple.com/ar/album/name/12a', 'https://music.apple.com/ar/playlist/x/12',
    'https://user:pass@music.apple.com/ar/album/1', 'https://music.apple.com:444/ar/album/1', 'https://music.apple.com.evil.test/ar/album/1', 'ftp://music.apple.com/ar/album/1',
    'https://music.apple.com/ar/album/a/b/1', 'https://music.apple.com/ar/album/1 extra', 'javascript:alert(1)', '', 42, null])
    assert.equal(parseSharedLink(value), undefined, String(value));
});

test('Spotify links accept tracks, albums, artists and short links, with or without language prefix', () => {
  assert.deepEqual(parseSharedLink(`https://open.spotify.com/track/${spotifyTrack}?si=abc123`), { source: 'spotify', kind: 'track', id: spotifyTrack });
  assert.deepEqual(parseSharedLink(`https://open.spotify.com/intl-es/album/${spotifyAlbum}`), { source: 'spotify', kind: 'album', id: spotifyAlbum });
  assert.deepEqual(parseSharedLink(`https://open.spotify.com/embed/artist/${spotifyArtist}`), { source: 'spotify', kind: 'artist', id: spotifyArtist });
  assert.deepEqual(parseSharedLink(`spotify:track:${spotifyTrack}`), { source: 'spotify', kind: 'track', id: spotifyTrack });
  assert.deepEqual(parseSharedLink('https://spotify.link/AbC123xyz'), { source: 'spotify-short', url: 'https://spotify.link/AbC123xyz' });
  for (const value of [`https://open.spotify.com/track/${spotifyTrack.slice(1)}`, `https://open.spotify.com/user/${spotifyTrack}`, `https://open.spotify.com.evil.test/track/${spotifyTrack}`, 'https://spotify.link/a/b'])
    assert.equal(parseSharedLink(value), undefined, value);
});

test('targets always stay on music.apple.com in the account storefront', () => {
  const link = parseSharedLink('https://music.apple.com/us/album/never-gonna/1559523357?i=1559523359') as AppleLink;
  assert.equal(appleTarget(link, 'ar'), 'https://music.apple.com/ar/album/never-gonna/1559523357?i=1559523359');
  assert.throws(() => appleTarget(link, 'arg'));
  assert.equal(catalogTarget('https://music.apple.com/ar/album/never-gonna-give-you-up/1559523357?i=1559523359', 'ar', 'song', '1559523359'),
    'https://music.apple.com/ar/album/never-gonna-give-you-up/1559523357?i=1559523359');
  assert.equal(catalogTarget('https://music.apple.com/us/album/x/1559523357', 'ar', 'album', '1559523357'), undefined);
  assert.equal(catalogTarget('https://music.apple.com/ar/album/x/999', 'ar', 'album', '1559523357'), undefined);
  assert.equal(catalogTarget('https://evil.test/ar/album/x/1559523357', 'ar', 'album', '1559523357'), undefined);
  assert.equal(searchTarget('Never Gonna  Give You Up Rick Astley', 'ar'), 'https://music.apple.com/ar/search?term=Never%20Gonna%20Give%20You%20Up%20Rick%20Astley');
});

const embed = (entity: unknown): string => `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></body></html>`;
const trackEntity = { type: 'track', name: 'Never Gonna Give You Up', uri: `spotify:track:${spotifyTrack}`, id: spotifyTrack, artists: [{ name: 'Rick Astley', uri: 'spotify:artist:x' }],
  releaseDate: { isoString: '1987-11-16T00:00:00Z' }, duration: 213573 };
const albumEntity = { type: 'album', name: 'Whenever You Need Somebody', uri: `spotify:album:${spotifyAlbum}`, id: spotifyAlbum, subtitle: 'Rick Astley', releaseDate: null, duration: 0 };

test('the public Spotify embed gives name, artists and duration only when it is the requested item', () => {
  assert.deepEqual(spotifyEmbedItem(embed(trackEntity), 'track', spotifyTrack),
    { kind: 'track', name: 'Never Gonna Give You Up', artist: 'Rick Astley', artists: ['Rick Astley'], duration: 213573, year: '1987' });
  assert.deepEqual(spotifyEmbedItem(embed(albumEntity), 'album', spotifyAlbum),
    { kind: 'album', name: 'Whenever You Need Somebody', artist: 'Rick Astley', artists: ['Rick Astley'], duration: 0 });
  assert.equal(spotifyEmbedItem(embed({ type: 'artist', name: 'Rick Astley', id: spotifyArtist }), 'artist', spotifyArtist)?.name, 'Rick Astley');
  assert.equal(spotifyEmbedItem(embed(trackEntity), 'track', spotifyAlbum), undefined, 'otro ID');
  assert.equal(spotifyEmbedItem(embed(trackEntity), 'album', spotifyTrack), undefined, 'otro tipo');
  assert.equal(spotifyEmbedItem(embed(trackEntity) + embed(trackEntity), 'track', spotifyTrack), undefined, 'dos bloques de datos');
  assert.equal(spotifyEmbedItem('<script id="__NEXT_DATA__">{oops</script>', 'track', spotifyTrack), undefined);
  assert.equal(spotifyEmbedItem(embed({ ...trackEntity, artists: [] }), 'track', spotifyTrack), undefined, 'sin artista');
});

const song = (id: string, name: string, artist: string, duration: number, album = 'Album') =>
  ({ id, name, artist, album, duration, url: `https://music.apple.com/ar/album/x/9${id}?i=${id}` });
test('song choice: same title and artist, closest duration; remasters and other artists are not taken for the original', () => {
  const wanted = { name: 'Never Gonna Give You Up', artists: ['Rick Astley'], duration: 213573 };
  const results = [song('1', 'Never Gonna Give You Up (2022 Remaster)', 'Rick Astley', 213560), song('2', 'Never Gonna Give You Up', 'Cover Band', 213000),
    song('3', 'Never Gonna Give You Up', 'Rick Astley', 216000), song('4', 'Never Gonna Give You Up', 'Rick Astley', 213600)];
  assert.equal(pickSong(results, wanted)?.id, '4');
  assert.equal(pickSong([results[0], results[1]], wanted)?.id, '1', 'sin el original, el remaster de la misma duración');
  assert.equal(pickSong([song('5', 'Never Gonna Give You Up', 'Rick Astley', 230000)], wanted), undefined, 'duración lejana');
  assert.equal(pickSong([results[1]], wanted), undefined, 'otro artista');
  assert.equal(pickSong([song('6', 'Song (Remastered 2011)', 'The Band', 200000)], { name: 'Song - Remastered 2011', artists: ['The Band'], duration: 201000 })?.id, '6');
  assert.equal(pickSong([song('7', 'Levitating (feat. DaBaby)', 'Dua Lipa & DaBaby', 203000)], { name: 'Levitating (feat. DaBaby)', artists: ['Dua Lipa', 'DaBaby'], duration: 203064 })?.id, '7');
  assert.equal(fullTitle('Song - 2022 Remaster'), 'song (2022 remaster)');
  assert.equal(coreTitle('Song - 2022 Remaster'), 'song');
});

test('album and artist choice reuse the label matcher and refuse homonyms', () => {
  const albums = [{ id: '10', name: 'Whenever You Need Somebody (Deluxe Edition)', artist: 'Rick Astley', album: '', duration: 0, url: '' },
    { id: '11', name: 'Whenever You Need Somebody', artist: 'Rick Astley', album: '', duration: 0, url: '' }];
  assert.equal(pickAlbum(albums, { name: 'Whenever You Need Somebody', artist: 'Rick Astley' })?.id, '11');
  assert.equal(pickAlbum([albums[0]], { name: 'Whenever You Need Somebody', artist: 'Rick Astley' })?.id, '10');
  assert.equal(pickAlbum(albums, { name: 'Whenever You Need Somebody', artist: 'Someone Else' }), undefined);
  const various = [{ id: '20', name: 'Hits', artist: 'Various Artists', album: '', duration: 0, url: '' }, { id: '21', name: 'Hits', artist: 'Various Artists', album: '', duration: 0, url: '' }];
  assert.equal(pickAlbum(various, { name: 'Hits', artist: 'Various Artists' }), undefined, 'dos ediciones del recopilatorio');
  const artists = [{ id: '30', name: 'Rick Astley', artist: '', album: '', duration: 0, url: 'https://music.apple.com/ar/artist/rick-astley/30' }];
  assert.equal(pickArtist(artists, 'rick astley')?.id, '30');
  assert.equal(pickArtist([...artists, { ...artists[0], id: '31' }], 'Rick Astley'), undefined);
});

// Detector de pegado en un documento falso: sólo fuera de campos de texto o en el buscador de Apple.
function pasteContext() {
  class Element { constructor(readonly tagName: string, readonly field: Element | null = null, readonly type = '', readonly searchy = false) {}
    closest(selector: string) { return selector.startsWith('input') ? this.field : this.searchy ? this : null; } }
  const listeners: Array<(event: object) => void> = [], debug: string[] = [];
  const root: { dataset: Record<string, string>; [key: symbol]: unknown } = { dataset: {} };
  const location = { href: 'https://music.apple.com/ar/new', protocol: 'https:', hostname: 'music.apple.com', port: '', pathname: '/ar/new' };
  // Aviso de trabajo que la página dibuja con el pegado (0.1.55) y eventos de la línea de carga.
  class Node {
    dataset: Record<string, string> = {}; children: Array<Node | string> = []; id = ''; className = ''; textContent = ''; isConnected = false;
    constructor(readonly tagName: string) {}
    setAttribute() { /* role y aria-hidden */ }
    append(...items: Array<Node | string>) { this.children.push(...items); }
    remove() { this.isConnected = false; if (toast === this) toast = null; }
    text(): string { return this.textContent || this.children.map(child => typeof child === 'string' ? child : child.text()).join(''); }
  }
  let toast: Node | null = null; const busy: unknown[] = [];
  const context: Record<string, unknown> = { URL, Element, location, console: { debug: (message: string) => debug.push(message) }, setTimeout: () => 0,
    CustomEvent: class { detail: unknown; constructor(readonly type: string, init: { detail: unknown }) { this.detail = init.detail; } },
    dispatchEvent: (event: { type: string; detail: unknown }) => { assert.equal(event.type, 'el-music:busy'); busy.push(event.detail); return true; },
    document: { documentElement: root, getElementById: (id: string) => id === 'el-music-toast' ? toast : null, createElement: (tag: string) => new Node(tag),
      body: { appendChild: (node: Node) => { node.isConnected = true; toast = node; return node; } },
      addEventListener: (type: string, fn: (event: object) => void, capture: boolean) => { assert.equal(type, 'paste'); assert.equal(capture, true); listeners.push(fn); } } };
  context.top = context; context.self = context;
  assert.equal(new vm.Script(pasteListenerScript).runInNewContext(context), true);
  assert.equal(new vm.Script(pasteListenerScript).runInNewContext(context), true);
  assert.equal(listeners.length, 1, 'se instala una sola vez');
  const paste = (text: string, target: InstanceType<typeof Element>) => {
    let prevented = false;
    listeners[0]({ clipboardData: { getData: () => text }, composedPath: () => [target], target, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {} });
    const value = root.dataset.elMusicSharedLink; delete root.dataset.elMusicSharedLink;
    return { prevented, value };
  };
  const shown = () => toast ? { owner: toast.dataset.elMusicOwner, working: toast.dataset.elMusicWorking, title: (toast.children[0] as Node).text(), detail: (toast.children[1] as Node).text() } : null;
  return { Element, paste, debug, root, shown, busy };
}
test('pasting a music link outside a text field takes the first link and tells main; text fields keep their paste', () => {
  const { Element, paste, debug, root, shown, busy } = pasteContext();
  const body = new Element('BODY');
  assert.deepEqual(paste('Escuchá esto: https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475).', body),
    { prevented: true, value: 'https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475' });
  assert.equal(debug.at(-1), wakeMessage);
  assert.equal(root.dataset.elMusicSharedLinkSeq, '1');
  // El aviso y la línea de carga salen con el pegado, sin esperar a main.
  assert.deepEqual(shown(), { owner: 'shared-link:1', working: '1', title: 'Opening the Apple Music link…', detail: 'Apple Music link' });
  assert.deepEqual(JSON.parse(JSON.stringify(busy)), [{ op: 'start', kind: 'paste', owner: 'paste:1', limit: 120000 }]);
  assert.deepEqual(paste(`https://open.spotify.com/track/${spotifyTrack}?si=1`, body), { prevented: true, value: `https://open.spotify.com/track/${spotifyTrack}?si=1` });
  assert.equal(root.dataset.elMusicSharedLinkSeq, '2', 'cada pegado lleva su número');
  assert.deepEqual(shown(), { owner: 'shared-link:2', working: '1', title: 'Finding it on Apple Music…', detail: 'Spotify link' }, 'el aviso nuevo reemplaza al anterior');
  assert.deepEqual(paste('hola, sin enlace', body), { prevented: false, value: undefined });
  assert.deepEqual(paste('https://example.com/album/1', body), { prevented: false, value: undefined });
  // Un enlace de Apple o Spotify que no es de un contenido se pega normalmente.
  assert.deepEqual(paste('https://music.apple.com/ar/browse', body), { prevented: false, value: undefined });
  assert.deepEqual(paste('https://open.spotify.com/user/someone', body), { prevented: false, value: undefined });
  assert.equal(root.dataset.elMusicSharedLinkSeq, '2');
  const textarea = new Element('TEXTAREA'); const inTextarea = new Element('TEXTAREA', textarea);
  assert.deepEqual(paste('https://music.apple.com/ar/album/x/1', inTextarea), { prevented: false, value: undefined });
  const searchInput = new Element('INPUT', null, 'search'); const inSearch = new Element('INPUT', searchInput, 'search');
  Object.assign(searchInput, { field: searchInput });
  assert.equal(paste('https://music.apple.com/ar/album/x/1', inSearch).prevented, true);
  const textInput = new Element('INPUT', null, 'text'); Object.assign(textInput, { field: textInput });
  assert.equal(paste('https://music.apple.com/ar/album/x/1', textInput).prevented, false);
});

// Respuestas falsas de Spotify: cuerpo HTML o redirección.
const html = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirect = (location: string): Response => new Response(null, { status: 301, headers: { location } });
test('Spotify reads retry network failures three times (firewall prompt) but not HTTP errors, and only on Spotify hosts', async () => {
  let calls = 0;
  const flaky: Fetcher = async () => { if (++calls < 4) throw new TypeError('fetch failed'); return html(embed(trackEntity)); };
  assert.equal((await readSpotifyItem('track', spotifyTrack, new AbortController().signal, flaky, 0))?.duration, 213573);
  assert.equal(calls, 4);
  calls = 0;
  const down: Fetcher = async () => { calls++; throw new TypeError('fetch failed'); };
  await assert.rejects(readSpotify('https://open.spotify.com/embed/track/x', new AbortController().signal, down, 0), /SPOTIFY_NETWORK/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(readSpotifyItem('track', spotifyTrack, new AbortController().signal, async () => { calls++; return html('', 404); }, 0), /SPOTIFY_HTTP/);
  assert.equal(calls, 1);
  await assert.rejects(readSpotify('https://evil.test/embed/track/x', new AbortController().signal, down, 0), /ENDPOINT_DENIED/);
  await assert.rejects(readSpotifyItem('track', spotifyTrack, new AbortController().signal, async () => redirect('https://evil.test/'), 0), /SPOTIFY_REDIRECT/);
  const seen: RequestInit[] = [];
  await readSpotify('https://open.spotify.com/embed/track/x', new AbortController().signal, async (_url, init) => { seen.push(init); return html('ok'); }, 0);
  assert.equal(seen[0].credentials, 'omit'); assert.equal(seen[0].redirect, 'manual');
});
test('short Spotify links follow redirects or a single link in the page', async () => {
  const hops: string[] = [];
  const fetcher: Fetcher = async url => { hops.push(url); return url.includes('spotify.link') ? redirect(`https://open.spotify.com/track/${spotifyTrack}?si=x`) : html(''); };
  assert.deepEqual(await resolveSpotifyShort('https://spotify.link/AbC', new AbortController().signal, fetcher, 0), { source: 'spotify', kind: 'track', id: spotifyTrack });
  assert.deepEqual(hops, ['https://spotify.link/AbC']);
  const page: Fetcher = async () => html(`<a href="https://open.spotify.com/album/${spotifyAlbum}">x</a><a href="https://open.spotify.com/album/${spotifyAlbum}">y</a>`);
  assert.equal((await resolveSpotifyShort('https://spoti.fi/x', new AbortController().signal, page, 0))?.kind, 'album');
  const two: Fetcher = async () => html(`https://open.spotify.com/album/${spotifyAlbum} https://open.spotify.com/track/${spotifyTrack}`);
  assert.equal(await resolveSpotifyShort('https://spoti.fi/x', new AbortController().signal, two, 0), undefined);
  assert.equal(await resolveSpotifyShort('https://spoti.fi/x', new AbortController().signal, async () => redirect('https://evil.test/track/x'), 0), undefined);
});

// Recorrido completo con una página falsa: pegar → main lee el enlace → catálogo/búsqueda → navegación del enrutador.
// La página falsa lleva el número del último pegado como la real: rechaza navegación y avisos de un pegado anterior, muestra
// su propio aviso de trabajo al pegar (0.1.55) y sólo retira el aviso de trabajo de su dueño (al navegar o al limpiar).
function musicPage(options: { storefront?: string; catalog?: (script: string) => unknown; search?: (script: string) => unknown; moved?: boolean; fetcher?: Fetcher } = {}) {
  const contents = new EventEmitter() as EventEmitter & { mainFrame: { executeJavaScript: (script: string) => Promise<unknown> }; getURL: () => string; isDestroyed: () => boolean };
  const navigations: string[] = [], toasts: string[] = [], logs: Array<[string, Record<string, boolean | number> | undefined]> = [];
  let taken: unknown = null, pageSeq = 0, shown: { seq: string; title: string; working: boolean } | null = null;
  const busyEnds: string[] = []; let took = 0;
  const seqOf = (script: string, pattern: RegExp): string => script.match(pattern)![1];
  contents.getURL = () => 'https://music.apple.com/ar/new';
  contents.isDestroyed = () => false;
  contents.mainFrame = { executeJavaScript: async (script: string) => {
    if (script.includes('delete root.dataset.elMusicSharedLink')) { const value = taken; taken = null; if (value) took++; return value; }
    if (script.includes("addEventListener('paste'")) return true;
    if (script.includes('history.pushState')) {
      if (seqOf(script, /elMusicSharedLinkSeq !== "(\d+)"/) !== String(pageSeq)) return 'stale';
      if (options.moved) return 'moved';
      if (shown?.working && script.includes(`"shared-link:${shown.seq}"`)) shown = null;
      navigations.push(JSON.parse(script.match(/history\.pushState\(null, '', ("[^"]*")\)/)![1]) as string); return 'opened';
    }
    if (script.includes('el-music-toast__detail')) {
      const seq = seqOf(script, /elMusicSharedLinkSeq !== "(\d+)"/); if (seq !== String(pageSeq)) return false;
      const title = JSON.parse(script.match(/row\.textContent = ("[^"]*")/)![1]) as string; toasts.push(title); shown = { seq, title, working: script.includes("box.dataset.elMusicWorking = '1'") }; return true;
    }
    if (script.includes('elMusicOwner === ')) {
      const seq = seqOf(script, /"shared-link:(\d+)"/);
      if (shown?.seq === seq && shown.working) shown = null;
      busyEnds.push(seqOf(script, /"paste:(\d+)"/)); return true;
    }
    if (script.includes('/search')) return options.search ? options.search(script) : [];
    if (script.includes('/v1/catalog/')) return options.catalog ? options.catalog(script) : { error: 404 };
    throw new Error('script inesperado');
  } };
  const fetches: string[] = [];
  const fetcher: Fetcher = options.fetcher ?? (async url => { fetches.push(url); return html(embed(trackEntity)); });
  installSharedLinks(contents as unknown as WebContents, (event, fields) => logs.push([event, fields]), () => logs.push(['falla', undefined]), fetcher, 0);
  const settle = async (done: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const paste = async (link: string, done: () => boolean): Promise<void> => {
    pageSeq++;
    // Como la página real: el aviso de trabajo sale con el pegado, antes de que main tome el enlace.
    const title = /apple\.com/i.test(link) ? 'Opening the Apple Music link…' : 'Finding it on Apple Music…';
    toasts.push(title); shown = { seq: String(pageSeq), title, working: true };
    taken = { link, storefront: options.storefront ?? 'ar', page: 'https://music.apple.com/ar/new', seq: String(pageSeq) };
    contents.emit('console-message', { message: wakeMessage, frame: contents.mainFrame });
    await new Promise(resolve => setTimeout(resolve, 5)); // main toma el enlace de forma asíncrona
    await settle(done);
  };
  return { contents, navigations, toasts, logs, fetches, busyEnds, took: () => took, paste, settle, shown: () => shown, stop: () => contents.emit('destroyed') };
}
test('an Apple link opens in the account storefront with the canonical catalog URL', async () => {
  const page = musicPage({ catalog: script => script.includes('/v1/catalog/ar/albums/6814570475')
    ? { id: '6814570475', name: 'From Healer to Dealer - Single', artist: 'Artist', album: '', duration: 0, url: 'https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475' } : { error: 404 } });
  try {
    await page.paste('https://music.apple.com/us/album/from-healer-to-dealer-single/6814570475?ls=1', () => page.navigations.length > 0);
    assert.deepEqual(page.navigations, ['https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475']);
    assert.deepEqual(page.fetches, [], 'un enlace de Apple no sale a Internet desde main');
    assert.equal(page.logs.find(([event]) => event === 'Enlace pegado')?.[1]?.resultado, 1);
    await page.settle(() => page.busyEnds.length > 0);
    assert.equal(page.shown(), null, 'el aviso «Opening…» deja su lugar a la línea de carga al navegar');
    assert.deepEqual(page.busyEnds, ['1'], 'main avisa el fin del pegado (la página lo ignora si ya navegó)');
  } finally { page.stop(); }
});
test('an Apple link missing from the account storefront looks for the same song by name there', async () => {
  const page = musicPage({
    catalog: script => script.includes('/v1/catalog/us/songs/111') ? { id: '111', name: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever', duration: 213573, url: 'https://music.apple.com/us/album/x/100?i=111' } : { error: 404 },
    search: script => script.includes("types: 'songs'") ? [song('222', 'Never Gonna Give You Up', 'Rick Astley', 213600)] : [] });
  try {
    await page.paste('https://music.apple.com/us/album/x/100?i=111', () => page.toasts.length > 1);
    assert.deepEqual(page.navigations, ['https://music.apple.com/ar/album/x/9222?i=222']);
    assert.deepEqual(page.toasts, ['Opening the Apple Music link…', 'Rick Astley – Never Gonna Give You Up']);
  } finally { page.stop(); }
});
test('a Spotify track opens the matching Apple song; without a match it opens Apple search', async () => {
  const found = musicPage({ search: script => script.includes("types: 'songs'") ? [song('333', 'Never Gonna Give You Up', 'Rick Astley', 213600)] : [] });
  try {
    await found.paste(`https://open.spotify.com/track/${spotifyTrack}?si=abc`, () => found.toasts.length > 1);
    assert.deepEqual(found.fetches, [`https://open.spotify.com/embed/track/${spotifyTrack}`]);
    assert.deepEqual(found.navigations, ['https://music.apple.com/ar/album/x/9333?i=333']);
    assert.deepEqual(found.toasts, ['Finding it on Apple Music…', 'Rick Astley – Never Gonna Give You Up']);
  } finally { found.stop(); }
  const missing = musicPage();
  try {
    await missing.paste(`https://open.spotify.com/track/${spotifyTrack}`, () => missing.toasts.length > 1);
    assert.deepEqual(missing.navigations, ['https://music.apple.com/ar/search?term=Never%20Gonna%20Give%20You%20Up%20Rick%20Astley']);
    assert.equal(missing.toasts[1], 'No exact match on Apple Music');
  } finally { missing.stop(); }
});
test('a paste is dropped if the page moved on, and Spotify playlists are refused without reading Spotify', async () => {
  const moved = musicPage({ moved: true, search: () => [song('333', 'Never Gonna Give You Up', 'Rick Astley', 213600)] });
  try {
    await moved.paste(`https://open.spotify.com/track/${spotifyTrack}`, () => moved.logs.some(([event]) => event === 'Enlace pegado'));
    assert.deepEqual(moved.navigations, []);
    assert.equal(moved.logs.find(([event]) => event === 'Enlace pegado')?.[1]?.resultado, 0);
  } finally { moved.stop(); }
  const playlist = musicPage();
  try {
    await playlist.paste('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', () => playlist.toasts.length > 1);
    assert.deepEqual(playlist.fetches, []); assert.deepEqual(playlist.navigations, []);
    assert.deepEqual(playlist.toasts, ['Finding it on Apple Music…', 'Spotify playlists can’t be opened here']);
    await playlist.settle(() => playlist.busyEnds.length > 0);
    assert.equal(playlist.shown()?.title, 'Spotify playlists can’t be opened here', 'el resultado final no se retira con la limpieza');
  } finally { playlist.stop(); }
});

// Escenarios de la revisión independiente: un pegado nuevo mientras se resuelve uno de Spotify, y cambiar de pantalla.
const albumCatalog = (script: string) => script.includes('/v1/catalog/ar/albums/6814570475')
  ? { id: '6814570475', name: 'From Healer to Dealer - Single', artist: 'Artist', album: '', duration: 0, url: 'https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475' } : { error: 404 };
function slowSpotify() {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: Fetcher = async (_url, init) => {
    await gate; (init.signal as AbortSignal | undefined)?.throwIfAborted();
    return html(embed(trackEntity));
  };
  return { fetcher, release: () => release() };
}
test('pasting an Apple link while a Spotify link is still resolving opens only the Apple one and leaves no stuck notice', async () => {
  const spotify = slowSpotify();
  const page = musicPage({ fetcher: spotify.fetcher, catalog: albumCatalog, search: () => [song('333', 'Never Gonna Give You Up', 'Rick Astley', 213600)] });
  try {
    await page.paste(`https://open.spotify.com/track/${spotifyTrack}`, () => page.took() > 0);
    assert.equal(page.shown()?.title, 'Finding it on Apple Music…');
    await page.paste('https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475', () => page.navigations.length > 0);
    spotify.release();
    await page.settle(() => page.shown() === null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(page.navigations, ['https://music.apple.com/ar/album/from-healer-to-dealer-single/6814570475']);
    assert.equal(page.shown(), null, 'el aviso «Finding…» del pedido cancelado no queda en pantalla');
    assert.deepEqual(page.logs.filter(([event]) => event === 'Enlace pegado').map(([, fields]) => fields?.origen), [1]);
  } finally { page.stop(); }
});
test('changing screens while a Spotify link resolves cancels it, but the paste’s own navigation keeps its notice', async () => {
  const spotify = slowSpotify();
  const page = musicPage({ fetcher: spotify.fetcher, search: () => [song('333', 'Never Gonna Give You Up', 'Rick Astley', 213600)] });
  try {
    await page.paste(`https://open.spotify.com/track/${spotifyTrack}`, () => page.took() > 0);
    page.contents.emit('did-navigate-in-page', {}, 'https://music.apple.com/ar/browse', true);
    spotify.release();
    await page.settle(() => page.shown() === null);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(page.navigations, []); assert.equal(page.shown(), null);
    const found = musicPage({ search: () => [song('333', 'Never Gonna Give You Up', 'Rick Astley', 213600)] });
    try {
      found.contents.on('did-navigate-in-page', () => {});
      await found.paste(`https://open.spotify.com/track/${spotifyTrack}`, () => found.navigations.length > 0);
      found.contents.emit('did-navigate-in-page', {}, found.navigations[0], true);
      await found.settle(() => found.toasts.length > 1);
      assert.equal(found.toasts.at(-1), 'Rick Astley – Never Gonna Give You Up');
    } finally { found.stop(); }
  } finally { page.stop(); }
});
test('a paste main does not recognise replaces the page’s «Opening…» notice with the reason and ends its loading line', async () => {
  const page = musicPage();
  try {
    await page.paste('https://music.apple.com/ar/album/x/notanid', () => page.busyEnds.length > 0);
    assert.deepEqual(page.navigations, []);
    assert.deepEqual(page.toasts, ['Opening the Apple Music link…', 'This link could not be opened']);
    assert.equal(page.shown()?.title, 'This link could not be opened');
    assert.deepEqual(page.busyEnds, ['1']);
  } finally { page.stop(); }
});
