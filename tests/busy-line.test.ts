import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Línea de carga. Se corre el módulo del script de la página con un DOM falso y un reloj propio.
function busyPage() {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const code = source.slice(source.indexOf('  // Línea de carga. Medido'), source.indexOf('  // Respuesta inmediata al Play'));
  const page = { now: 0, heading: 'Novedades', spinner: false };
  let tick: (() => void) | undefined;
  const logs: Array<[string, Record<string, number>]> = []; const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const fire = (name: string, event: unknown): void => { for (const listener of listeners[name] || []) listener(event); };
  const classes = new Set<string>(); const line = { isConnected: false, id: '', style: {} as Record<string, string>, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} } };
  const location = { href: 'https://music.apple.com/ar/new', pathname: '/ar/new', search: '', origin: 'https://music.apple.com' };
  const dataset: Record<string, string> = {};
  const frames: Array<() => void> = [], timeouts: Array<() => void> = [], moves: string[] = []; const nav = { canGoBack: true, canGoForward: false };
  const context = vm.createContext({ URL, performance: { now: () => page.now }, location, innerHeight: 800, Element: Object,
    pageLog: (event: string, fields: Record<string, number>) => logs.push([event, fields]),
    setInterval: (run: () => void) => { tick = run; return 1; }, clearInterval: () => { tick = undefined; },
    navigation: Object.assign(nav, { addEventListener: (name: string, listener: (event: unknown) => void) => { (listeners['nav:' + name] ||= []).push(listener); } }),
    requestAnimationFrame: (run: () => void) => frames.push(run), setTimeout: (run: () => void) => timeouts.push(run),
    history: { back: () => moves.push('back'), forward: () => moves.push('forward') },
    addEventListener: (name: string, listener: (event: unknown) => void) => { (listeners['window:' + name] ||= []).push(listener); },
    console: { debug: () => {} },
    document: { createElement: () => line, querySelector: (selector: string) => selector === '.player-bar' ? { getBoundingClientRect: () => ({ bottom: 54 }) } : null,
      documentElement: { dataset, appendChild: () => { line.isConnected = true; }, classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } },
      querySelectorAll: (selector: string) => selector === 'main h1' ? (page.heading ? [{ textContent: '  ' + page.heading + ' ', getClientRects: () => [1] }] : [])
        : selector === 'main .loading-spinner' ? (page.spinner ? [{ closest: () => null, getBoundingClientRect: () => ({ width: 40, top: 300, bottom: 340 }) }] : []) : [],
      addEventListener: (name: string, listener: (event: unknown) => void) => { (listeners[name] ||= []).push(listener); } } });
  context.globalThis = context;
  // historyStep (0.1.58) vive arriba, con los botones: sin paneles abiertos, es ir al historial.
  vm.runInContext(code + '; function historyStep(direction) { goHistory(direction); } globalThis.api = { busyForButton, sendLabelRequest, state: () => busy };', context);
  const api = vm.runInContext('api', context) as { busyForButton: (part: string, name: string) => void; sendLabelRequest: (request: string) => void; state: () => any };
  const run = (ms: number): void => { const until = page.now + ms; while (page.now < until && tick) { page.now += 100; tick(); } };
  const go = (path: string): void => { location.pathname = path; location.href = 'https://music.apple.com' + path; };
  const link = (href: string, extra: Record<string, unknown> = {}) => ({ href, target: '', hasAttribute: () => false, contains: () => true, ...extra });
  const on = (anchor: unknown, control: unknown = null) => ({ closest: (selector: string) => selector === 'a[href]' ? anchor : selector.startsWith('button') ? control : null });
  const click = (target: unknown, extra: Record<string, unknown> = {}): void => fire('click', { button: 0, target, ...extra });
  const navigate = (url: string, navigationType = 'push'): void => fire('nav:navigate', { navigationType, destination: { url } });
  return { page, api, run, go, link, on, click, navigate, fire, logs, busy: () => classes.has('el-music-busy'), dataset, location, frames, timeouts, moves, nav, line };
}

