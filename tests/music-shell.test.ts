import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('mouse navigation releases focus before history; keyboard activation preserves it and return intent stays scoped', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const navigation = source.slice(source.indexOf('  const icon ='), source.indexOf('  nav.insertBefore(recommendations, album)'));
  for (const detail of [0, 1]) for (const matchesDestination of [false, true]) for (const relatedOpen of [false, true]) {
    const buttons: any[] = []; const actions: string[] = []; let focus = true;
    const element = (): any => ({ style: {}, setAttribute: () => {}, appendChild: () => {}, replaceChildren: () => {}, blur: () => { focus = false; },
      addEventListener: (_type: string, callback: (event: object) => void) => { const e = buttons.at(-1); e.click = callback; } });
    const document = { createElement: () => { const e = element(); buttons.push(e); return e; }, createElementNS: element,
      querySelector: () => relatedOpen ? { click: () => actions.push('close-related') } : undefined };
    const nav = { dataset: { recommendationReturnToken: 'token', recommendationReturnDestination: 'destination' } as Record<string, string>, appendChild: () => {} };
    const location = { href: matchesDestination ? 'destination' : 'another' };
    // goHistory (0.1.55) enciende la línea y espera un cuadro; acá se resuelve en el acto para ver el orden y el foco.
    const history = { back: () => { actions.push('back'); assert.equal(focus, detail === 0); }, forward: () => { actions.push('forward'); assert.equal(focus, detail === 0); } };
    vm.runInNewContext(navigation, { nav, document, location, busyForButton: () => {}, sendLabelRequest: () => {}, readPlaying: () => ({ albumButton: { click: () => { actions.push('album'); assert.equal(focus, detail === 0); } } }),
      history, canGoHistory: () => true, goHistory: (direction: number) => direction < 0 ? history.back() : history.forward() });
    buttons[0].click({ detail }); assert.equal(nav.dataset.recommendationBackIntent, matchesDestination && !relatedOpen ? 'token' : undefined);
    focus = true; buttons[1].click({ detail }); focus = true; buttons[2].click({ detail }); assert.deepEqual(actions, [relatedOpen ? 'close-related' : 'back', 'forward', 'album']);
  }
});

test('late player or controls mount rebuilds the shell while ordinary player updates stay local', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const observerSource = source.slice(source.indexOf('  let scheduled = false;'), source.indexOf('  observer.observe(document.body'));
  for (const kind of ['.chrome-player', '.chrome-player__playback-controls', 'nested-player', 'early-metadata', 'metadata', 'unrelated']) {
    let receive!: (records: object[]) => void; const queued: Array<() => void> = []; let rebuilt = 0; let updated = 0;
    const player = {};
    const target = { closest: () => kind.includes('metadata') ? player : undefined };
    const added = { nodeType: 1, matches: (selector: string) => selector.split(',').includes(kind),
      querySelector: (selector: string) => kind === 'nested-player' && selector.split(',').includes('.chrome-player') ? player : undefined };
    vm.runInNewContext(observerSource, { installed: kind !== 'early-metadata', perf: { records: 0 },
      MutationObserver: class { constructor(callback: typeof receive) { receive = callback; } },
      queueMicrotask: (callback: () => void) => queued.push(callback), scheduleSongLists: () => {}, apply: () => { rebuilt++; }, updatePlayer: () => { updated++; },
      document: { querySelector: () => player } });
    receive([{ target, addedNodes: kind.includes('metadata') ? [] : [added] }]);
    receive([{ target, addedNodes: kind.includes('metadata') ? [] : [added] }]);
    assert.equal(queued.length, kind === 'unrelated' ? 0 : 1, kind);
    queued.shift()?.();
    assert.equal(rebuilt, ['metadata', 'unrelated'].includes(kind) ? 0 : 1, kind);
    assert.equal(updated, kind === 'metadata' ? 1 : 0, kind);
  }
});

