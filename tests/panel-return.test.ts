import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Back vuelve al panel propio. Se corre el módulo del script de la página con un DOM y una Navigation API falsos.
function returnPage() {
  const source = readFileSync('src/ui/music-shell.js', 'utf8');
  const code = source.slice(source.indexOf('  // Back vuelve al panel propio'), source.indexOf('  // LCD en dos filas'));
  assert.ok(code.length > 200, 'módulo encontrado');
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const on = (prefix: string) => (name: string, listener: (event: any) => void) => { (listeners[prefix + name] ||= []).push(listener); };
  const fire = (name: string, event: unknown): void => { for (const listener of listeners[name] || []) listener(event); };
  const page = { now: 0, closed: 0, panel: null as any, requests: [] as string[], logs: [] as Array<[string, Record<string, number>]>, timers: [] as Array<{ at: number; run: () => void }>, relatedClosed: 0 };
  class Element { constructor(readonly name: string, readonly parent?: Element) {} closest(selector: string): Element | null {
    for (let node: Element | undefined = this; node; node = node.parent) if (selector.split(',').some(part => part.trim() === node!.name)) return node;
    return null; } }
  const navigation = { currentEntry: { key: 'K1' }, addEventListener: on('nav:') };
  const makePanel = (kind: string, scrollTop = 0, items = 0, entryKey = '') => {
    const panel: any = new Element('#el-music-label-panel');
    const classes = new Set<string>();
    Object.assign(panel, { dataset: { kind, entryKey }, scrollTop, scrollHeight: 4000, clientHeight: 700, items,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) },
      contains: (node: Element) => { for (let current: Element | undefined = node; current; current = current.parent) if (current === panel) return true; return false; },
      querySelector: (selector: string) => selector === '[data-close-labels]' ? { click: () => { page.closed++; } } : selector === '.el-music-label-grid > li' && panel.items ? {} : null });
    return panel;
  };
  const context = vm.createContext({ Element, performance: { now: () => page.now }, lastLabelKey: '', location: { pathname: '/ar/new' }, URL,
    setTimeout: (run: () => void, ms: number) => page.timers.push({ at: page.now + ms, run }),
    sendLabelRequest: (request: string) => page.requests.push(request), syncReleasesPanel: () => {},
    pageLog: (event: string, fields: Record<string, number>) => page.logs.push([event, fields]),
    navigation,
    document: { addEventListener: on(''), getElementById: (id: string) => id === 'el-music-label-panel' ? page.panel : null,
      querySelector: (selector: string) => selector.includes('recommendation') ? null : null } });
  context.globalThis = context;
  vm.runInContext(code, context);
  const run = (ms: number): void => {
    const until = page.now + ms;
    for (;;) {
      page.timers.sort((a, b) => a.at - b.at);
      const next = page.timers[0];
      if (!next || next.at > until) break;
      page.timers.shift(); page.now = next.at; next.run();
    }
    page.now = until;
  };
  const clickInPanel = (target: Element, extra: Record<string, unknown> = {}): void => fire('click', { button: 0, target, ...extra });
  const push = (to: string): void => { fire('nav:navigate', { navigationType: 'push' }); navigation.currentEntry = { key: to }; fire('nav:currententrychange', { navigationType: 'push' }); };
  const traverse = (to: string): void => { fire('nav:navigate', { navigationType: 'traverse', destination: { key: to } }); navigation.currentEntry = { key: to }; fire('nav:currententrychange', { navigationType: 'traverse' }); };
  const replace = (url?: string): void => fire('nav:navigate', { navigationType: 'replace', ...(url ? { destination: { url } } : {}) });
  // Sólo el evento navigate de un Back, sin cambiar todavía la entrada actual (Apple dibuja la página después).
  const traverseStart = (to: string): void => fire('nav:navigate', { navigationType: 'traverse', destination: { key: to } });
  const commit = (to: string): void => { navigation.currentEntry = { key: to }; fire('nav:currententrychange', { navigationType: 'traverse' }); };
  return { page, Element, makePanel, clickInPanel, push, traverse, replace, traverseStart, commit, run, context };
}

test('Back desde un disco abierto en New releases vuelve al panel, con el mismo scroll', () => {
  const t = returnPage();
  t.page.panel = t.makePanel('new-releases', 640, 12);
  const card = new t.Element('a[href]', t.page.panel);
  t.page.now = 1000; t.clickInPanel(new t.Element('img', card));
  // El enlace propio navega (pushState): se recuerda la entrada de partida K1 y el panel se cierra.
  t.push('K2'); t.page.panel = null;
  t.run(5000); assert.deepEqual(t.page.requests, []);
  // Back: vuelve a K1 y el panel se pide otra vez, un instante después (main cierra los paneles al empezar la navegación).
  t.traverse('K1'); assert.deepEqual(t.page.requests, []);
  t.run(150); assert.deepEqual(t.page.requests, ['new-releases']);
  // El panel aparece sin discos todavía: el scroll espera a que estén.
  t.page.panel = t.makePanel('new-releases', 0, 0); t.run(300); assert.equal(t.page.panel.scrollTop, 0);
  t.page.panel.items = 12; t.run(100);
  assert.equal(t.page.panel.scrollTop, 640);
  assert.deepEqual(JSON.parse(JSON.stringify(t.page.logs.at(-1))), ['panel-return', { tipo: 0, scroll: 640, ms: 400 }]);
  // Forward al disco y Back otra vez: se vuelve a abrir.
  t.page.panel = null; t.traverse('K2'); t.run(500); t.traverse('K1'); t.run(200);
  assert.deepEqual(t.page.requests, ['new-releases', 'new-releases']);
});