test('un clic en un enlace: la línea queda con la página vieja y el spinner de Apple, y se va con la página nueva', () => {
  const t = busyPage();
  t.click(t.on(t.link('https://music.apple.com/ar/album/la-postal/6826504720')));
  assert.ok(t.busy()); assert.equal(t.api.state().kind, 'link');
  assert.equal(t.line.style.top, '52px', 'sobre el borde inferior de la barra del reproductor');
  t.run(600); assert.ok(t.busy(), 'sigue la página vieja: la línea sigue');
  t.page.heading = ''; t.page.spinner = true; t.run(500); assert.ok(t.busy(), 'spinner de Apple: sigue');
  t.navigate('https://music.apple.com/ar/album/la-postal/6826504720');
  assert.equal(t.api.state().kind, 'nav', 'la navegación continúa la misma espera');
  t.go('/ar/album/la-postal/6826504720'); t.page.heading = 'LA POSTAL'; t.page.spinner = false; t.run(100);
  assert.ok(!t.busy());
  assert.deepEqual(JSON.parse(JSON.stringify(t.logs.at(-1))), ['busy', { motivo: 2, fin: 0, ms: 1200, rutaMs: 1200 }]);
});

test('▶ o «…» dentro de una tarjeta, la misma página, otra pestaña o Ctrl+clic no encienden la línea', () => {
  const t = busyPage();
  t.click(t.on(t.link('https://music.apple.com/ar/album/otro/1'), { tag: 'button' }));
  t.click(t.on(t.link('https://music.apple.com/ar/new')));
  t.click(t.on(t.link('https://music.apple.com/ar/album/otro/1', { target: '_blank' })));
  t.click(t.on(t.link('https://music.apple.com/ar/album/otro/1')), { ctrlKey: true });
  t.click(t.on(t.link('https://www.apple.com/legal/')));
  assert.equal(t.api.state(), null); assert.ok(!t.busy());
  t.navigate('https://music.apple.com/ar/new?term=x'); assert.equal(t.api.state(), null, 'misma ruta (búsqueda): no es una espera');
  t.navigate('https://music.apple.com/ar/album/x/1', 'replace'); assert.equal(t.api.state(), null);
});

test('pushState propio: ruta nueva con el título viejo sigue; con dos títulos iguales, 2,5 s; spinner abajo ignorado', () => {
  const t = busyPage();
  t.navigate('https://music.apple.com/ar/artist/rick-astley/669771');
  t.go('/ar/artist/rick-astley/669771'); t.run(500); assert.ok(t.busy(), 'ruta nueva con el título viejo: sigue');
  t.page.heading = 'Rick Astley'; t.run(100); assert.ok(!t.busy());
  t.navigate('https://music.apple.com/ar/album/rick-astley/2');
  t.go('/ar/album/rick-astley/2'); t.run(2400); assert.ok(t.busy()); t.run(300); assert.ok(!t.busy());
  // Título nuevo con un spinner que sigue a la vista (una sección que carga): se ignora a los 1,2 s.
  t.navigate('https://music.apple.com/ar/album/greatest/3'); t.go('/ar/album/greatest/3'); t.page.spinner = true; t.page.heading = 'Greatest';
  t.run(1100); assert.ok(t.busy()); t.run(300); assert.ok(!t.busy());
});

test('un botón de Apple que navega tarde no deja la línea después de que la página ya está', () => {
  const t = busyPage();
  t.fire('pointerdown', {});
  // Apple dibuja la página nueva con la URL vieja y recién después hace pushState: el evento llega con la URL de antes.
  t.page.heading = 'Greatest Hits';
  t.navigate('https://music.apple.com/ar/album/greatest/3'); t.go('/ar/album/greatest/3');
  t.run(100); assert.equal(t.api.state(), null, 'el título cambió respecto del clic: termina en la primera pasada');
  assert.equal(t.logs.at(-1)![1].ms, 100);
});

test('pegado y sellos: cada espera tiene dueño; el fin de otro dueño no la apaga', () => {
  const t = busyPage();
  t.fire('window:el-music:busy', { detail: { op: 'start', kind: 'paste', owner: 'paste:7', limit: 120000 } });
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: 'paste:6' } }); assert.ok(t.busy());
  t.run(20000); assert.ok(t.busy(), 'Spotify puede tardar: el tope del pegado es 120 s');
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: 'paste:7' } }); assert.ok(!t.busy()); assert.equal(t.logs.at(-1)![1].fin, 3);
  t.fire('window:el-music:busy', { detail: { op: 'start', kind: 'paste', owner: 'paste:8', limit: 120000 } });
  t.navigate('https://music.apple.com/ar/album/x/9'); assert.equal(t.api.state().owner, 'nav', 'el pegado navegó: la línea es de la navegación');
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: 'paste:8' } }); assert.ok(t.busy(), 'main avisa el fin del pegado; la navegación sigue');
  t.go('/ar/album/x/9'); t.page.heading = 'X'; t.run(100); assert.ok(!t.busy());
  t.api.sendLabelRequest('open/m1234'); const first = t.api.state().owner; t.api.sendLabelRequest('new-releases');
  assert.notEqual(t.api.state().owner, first); assert.equal(t.dataset.elMusicLabelBusy, t.api.state().owner); assert.equal(t.dataset.elMusicLabelRequest, 'new-releases');
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: first } }); assert.ok(t.busy());
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: t.api.state().owner } }); assert.equal(t.api.state(), null);
});