test('agregar a la playlist abierta la vuelve a abrir desde la barra lateral, restaura el scroll y no entra en ciclo', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const refresh = source.slice(source.indexOf('  const pagePath'), source.indexOf('  // Una pasada por cuadro'));
  assert.doesNotMatch(refresh, /replaceState|PopStateEvent/);
  let now = 0; const timers: Array<{ at: number; run: () => void }> = [];
  const run = (until: number) => { for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > until) break; timers.shift(); now = next.at; next.run(); } now = until; };
  const listeners: Record<string, (event: { detail: unknown }) => void> = {}; let observe!: (list: { getEntries: () => Array<{ name: string }> }) => void;
  let clicks = 0; let row: object | undefined = { isConnected: true }; const page = { scrollTop: 900 };
  const location = { origin: 'https://music.apple.com', pathname: '/library/playlist/p.Test1' };
  let links = [{ href: 'https://music.apple.com/library/playlist/p.Other' }, { href: 'https://music.apple.com/library/playlist/p.Test1/', click: () => {
    clicks++; (row as { isConnected: boolean }).isConnected = false; page.scrollTop = 0; } }];
  vm.runInNewContext(refresh, {
    location, URL, Date: { now: () => now },
    setTimeout: (run: () => void, ms: number) => { const timer = { at: now + ms, run }; timers.push(timer); return timer; },
    clearTimeout: (timer: object) => { const index = timers.indexOf(timer as never); if (index >= 0) timers.splice(index, 1); },
    document: { getElementById: () => page, querySelector: () => row, querySelectorAll: (selector: string) => { assert.equal(selector, '.navigation a[href]'); return links; },
      addEventListener: (type: string, callback: (event: { detail: unknown }) => void) => { listeners[type] = callback; } },
    PerformanceObserver: class { constructor(callback: typeof observe) { observe = callback; } observe() {} },
  });
  // Stream Deck: otra playlist o ID inválido no hacen nada; la abierta se abre de nuevo una sola vez aunque lleguen dos avisos.
  listeners['el-music-playlist-added']({ detail: 'p.Other' }); listeners['el-music-playlist-added']({ detail: 'p.x"/' }); run(1000);
  assert.equal(clicks, 0);
  listeners['el-music-playlist-added']({ detail: 'p.Test1' }); run(1100); listeners['el-music-playlist-added']({ detail: 'p.Test1' }); run(1800);
  assert.equal(clicks, 1);
  row = { isConnected: true }; run(2200);
  assert.equal(page.scrollTop, 900);
  // Menú de Apple: sólo su POST con representation=resources; la carga de la página y sus tandas no disparan nada.
  const entry = (query: string) => ({ name: `https://amp-api.music.apple.com/v1/me/library/playlists/p.Test1/tracks?${query}` });
  observe({ getEntries: () => [entry('offset=100'), entry('omit%5Bresource%5D=autos')] }); run(10000);
  assert.equal(clicks, 1);
  observe({ getEntries: () => [entry('l=es-MX&representation=resources')] }); run(11000);
  assert.equal(clicks, 2);
  // Dentro de los 5 s posteriores a un refresco no se vuelve a pedir: no hay ciclo posible.
  observe({ getEntries: () => [entry('representation=resources')] }); run(12000);
  assert.equal(clicks, 2);
  // Sin enlace visible (playlist dentro de una carpeta cerrada) o en otra página, no se hace nada.
  links = links.slice(0, 1); observe({ getEntries: () => [entry('representation=resources')] }); run(20000);
  assert.equal(clicks, 2);
  location.pathname = '/ar/album/x/1'; observe({ getEntries: () => [entry('representation=resources')] }); run(30000);
  assert.equal(clicks, 2);
});

