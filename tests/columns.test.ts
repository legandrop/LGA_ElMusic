import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { columnsScript, defaultColumns, installColumnPrefs, parseColumns, readColumns, saveColumns, takeColumnsScript } from '../src/columns';
import { parsePageLog, pageLogFunctionScript, takePageLogScript } from '../src/page-log';
import { categoryOf, environmentLogSettings, isErrorEvent, parseLogSettings, readLogSettings, saveLogSettings, shouldLog } from '../src/diagnostic';

test('la configuración de columnas sólo acepta el conjunto cerrado: orden completo, Canción visible y anchos acotados', () => {
  assert.deepEqual(parseColumns(defaultColumns), defaultColumns);
  assert.deepEqual(parseColumns({ order: ['time', 'genre', 'label', 'released', 'album', 'song', 'artist'], hidden: ['genre'], widths: { artist: 200 } }),
    { order: ['time', 'genre', 'label', 'released', 'album', 'song', 'artist'], hidden: ['genre'], widths: { artist: 200 } });
  assert.deepEqual(defaultColumns.order[0], 'song'); // Canción primera por defecto.
  assert.deepEqual(parseColumns({ order: defaultColumns.order, widths: { song: 100 } }), { order: defaultColumns.order, hidden: [], widths: { song: 100 } });
  for (const bad of [null, [], 'x', { order: ['song'] }, { order: [...defaultColumns.order, 'song'] }, { order: defaultColumns.order.map(key => key === 'time' ? 'rating' : key) },
    { order: defaultColumns.order, hidden: ['song'] }, { order: defaultColumns.order, hidden: ['label', 'label'] },
    { order: defaultColumns.order, widths: { artist: 10 } }, { order: defaultColumns.order, widths: { artist: 100.5 } }, { order: defaultColumns.order, widths: { artist: 5000 } },
    { order: defaultColumns.order, extra: 1 }, { order: defaultColumns.order, widths: [] }]) assert.equal(parseColumns(bad), undefined, JSON.stringify(bad));
});

test('columns.json se lee, se guarda atómico y un archivo ajeno no se pisa', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-columns-'));
  try {
    assert.deepEqual(readColumns(folder), defaultColumns);
    const config = { order: defaultColumns.order, hidden: ['genre' as const], widths: { label: 150 } };
    saveColumns(folder, config);
    assert.deepEqual(readColumns(folder), config); assert.deepEqual(fs.readdirSync(folder), ['columns.json']);
    fs.writeFileSync(path.join(folder, 'columns.json'), '{"order":"x"}');
    assert.throws(() => readColumns(folder), /INVALID/); assert.throws(() => saveColumns(folder, config), /INVALID/);
    assert.equal(fs.readFileSync(path.join(folder, 'columns.json'), 'utf8'), '{"order":"x"}');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('main toma el pedido de la página, lo valida y lo guarda; lo inválido se registra y no cambia nada', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-columns-'));
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (() => ({}) as NodeJS.Timeout) as unknown as typeof setInterval;
  try {
    let request: string | undefined; const events: string[] = [];
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, getURL: () => 'https://music.apple.com/ar/library/playlist/p.X',
      mainFrame: { executeJavaScript: async (script: string) => { assert.equal(script, takeColumnsScript); const value = request; request = undefined; return value ?? null; } } });
    const prefs = installColumnPrefs(contents as unknown as WebContents, folder, event => events.push(event));
    assert.deepEqual(prefs.current(), defaultColumns);
    const wake = async (value: string): Promise<void> => { request = value; contents.emit('console-message', { message: 'elMusic.columns.changed', frame: contents.mainFrame }); for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
    await wake(JSON.stringify({ order: defaultColumns.order, hidden: ['label'], widths: { album: 300 } }));
    assert.deepEqual(prefs.current(), { order: defaultColumns.order, hidden: ['label'], widths: { album: 300 } });
    assert.deepEqual(readColumns(folder), prefs.current());
    await wake('{bad'); await wake(JSON.stringify({ order: ['song'] }));
    assert.deepEqual(readColumns(folder).hidden, ['label']);
    assert.deepEqual(events, ['Columnas: configuración cargada', 'Columnas: cambio recibido', 'Columnas: pedido ilegible de la página', 'Columnas: pedido rechazado']);
    // El script de aplicación deja la configuración en el símbolo de la página y avisa.
    const root: Record<symbol, unknown> = {}; const fired: string[] = []; const self = {};
    const context = vm.createContext({ document: { documentElement: root, dispatchEvent: (event: { type: string }) => fired.push(event.type) }, top: self, self, location: new URL('https://music.apple.com/ar/new'), URL,
      Event: class { constructor(readonly type: string) {} } });
    assert.equal(vm.runInContext(columnsScript(prefs.current()), context), true);
    assert.deepEqual(JSON.parse(JSON.stringify(root[Symbol.for('el-music.columns')])), prefs.current()); assert.deepEqual(fired, ['el-music-columns']);
    contents.emit('destroyed');
  } finally { globalThis.setInterval = originalInterval; fs.rmSync(folder, { recursive: true, force: true }); }
});