test('un clic que no navega se retira a los 8 s; un pedido de main, en su tope', () => {
  const t = busyPage();
  t.click(t.on(t.link('https://music.apple.com/ar/curator/nada/5'))); t.run(7900); assert.ok(t.busy()); t.run(200);
  assert.ok(!t.busy()); assert.equal(t.logs.at(-1)![1].fin, 1);
  t.api.sendLabelRequest('open/m1'); t.run(19900); assert.ok(t.busy()); t.run(200); assert.ok(!t.busy()); assert.equal(t.logs.at(-1)![1].fin, 2);
});

test('artista o disco del LCD: si ya estoy en esa página no se enciende', () => {
  const t = busyPage();
  t.page.heading = 'Rick Astley Greatest - Single'; t.go('/ar/album/greatest/3');
  t.api.busyForButton('album', 'Rick Astley Greatest'); assert.equal(t.api.state(), null);
  t.api.busyForButton('artist', 'Rick Astley'); assert.equal(t.api.state().kind, 'button');
});

test('Back enciende la línea y espera un cuadro antes de pedir el historial (Apple bloquea la página al volver)', () => {
  const t = busyPage();
  t.fire('window:el-music:history', { detail: -1 });
  assert.ok(t.busy()); assert.deepEqual(t.moves, [], 'todavía no: primero se pinta la línea');
  t.frames.shift()!(); t.timeouts.splice(0).forEach(run => run());
  assert.deepEqual(t.moves, ['back'], 'una sola vez, aunque corran el cuadro y el respaldo');
  t.navigate('https://music.apple.com/ar/album/x/1', 'traverse'); assert.equal(t.api.state().kind, 'nav', 'el regreso continúa la misma espera');
  t.go('/ar/album/x/1'); t.page.heading = 'X'; t.run(100); assert.ok(!t.busy());
  // Sin entrada hacia adelante no se enciende ni se pide nada.
  t.fire('window:el-music:history', { detail: 1 }); assert.equal(t.api.state(), null); assert.deepEqual(t.moves, ['back']);
  t.fire('window:el-music:history', { detail: 'x' }); assert.equal(t.api.state(), null);
});

test('un control dentro de una tarjeta con shadow DOM no enciende la línea; el camino completo del evento se recorre', () => {
  const t = busyPage();
  const element = (tag: string, attributes: Record<string, string> = {}) => ({ tag, ...attributes,
    matches: (selector: string) => selector === 'a[href]' ? tag === 'a' : selector.split(',').map(part => part.trim()).some(part => part === tag || part === '.' + attributes.className || (part === '[role="button"]' && attributes.role === 'button')) });
  // instanceof Element en el contexto de la prueba es Object: cualquier objeto con prototipo pasa.
  const card = Object.assign(element('a'), t.link('https://music.apple.com/ar/album/otro/1'));
  const host = element('amp-play-control'), inner = element('button');
  t.fire('click', { button: 0, target: host, composedPath: () => [inner, host, card] });
  assert.equal(t.api.state(), null, 'el botón dentro del componente de la tarjeta reproduce, no navega');
  t.fire('click', { button: 0, target: host, composedPath: () => [element('span'), host, card] });
  assert.equal(t.api.state().kind, 'link', 'un clic en la tarjeta misma sí navega');
});

test('una espera sigue con una navegación a la misma ruta (otra búsqueda) y un regreso a la misma URL la termina', () => {
  const t = busyPage();
  t.go('/ar/search'); t.location.href = 'https://music.apple.com/ar/search?term=a';
  t.fire('window:el-music:busy', { detail: { op: 'start', kind: 'paste', owner: 'paste:3', limit: 120000 } });
  t.navigate('https://music.apple.com/ar/search?term=b'); assert.equal(t.api.state().owner, 'nav');
  t.fire('window:el-music:busy', { detail: { op: 'end', owner: 'paste:3' } }); assert.ok(t.busy(), 'el fin del pegado no apaga la navegación');
  t.location.href = 'https://music.apple.com/ar/search?term=b'; t.run(2700); assert.ok(!t.busy(), 'mismo título: 2,5 s después del cambio');
  t.fire('window:el-music:history', { detail: -1 }); assert.ok(t.busy());
  t.navigate(t.location.href, 'traverse'); assert.ok(!t.busy(), 'el regreso a la misma URL no cambia la página');
});