test('las playlists pierden el color de portada y cargan todas las tandas sin bajar, deteniéndose si Apple no suma filas', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  // Fondo: se quitan las clases de tema de Apple y sus variables de color del style, también si las vuelve a poner.
  const theme = source.slice(source.indexOf('  let themedContainer;'), source.indexOf('  const apply = () =>'));
  const classes = new Set(['app-container', 'has-theme-override', 'is-dark-theme']);
  const style = new Map([['--upsell-banner-height', '71px'], ['--joe-color', '#123456'], ['--opaqueShelfBG-blended-plusD', 'rgb(0, 0, 7)']]);
  const container = { classList: { contains: (name: string) => classes.has(name), remove: (...names: string[]) => names.forEach(name => classes.delete(name)) },
    style: { [Symbol.iterator]: () => [...style.keys()][Symbol.iterator](), removeProperty: (name: string) => style.delete(name) } };
  let themeChanged!: () => void;
  const context = vm.createContext({ document: { querySelector: () => container },
    MutationObserver: class { constructor(callback: () => void) { themeChanged = callback; } observe() {} disconnect() {} } });
  vm.runInContext(theme + 'neutralizeTheme();', context);
  assert.deepEqual([...classes], ['app-container']);
  assert.deepEqual([...style.keys()], ['--upsell-banner-height']);
  classes.add('has-theme-override'); classes.add('is-light-theme'); style.set('--joe-color', '#654321'); themeChanged();
  assert.deepEqual([...classes], ['app-container']);
  assert.deepEqual([...style.keys()], ['--upsell-banner-height']);
  // Carga: el marcador de Apple se fija en la ventana (clase el-music-autoload) mientras haya tandas; tres intentos sin filas nuevas detienen.
  const autoload = source.slice(source.indexOf('  let autoloadRows'), source.indexOf('  setInterval(autoloadPages'));
  const root = new Set<string>(); let rows = 100; let spinner: object | undefined = { getAttribute: () => 'false' };
  const timers: Array<() => void> = [];
  const loader = vm.createContext({ pending: null, location: { pathname: '/library/playlist/p.Test1' }, setTimeout: (run: () => void) => timers.push(run), summarize: () => {}, timing: undefined, finishTiming: () => {},
    document: { documentElement: { classList: { add: (name: string) => root.add(name), remove: (name: string) => root.delete(name) } },
      querySelector: () => spinner, querySelectorAll: (selector: string) => selector.includes('summary') || selector === '.songs-list' ? [] : { length: rows } } });
  vm.runInContext(autoload, loader);
  const tick = () => { vm.runInContext('autoloadPages()', loader); while (timers.length) timers.shift()!(); };
  tick(); assert.ok(root.has('el-music-autoload'));
  for (let i = 0; i < 5; i++) { rows += 100; tick(); assert.ok(root.has('el-music-autoload')); }
  tick(); tick(); assert.ok(root.has('el-music-autoload'));
  tick(); assert.ok(!root.has('el-music-autoload'));
  rows += 100; tick(); assert.ok(root.has('el-music-autoload'));
  // Con un Play esperando no se pide otra tanda; al cerrarse el aviso se sigue.
  loader.pending = {}; rows += 100; tick(); assert.ok(!root.has('el-music-autoload'));
  loader.pending = null; tick(); assert.ok(root.has('el-music-autoload'));
  spinner = undefined; tick(); assert.ok(!root.has('el-music-autoload'));
  // Al terminar una tanda (aria-busy vuelve a false) se pide la siguiente enseguida, sin esperar el intervalo.
  const watch = source.slice(source.indexOf('  new MutationObserver(records => {\n    for (const record of records) {'), source.indexOf('  // Medición de la carga de una playlist'));
  let onBusy: ((records: unknown[]) => void) | undefined; let options: unknown; const calls: string[] = [];
  vm.runInContext(watch, vm.createContext({ document: { body: 'body' }, timing: undefined, autoloadPages: () => calls.push('load'), setTimeout: (run: () => void) => run(),
    MutationObserver: class { constructor(callback: (records: unknown[]) => void) { onBusy = callback; } observe(_target: unknown, value: unknown) { options = value; } } }));
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
  const marker = (busy: string) => ({ target: { classList: { contains: (name: string) => name === 'infinite-scroll-spinner' }, getAttribute: () => busy } });
  onBusy!([marker('true')]); assert.deepEqual(calls, []);
  onBusy!([{ target: { classList: { contains: () => false }, getAttribute: () => 'false' } }]); assert.deepEqual(calls, []);
  onBusy!([marker('false')]); assert.deepEqual(calls, ['load']);
});