test('el log de la página acepta sólo eventos conocidos, números y textos limpios; apagado no acumula', () => {
  const root: Record<symbol, unknown> & { dataset?: unknown } = {}; const console = { messages: [] as string[], debug: (message: string) => console.messages.push(message) };
  const self = {};
  const context = vm.createContext({ document: { documentElement: root }, console, top: self, self, location: new URL('https://music.apple.com/ar/new'), URL });
  vm.runInContext(pageLogFunctionScript + "; pageLog('columns-resize', { clave: 'artist', ancho: 200.4 }); pageLog('error', { donde: 'x', texto: 'Error: fetch https://amp-api.music.apple.com/v1/me?token=1 failed\\n at <anon>' }); pageLog('hack', { texto: 'x' });", context);
  const taken = vm.runInContext(takePageLogScript, context) as string;
  assert.deepEqual(console.messages, ['elMusic.log.ready', 'elMusic.log.ready', 'elMusic.log.ready']);
  assert.deepEqual(parsePageLog(taken), [{ event: 'columns-resize', fields: { clave: 'artist', ancho: 200.4 } },
    { event: 'error', fields: { donde: 'x', texto: 'Error: fetch <url> failed at <anon>' } }]);
  assert.equal(vm.runInContext(takePageLogScript, context), null);
  root[Symbol.for('el-music.log-enabled')] = false;
  vm.runInContext("pageLog('list-sort', { clave: 'song' })", context);
  assert.equal(vm.runInContext(takePageLogScript, context), null);
  assert.deepEqual(parsePageLog('[{"event":"list-sort","fields":{"clave":"song","nombre":"ajeno","n":"1","x y":2}}]'), [{ event: 'list-sort', fields: { clave: 'song' } }]);
  assert.deepEqual(parsePageLog('no json'), []); assert.deepEqual(parsePageLog(5), []);
});

test('las categorías del log: los errores siempre, lo informativo según logging.json o ELMUSIC_LOG', () => {
  assert.equal(categoryOf('Sellos de lista: catálogo'), 'labels'); assert.equal(categoryOf('Sellos: página de Apple abierta'), 'labels');
  assert.equal(categoryOf('Playlist: carga medida'), 'playlist'); assert.equal(categoryOf('Columnas: cambio recibido'), 'columns');
  assert.equal(categoryOf('Página: columna movida'), 'page'); assert.equal(categoryOf('Recomendaciones completadas'), 'related');
  assert.equal(categoryOf('Canal Stream Deck activo'), 'streamdeck'); assert.equal(categoryOf('Inicio'), 'core');
  assert.equal(isErrorEvent('Sellos de lista: error del catálogo'), true); assert.equal(isErrorEvent('No se pudo guardar geometría'), true);
  assert.equal(isErrorEvent('Página: error en el script de la página'), true); assert.equal(isErrorEvent('Sellos de lista: catálogo'), false);
  const off = { labels: false, playlist: false, columns: false, page: false, related: false, releases: false, streamdeck: false };
  assert.equal(categoryOf('Novedades: lanzamientos'), 'releases');
  assert.equal(shouldLog('Sellos de lista: catálogo', off), false); assert.equal(shouldLog('Sellos de lista: error del catálogo', off), true);
  assert.equal(shouldLog('Inicio', off), true); assert.equal(shouldLog('Playlist: carga medida', { ...off, playlist: true }), true);
  assert.deepEqual(environmentLogSettings('labels, PAGE'), { ...off, labels: true, page: true });
  assert.deepEqual(environmentLogSettings('none'), off); assert.equal(environmentLogSettings(undefined), undefined);
  assert.equal(environmentLogSettings('all')?.related, true);
  assert.equal(parseLogSettings({ labels: 'yes' }), undefined); assert.equal(parseLogSettings({ other: true }), undefined);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-logging-'));
  try {
    assert.deepEqual(readLogSettings(folder), { ...off, labels: true, playlist: true, columns: true, page: true, related: true, releases: true, streamdeck: true });
    saveLogSettings(folder, { ...off, labels: true });
    assert.deepEqual(readLogSettings(folder), { ...off, labels: true });
    fs.writeFileSync(path.join(folder, 'logging.json'), '[]'); assert.throws(() => readLogSettings(folder), /INVALID/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