test('cerrar el panel o salir de esa página sin el panel lo olvida; un panel de sello vuelve con su clave', () => {
  const t = returnPage();
  t.page.panel = t.makePanel('new-releases', 100, 3);
  t.clickInPanel(new t.Element('a[href]', t.page.panel)); t.push('K2'); t.page.panel = null;
  t.traverse('K1'); t.run(200); assert.deepEqual(t.page.requests, ['new-releases']);
  // Back to music en K1: Back desde otra página ya no reabre el panel.
  t.page.panel = t.makePanel('new-releases', 0, 3);
  t.clickInPanel(new t.Element('[data-close-labels]', t.page.panel)); t.page.panel = null;
  t.push('K3'); t.traverse('K1'); t.run(500);
  assert.deepEqual(t.page.requests, ['new-releases']);
  // Un clic con Ctrl (otra pestaña) o fuera de un enlace no recuerda nada; salir por un enlace de Apple tampoco.
  t.page.panel = t.makePanel('new-releases', 0, 3);
  t.clickInPanel(new t.Element('a[href]', t.page.panel), { ctrlKey: true }); t.push('K4'); t.page.panel = null; t.traverse('K1'); t.run(500);
  assert.deepEqual(t.page.requests, ['new-releases']);
  // Panel de un sello: se pide con la clave del último sello abierto.
  t.context.lastLabelKey = 'm0a1b2c3d-0000-4000-8000-000000000001';
  t.page.panel = t.makePanel('label-panel', 0, 3);
  t.clickInPanel(new t.Element('a[href]', t.page.panel)); t.push('K5'); t.page.panel = null;
  t.traverse('K1'); t.run(200);
  assert.deepEqual(t.page.requests, ['new-releases', 'open/m0a1b2c3d-0000-4000-8000-000000000001']);
  // Un clic que no navega (el disco ya estaba abierto) caduca a los 3 s: una navegación posterior no lo toma.
  t.page.panel = t.makePanel('new-releases', 0, 3);
  t.clickInPanel(new t.Element('a[href]', t.page.panel)); t.page.panel = null; t.run(3500);
  t.push('K6'); t.traverse('K1'); t.run(500);
  assert.equal(t.page.requests.length, 2);
});

test('al salir de la página del panel se esconde sin cerrarse; Back a su entrada lo muestra en el navigate, sin pedirlo otra vez', () => {
  const t = returnPage();
  const panel = t.makePanel('new-releases', 640, 12, 'K1');
  t.page.panel = panel;
  // Un enlace del disco desplegado (artista) navega: el panel queda escondido, con su scroll, y no se pide nada.
  t.clickInPanel(new t.Element('a[href]', panel)); t.push('K2');
  assert.equal(panel.classList.contains('el-music-panel--parked'), true);
  assert.equal(panel.scrollTop, 640);
  // Un replaceState del enrutador en la página nueva no lo toca; Back hacia otra entrada (no la suya) tampoco.
  t.replace(); t.push('K3'); t.traverse('K2');
  assert.equal(panel.classList.contains('el-music-panel--parked'), true);
  // Back a su entrada: se muestra en el mismo evento navigate, antes de que cambie la entrada (Apple dibuja después).
  t.traverseStart('K1');
  assert.equal(panel.classList.contains('el-music-panel--parked'), false, 'visible antes de que cambie la entrada');
  t.commit('K1');
  t.run(1000);
  assert.deepEqual(t.page.requests, [], 'el panel escondido se muestra sin pedirlo a main');
  assert.deepEqual(t.page.logs.filter(([event]) => event === 'panel-park').map(([, fields]) => fields.accion), [0, 1]);
  // Forward a la página del artista: se vuelve a esconder; Back: se muestra otra vez.
  t.traverse('K2'); assert.equal(panel.classList.contains('el-music-panel--parked'), true);
  t.traverse('K1'); assert.equal(panel.classList.contains('el-music-panel--parked'), false);
});

test('una navegación cualquiera (barra lateral, LCD) también esconde el panel visible; una recarga no lo toca', () => {
  const t = returnPage();
  const panel = t.makePanel('label-panel', 0, 3, 'K1');
  t.page.panel = panel;
  t.push('K2');
  assert.equal(panel.classList.contains('el-music-panel--parked'), true, 'sin clic en el panel: igual se esconde');
  t.traverse('K1');
  assert.equal(panel.classList.contains('el-music-panel--parked'), false);
  t.run(1000); assert.deepEqual(t.page.requests, []);
});

test('un replace del enrutador que cambia de ruta cierra el panel visible; con la misma ruta o con el panel escondido no lo toca', () => {
  const t = returnPage();
  const panel = t.makePanel('new-releases', 0, 3, 'K1');
  t.page.panel = panel;
  t.replace('https://music.apple.com/ar/new?l=en');
  assert.equal(t.page.closed, 0, 'misma ruta');
  assert.equal(panel.classList.contains('el-music-panel--parked'), false);
  t.replace('https://music.apple.com/ar/browse');
  assert.equal(t.page.closed, 1, 'otra ruta bajo el panel visible: se cierra');
  // Escondido sobre otra página: un replace de esa página no lo cierra (Back todavía tiene que poder mostrarlo).
  const parked = t.makePanel('new-releases', 0, 3, 'K1');
  t.page.panel = parked; t.push('K2');
  assert.equal(parked.classList.contains('el-music-panel--parked'), true);
  t.replace('https://music.apple.com/ar/album/1');
  assert.equal(t.page.closed, 1);
});