test('el tema que suena se lleva al centro sólo si se lo venía siguiendo o recién empieza', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const follow = source.slice(source.indexOf('  let refreshedAt = 0;'), source.indexOf('  const prepareSongList ='));
  const scrolled: string[] = [], behaviors: string[] = [], logs: Array<[string, Record<string, number>]> = [];
  const row = (id: string, top: number) => ({ dataset: { row: id }, top, classList: { contains: () => false },
    scrollIntoView(options: { behavior: string }) { scrolled.push(id); behaviors.push(options.behavior); }, getBoundingClientRect() { return { top: this.top, bottom: this.top + 50 }; } });
  const rows = [row('0', 100), row('1', 160), row('250', 9000)];
  let playing: ReturnType<typeof row> | undefined;
  const list = { dataset: {} as Record<string, string>, querySelector: (selector: string) => selector.includes('is-paused') ? undefined :
    selector.includes('is-playing') ? playing : rows.find(item => selector.includes(`"${item.dataset.row}"`)) };
  const context = vm.createContext({ innerHeight: 800, CSS: { escape: (value: string) => value }, performance: { now: () => 0 }, rowsOf: () => rows,
    pageLog: (event: string, fields: Record<string, number>) => logs.push([event, fields]) });
  vm.runInContext(follow, context); const followPlaying = vm.runInContext('followPlaying', context);
  playing = rows[2]; followPlaying(list); assert.deepEqual(scrolled, ['250']); // shuffle recién dado: se busca el tema
  // Lejos (más de dos pantallas) el salto es instantáneo, para no pedir las portadas de todas las filas intermedias.
  assert.deepEqual([...behaviors], ['instant']); assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['follow-playing', { distancia: 8600, suave: 0, filas: 3 }]]);
  rows[2].top = 300; playing = rows[1]; followPlaying(list); assert.deepEqual(scrolled, ['250']); // a la vista: no se mueve
  rows[1].top = -2000; playing = rows[2]; rows[2].top = 9000; followPlaying(list); assert.deepEqual(scrolled, ['250']); // el usuario se fue a otro lado
  rows[2].top = 400; playing = rows[0]; rows[0].top = 1000; followPlaying(list); assert.deepEqual(scrolled, ['250', '0']); // venía siguiéndolo
  assert.deepEqual(behaviors, ['instant', 'smooth']); // cerca: scroll suave
  // Refresco de la playlist tras un agregado: manda el scroll restaurado.
  vm.runInContext('refreshedAt = Date.now()', context); rows[1].top = 5000; playing = rows[1]; followPlaying(list); assert.deepEqual(scrolled, ['250', '0']);
});

test('la carga de una playlist se mide y llega a main sólo como números', () => {
  const { playlistTiming, playlistTimingScript } = require('../src/playlist-timing') as typeof import('../src/playlist-timing');
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const code = source.slice(source.indexOf('  let timing;'), source.indexOf('  const prepareSongLists'));
  let now = 1000; let onNavigate: ((event: unknown) => void) | undefined; const observers: Record<string, (list: unknown) => void> = {};
  const root = { dataset: {} as Record<string, string> };
  const location = { pathname: '/library/playlist/p.X', protocol: 'https:', hostname: 'music.apple.com', port: '', href: 'https://music.apple.com/library/playlist/p.X' };
  const self = {};
  const segment = { longCount: 0, longMs: 0, longMax: 0, frames: 0, layout: 0, forced: 0, apple: 0, own: 0, other: 0, culprits: new Map<string, number>() };
  const context = vm.createContext({ location, URL, top: self, self, performance: { now: () => now }, document: { documentElement: root },
    perf: { longMs: 0 }, slowEntry: () => segment,
    navigation: { addEventListener: (_name: string, listener: (event: unknown) => void) => { onNavigate = listener; } },
    PerformanceObserver: class { callback: (list: unknown) => void; constructor(callback: (list: unknown) => void) { this.callback = callback; }
      observe(options: { type: string }) { observers[options.type] = this.callback; } } });
  vm.runInContext(code + '; globalThis.state = () => timing; globalThis.finish = finishTiming;', context);
  onNavigate!({ destination: { url: 'https://music.apple.com/library/playlist/p.Y' } }); location.pathname = '/library/playlist/p.Y';
  observers.longtask({ getEntries: () => [{ duration: 120 }, { duration: 80 }] });
  observers['long-animation-frame']({ getEntries: () => [{ duration: 150, styleAndLayoutDuration: 60, scripts: [
    { sourceURL: 'https://js-cdn.music.apple.com/x.js', duration: 50, forcedStyleAndLayoutDuration: 10 }, { sourceURL: '', duration: 20 },
    { sourceURL: 'chrome-extension://x/y.js', duration: 5 }] }] });
  Object.assign(vm.runInContext('state()', context), { first: 400, batches: 9, busyMs: 6000, ours: 350, oursMax: 90, passes: 12 });
  now = 9000; vm.runInContext('finish(1000)', context);
  const timing = playlistTiming(vm.runInContext(playlistTimingScript, context));
  assert.deepEqual(timing, { filas: 1000, tandasExtra: 9, primerasFilasMs: 400, todasMs: 8000, esperaAppleMs: 6000, nuestroMs: 350, nuestroMaxMs: 90,
    pasadas: 12, bloqueos: 2, bloqueoTotalMs: 200, bloqueoMaxMs: 120, cuadrosLentos: 1, cuadrosLentosMs: 150, disenoMs: 60, disenoForzadoMs: 10,
    scriptAppleMs: 50, scriptPropioMs: 20, scriptOtroMs: 5 });
  // El monitor de fluidez recibe lo mismo, también fuera de la medición de carga.
  const { culprits, ...counts } = segment;
  assert.deepEqual(counts, { longCount: 2, longMs: 200, longMax: 120, frames: 1, layout: 60, forced: 10, apple: 50, own: 20, other: 5 });
  assert.deepEqual([...culprits], [['apple x.js: ()', 50], ['own  ()', 20], ['other y.js: ()', 5]]);
  // Se toma una sola vez; ir a otra página que no es playlist descarta la medición en curso.
  assert.equal(vm.runInContext(playlistTimingScript, context), null);
  onNavigate!({ destination: { url: 'https://music.apple.com/library/albums' } }); assert.equal(vm.runInContext('state()', context), undefined);
  assert.equal(playlistTiming(JSON.stringify({ ...timing, token: 1 })), undefined); assert.equal(playlistTiming(JSON.stringify({ ...timing, filas: -1 })), undefined);
});

test('las pasadas de la lista van en el cuadro siguiente, una cada 120 ms como máximo, y descartan sus propias mutaciones', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const scheduler = source.slice(source.indexOf('  let songListTimer, songListFrame'), source.indexOf("  document.addEventListener('el-music-playlist-labels'"));
  let now = 1000; const timers = new Map<number, { at: number; run: () => void }>(); const frames = new Map<number, () => void>(); let id = 0;
  const calls: string[] = [];
  const context = vm.createContext({ performance: { now: () => now },
    setTimeout: (run: () => void, ms: number) => { timers.set(++id, { at: now + ms, run }); return id; }, clearTimeout: (key: number) => { timers.delete(key); },
    requestAnimationFrame: (run: () => void) => { frames.set(++id, run); return id; }, cancelAnimationFrame: (key: number) => { frames.delete(key); },
    prepareSongLists: () => calls.push('pass'), observer: { takeRecords: () => { calls.push('take'); return []; } } });
  vm.runInContext(scheduler + '; globalThis.schedule = scheduleSongLists;', context);
  const schedule = (): void => vm.runInContext('schedule()', context);
  const frame = (): void => { const pending = [...frames.values()]; frames.clear(); for (const run of pending) run(); };
  const advance = (ms: number): void => {
    now += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= now && timers.has(key)) { timers.delete(key); timer.run(); }
  };
  // Con cuadros: la pasada corre en el cuadro siguiente, una sola vez aunque lleguen varios avisos, y el respaldo se cancela.
  schedule(); schedule(); assert.equal(frames.size, 1); frame();
  assert.deepEqual(calls, ['pass', 'take']); assert.equal(timers.size, 0);
  // Otro aviso antes de 120 ms espera hasta cumplirlos y recién entonces pide el cuadro.
  advance(50); schedule(); assert.equal(frames.size, 0); advance(70); assert.equal(frames.size, 1); frame();
  assert.deepEqual(calls, ['pass', 'take', 'pass', 'take']);
  // Sin cuadros (ventana oculta), el respaldo hace la pasada a los 120 ms y el cuadro pendiente se cancela.
  advance(200); schedule(); advance(120);
  assert.deepEqual(calls.slice(4), ['pass', 'take']); assert.equal(frames.size, 0);
});

test('el clic en Play o Shuffle del encabezado muestra el aviso enseguida y la espera y la lentitud se registran con números', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const code = source.slice(source.indexOf('  const perf = { longMs'), source.indexOf('  // LCD en dos filas'));
  let now = 0, clock = 1000; const timers = new Map<number, () => void>(); let nextTimer = 1;
  const logs: Array<[string, Record<string, number>]> = []; const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const fire = (name: string, event: unknown) => { for (const listener of listeners[name] || []) listener(event); };
  const element = (): any => ({ hidden: false, textContent: '', setAttribute: () => {}, append: () => {}, appendChild(child: any) { child.parentElement = this; }, classList: { add: () => {}, remove: () => {} }, style: {} });
  const host = element(); const rootClasses = new Set<string>();
  const header = { querySelector: () => ({ textContent: '  Finds   new ' }) };
  const button = (kind: string) => ({ disabled: false, getAttribute: () => null,
    closest: (selector: string) => selector.includes('primary-actions__button--shuffle button') ? button(kind) : selector === '.primary-actions__button--shuffle' ? (kind === 'shuffle' || undefined) : selector === '.container-detail-header' ? header : undefined });
  const location = { pathname: '/library/playlist/p.Finds/', href: 'https://music.apple.com/library/playlist/p.Finds/', origin: 'https://music.apple.com' };
  const clicks: string[] = [], scrolls: string[] = [];
  const sidebar = [{ href: 'https://music.apple.com/library/playlist/p.Finds', click: () => clicks.push('sidebar') }];
  const playingRow = { getBoundingClientRect: () => ({ top: 6000 }), scrollIntoView: (options: { behavior: string }) => scrolls.push(options.behavior) };
  const list = { querySelector: (selector: string) => selector.includes('is-paused') ? playingRow : undefined };
  const context = vm.createContext({ Element: Object, URL, Date: { now: () => clock }, performance: { now: () => now }, location, innerHeight: 800, rowsOf: () => [1, 2], renderLcdLine: () => {},
    setTimeout: (run: () => void) => { timers.set(nextTimer, run); return nextTimer++; }, clearTimeout: (id: number) => timers.delete(id),
    pageLog: (event: string, fields: Record<string, number>) => logs.push([event, fields]), dispatchEvent: () => {}, CustomEvent: class {}, autoloadPages: () => {},
    readPlaying: () => ({ albumButton: { click: () => clicks.push('album') } }), setInterval: () => 0, clearInterval: () => {}, console: { debug: () => {} },
    addEventListener: (name: string, listener: (event: unknown) => void) => { (listeners['window:' + name] ||= []).push(listener); },
    document: { createElement: element, documentElement: { appendChild: () => {}, classList: { add: (name: string) => rootClasses.add(name), remove: (name: string) => rootClasses.delete(name) } },
      querySelector: (selector: string) => selector === '.chrome-player__lcd' ? host : undefined,
      getElementById: (id: string) => id === 'el-music-open-recommendations' ? { click: () => clicks.push('related') } : undefined,
      querySelectorAll: (selector: string) => selector === '.navigation a[href]' ? sidebar : selector === '.songs-list' ? [list] : selector.startsWith('main ') ? [] : { length: 397 },
      addEventListener: (name: string, listener: (event: unknown) => void) => { (listeners[name] ||= []).push(listener); } } });
  vm.runInContext(code + '; globalThis.state = () => ({ pending, perf, overlay, pendingInfo, playSource, revealUntil }); globalThis.api = { settlePending, rowPending, slowEntry, openSource };', context);
  const state = () => vm.runInContext('state()', context), api = vm.runInContext('api', context);
  // Clic en Shuffle en una playlist: aviso inmediato, todavía sin saber qué tema sale (las filas del LCD muestran «…»).
  const target = button('shuffle'); Object.setPrototypeOf(target, Object.prototype);
  fire('click', { target });
  assert.equal(state().overlay.hidden, false); assert.deepEqual(JSON.parse(JSON.stringify(state().pendingInfo)), { song: '', artist: '', album: '' });
  assert.ok(rootClasses.has('el-music-play-pending')); assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['header-play', { tipo: 1, filas: 397 }], ['play-source-set', { tipo: 0 }]]);
  // Apple marca la fila 2,5 s después: se completan canción, artista y álbum y se conserva el inicio de la espera.
  clock += 2500; api.rowPending({ song: 'Creation', artist: '((( O )))', album: '((( 3 )))' });
  assert.deepEqual(JSON.parse(JSON.stringify(state().pendingInfo)), { song: 'Creation', artist: '((( O )))', album: '((( 3 )))' }); assert.equal(state().pending.via, 3);
  state().perf.longMs += 900; state().perf.passes += 4; state().perf.images += 120;
  clock += 1500; api.settlePending(1);
  assert.deepEqual(JSON.parse(JSON.stringify(logs.at(-1))), ['play-wait', { ms: 4000, via: 3, fin: 1, filaMs: 2500, bloqueoMs: 900, pasadas: 4, imagenes: 120 }]);
  assert.equal(state().overlay.hidden, true); assert.ok(!rootClasses.has('el-music-play-pending'));
  // Sin aviso previo, la fila is-loading lo abre (via 2) con filaMs 0.
  api.rowPending({ song: 'Otro', artist: 'Artista' }); assert.equal(state().pending.via, 2); clock += 100; api.settlePending(0);
  assert.equal(logs.at(-1)![1].filaMs, 0);
  // Monitor de fluidez: un episodio con 400 ms o más de bloqueo se registra al terminar; uno chico, no.
  const runTimers = () => { const pending = [...timers.values()]; timers.clear(); for (const run of pending) run(); };
  logs.length = 0; let segment = api.slowEntry(); segment.longMs = 120; now = 500; runTimers(); assert.equal(logs.length, 0);
  now = 1000; segment = api.slowEntry(); segment.longMs = 700; segment.longCount = 5; segment.own = 300; now = 3000; runTimers();
  assert.equal(logs.length, 1); assert.equal(logs[0][0], 'page-slow');
  assert.equal(logs[0][1].bloqueoTotalMs, 700); assert.equal(logs[0][1].ms, 2000); assert.equal(logs[0][1].sigue, 0); assert.equal(logs[0][1].desdeClicMs, 3000);
  // Un episodio que no termina se registra cada 10 s sin esperar el silencio.
  now = 10000; segment = api.slowEntry(); segment.longMs = 5000; now = 20500; api.slowEntry();
  assert.equal(logs.length, 2); assert.equal(logs[1][1].sigue, 1); assert.equal(logs[1][1].bloqueoTotalMs, 5000);
  // Origen del tema: el Shuffle del encabezado recordó esta playlist; el título del LCD lleva ahí por la barra lateral.
  assert.equal(state().playSource.path, '/library/playlist/p.Finds'); assert.equal(state().playSource.kind, 'page');
  location.pathname = '/us/album/x/1'; logs.length = 0; api.openSource();
  assert.deepEqual(clicks, ['sidebar']); assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['play-source', { via: 1 }]]);
  assert.ok(state().revealUntil > clock);
  // Ya en la lista: scroll directo (instantáneo, la fila está lejos) a la fila que Apple marca.
  location.pathname = '/library/playlist/p.Finds'; logs.length = 0; api.openSource();
  assert.deepEqual(scrolls, ['instant']); assert.equal(state().revealUntil, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['play-source', { via: 0 }], ['follow-playing', { distancia: 5600, suave: 0, filas: 2, origen: 1 }]]);
  // Play desde Related (siempre se sabe el origen): con el panel cerrado, la canción lo vuelve a abrir.
  logs.length = 0; fire('window:el-music:pending-play', { detail: { song: 'Tema', artist: 'Artista', source: 'related' } });
  assert.equal(state().playSource.kind, 'related'); assert.deepEqual(JSON.parse(JSON.stringify(logs.at(-1))), ['play-source-set', { tipo: 1 }]);
  logs.length = 0; api.openSource(); assert.deepEqual(clicks, ['sidebar', 'related']); assert.deepEqual(JSON.parse(JSON.stringify(logs[0])), ['play-source', { via: 6 }]);
  // Un Play desde nuestras listas sin source (la lista al pie de la página de un sello) recuerda la página visible.
  fire('window:el-music:pending-play', { detail: { artist: 'Artista', album: 'Disco', source: 'page' } });
  assert.equal(state().playSource.kind, 'page');
  // Sin origen (por ejemplo, después de reiniciar la app), la canción abre el disco con el botón de Apple.
  vm.runInContext('playSource = null', context); logs.length = 0; api.openSource();
  assert.deepEqual(clicks, ['sidebar', 'related', 'album']); assert.deepEqual(JSON.parse(JSON.stringify(logs)), [['play-source', { via: 4 }]]);
  // El botón de álbum de Apple no es un enlace: la línea de carga se enciende con el clic (0.1.55).
  assert.ok(rootClasses.has('el-music-busy'));
});

test('las filas sin enlace de artista se enlazan con los artistas del álbum o con el enlace de otra fila, sólo con nombres enteros', () => {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const code = source.slice(source.indexOf('  const artistAliases = list =>'), source.indexOf('  let suppressSortClick = 0;'));
  const infoStore = new Map<string, { artists?: Array<[string, string]> }>([['n:Raz', { artists: [['Raz Fresco', '111'], ['Dibia$E', '222']] }]]);
  const context = vm.createContext({ infoStore, pageCountry: () => 'ar', pageLog: () => {}, location: { origin: 'https://music.apple.com' }, URL,
    document: { createElement: () => ({ addEventListener: () => {} }) } });
  vm.runInContext(code + '; globalThis.api = { linkArtists, artistAliases };', context);
  const api = vm.runInContext('api', context);
  const cell = (text: string): any => ({ textContent: text, dataset: {}, parts: undefined as unknown, querySelector: () => null, replaceChildren(...parts: unknown[]) { this.parts = parts; } });
  const shape = (parts: unknown[]) => parts.map(part => typeof part === 'string' ? part : [(part as { textContent: string }).textContent, (part as { href: string }).href]);
  // Dos artistas del álbum dentro del mismo texto: dos enlaces y el separador como texto.
  const raz = cell('Raz Fresco & Dibia$E'); api.linkArtists(raz, 'n:Raz', new Map());
  assert.deepEqual(shape(raz.parts), [['Raz Fresco', 'https://music.apple.com/ar/artist/111'], ' & ', ['Dibia$E', 'https://music.apple.com/ar/artist/222']]);
  // Sin datos del catálogo, el enlace de Apple del mismo nombre en otra fila; «Rae» no se enlaza dentro de «Raedio».
  const aliases = new Map([['rejjie snow', 'https://music.apple.com/ar/artist/rejjie-snow/965181010'], ['rae', 'https://music.apple.com/ar/artist/rae/1']]);
  const rejjie = cell('Rejjie Snow'); api.linkArtists(rejjie, 'n:Peekaboo', aliases);
  assert.deepEqual(shape(rejjie.parts), [['Rejjie Snow', 'https://music.apple.com/ar/artist/rejjie-snow/965181010']]);
  const raedio = cell('Raedio'); api.linkArtists(raedio, 'n:Golden', aliases); assert.equal(raedio.parts, undefined);
  // Sin datos nuevos no se vuelve a intentar en cada pasada.
  raedio.textContent = 'Rae'; api.linkArtists(raedio, 'n:Golden', aliases); assert.equal(raedio.parts, undefined);
});