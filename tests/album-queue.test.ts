import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { albumQueueLimits, albumQueueWakeMessage, albumTracksScript, arrangeSongs, firstSongs, installAlbumQueue, parseAlbumTracks, queueAppendScript, queueDecision, queueStartScript } from '../src/album-queue';

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await tick(); };

test('el orden de la cola: discos en el orden pedido y, con shuffle, los temas mezclados sólo dentro de cada disco', () => {
  const albums = [['1', '2', '3', '4'], ['5', '6'], [], ['7', '8', '9']];
  assert.deepEqual(arrangeSongs(albums, 'in-order'), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  // Fisher–Yates con un azar fijo (siempre 0): cada disco queda rotado, pero sigue entero y en su lugar.
  const shuffled = arrangeSongs(albums, 'shuffle', () => 0);
  assert.deepEqual(shuffled, ['2', '3', '4', '1', '6', '5', '8', '9', '7']);
  for (let run = 0; run < 50; run++) {
    const songs = arrangeSongs(albums, 'shuffle');
    assert.deepEqual(songs.slice(0, 4).sort(), ['1', '2', '3', '4']); assert.deepEqual(songs.slice(4, 6).sort(), ['5', '6']); assert.deepEqual(songs.slice(6).sort(), ['7', '8', '9']);
  }
});

test('temas de los discos: sólo los pedidos, IDs numéricos sin repetir, y los errores de Apple pasan como número', () => {
  const parsed = parseAlbumTracks([{ id: '10', songs: ['1', '2', 'x', '2'] }, { id: '99', songs: ['5'] }, { id: '11', songs: [] }, { id: '10', songs: ['3'] }, null], ['10', '11', '12']);
  assert.deepEqual([...parsed.tracks.entries()], [['10', ['1', '2']], ['11', []]]);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parseAlbumTracks({ error: 429 }, ['10']).error, 429);
  assert.deepEqual(parseAlbumTracks(null, ['10']).error, 0);
  assert.throws(() => albumTracksScript('arg', ['1'])); assert.throws(() => albumTracksScript('ar', [])); assert.throws(() => albumTracksScript('ar', ['1x']));
  assert.throws(() => albumTracksScript('ar', Array.from({ length: albumQueueLimits.idsPerRequest + 1 }, (_, i) => String(i + 1))));
  assert.throws(() => queueStartScript([])); assert.throws(() => queueStartScript(['1', 'a']));
  assert.throws(() => queueAppendScript(['1'], 0, '1')); assert.throws(() => queueAppendScript(['1'], 3, 'x'));
  // El arranque apaga el shuffle de Apple antes del único setQueue con startPlaying; el agregado valida largo y último tema.
  const start = queueStartScript(['1', '2']);
  assert.ok(start.indexOf('music.shuffleMode = 0') < start.indexOf('music.setQueue({ songs: ["1","2"], startPlaying: true })'));
  assert.match(queueAppendScript(['5'], 3, '4'), /items\.length !== 3 \|\| String\(items\[items\.length - 1\]\?\.id\) !== "4"\) return 'changed'/);
});

test('decisión: un tema ajeno termina la cola; con menos de 12 por sonar y discos pendientes se agrega', () => {
  const queued = new Set(Array.from({ length: 30 }, (_, i) => String(i + 1)));
  const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => String(i + 1));
  assert.equal(queueDecision({ position: 0, ids: ids(30), shuffle: 0 }, queued, true, 30), 'none');
  assert.equal(queueDecision({ position: 18, ids: ids(30), shuffle: 0 }, queued, true, 30), 'refill');
  assert.equal(queueDecision({ position: 18, ids: ids(30), shuffle: 0 }, queued, false, 30), 'none');
  assert.equal(queueDecision({ position: -1, ids: ids(5), shuffle: 0 }, queued, true, 5), 'refill');
  assert.equal(queueDecision({ position: 3, ids: [...ids(3), '999', '4', '5'], shuffle: 0 }, queued, true, 6), 'end');
  assert.equal(queueDecision({ position: 0, ids: [], shuffle: 0 }, queued, true, 0), 'end');
  // Temas ajenos sólo al final (autoplay de Apple): no cortan mientras sobran temas propios; cuando haría falta agregar, 'tail'.
  assert.equal(queueDecision({ position: 2, ids: [...ids(30), '900', '901'], shuffle: 0 }, queued, true, 30), 'none');
  assert.equal(queueDecision({ position: 20, ids: [...ids(30), '900', '901'], shuffle: 0 }, queued, true, 30), 'tail');
  assert.equal(queueDecision({ position: 20, ids: ['900', ...ids(30)], shuffle: 0 }, queued, true, 31), 'end');
  assert.equal(queueDecision({ position: 18, ids: ids(30), shuffle: 1 }, queued, true, 30), 'refill');
  assert.equal(queueDecision({ position: 18, ids: ids(30), shuffle: 0 }, queued, true, albumQueueLimits.songs), 'none');
});

// Página falsa: el catálogo devuelve tres temas por disco (el disco 13 no tiene temas reproducibles) y la cola de Apple
// se simula con su posición; registra cada setQueue y playLater.
function fakePage(options: { emptyAlbums?: string[]; relink?: Record<string, string> } = {}) {
  const page = { queue: [] as string[], position: -1, shuffle: 1, active: false, failStart: false, setQueue: [] as string[][], playLater: [] as string[][], albumRequests: [] as string[][], logs: [] as [string, Record<string, unknown> | undefined][] };
  // Apple puede dejar en la cola otro ID para un tema (otra edición disponible en la región).
  const relink = (songs: string[]): string[] => songs.map(id => options.relink?.[id] ?? id);
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: {
      executeJavaScript: async (script: string): Promise<unknown> => {
        await tick();
        if (script.includes('/albums')) {
          const ids = JSON.parse(script.match(/\{ ids: ("[\d,]+") \}/)![1]).split(',') as string[];
          page.albumRequests.push(ids);
          return ids.map(id => ({ id, songs: options.emptyAlbums?.includes(id) ? [] : [id + '01', id + '02', id + '03'] }));
        }
        if (script.includes('music.setQueue(')) {
          const songs = JSON.parse(script.match(/songs: (\[[^\]]*\])/)![1]) as string[];
          if (page.failStart) return 'unavailable';
          if (script.includes('music.shuffleMode = 0')) page.shuffle = 0;
          page.setQueue.push(songs); page.queue = relink(songs); page.position = 0; return 'requested/' + songs.length;
        }
        if (script.includes('music.playLater(')) {
          const songs = JSON.parse(script.match(/songs: (\[[^\]]*\])/)![1]) as string[];
          const [, length, last] = script.match(/items\.length !== (\d+) \|\| String\(items\[items\.length - 1\]\?\.id\) !== "(\d+)"/)!;
          if (page.queue.length !== Number(length) || page.queue[page.queue.length - 1] !== last) return 'changed';
          page.playLater.push(songs); page.queue.push(...relink(songs)); return 'appended/' + page.queue.length;
        }
        if (script.includes('music?.queue?.items')) return { position: page.position, shuffle: page.shuffle, ids: [...page.queue] };
        if (script.includes('elMusicAlbumQueue')) { page.active = script.includes('if (true)'); return true; }
        return null;
      }
    }
  });
  const queue = installAlbumQueue(contents as unknown as WebContents, (event, fields) => page.logs.push([event, fields]));
  const wake = (): void => { contents.emit('console-message', { message: albumQueueWakeMessage, frame: contents.mainFrame }); };
  return { page, queue, wake, destroy: () => contents.emit('destroyed') };
}

test('Play: arranca con el disco y los tres siguientes y alarga la cola con los demás discos, en orden, hasta el final', async t => {
  const { page, queue, wake, destroy } = fakePage(); t.after(destroy);
  const albums = Array.from({ length: 12 }, (_, i) => String(100 + i));
  assert.equal(await queue.start(albums, 'in-order', 'ar'), 'requested');
  // Primer tramo: 4 discos en un pedido; el shuffle de Apple quedó apagado y la cola en el orden de la lista.
  assert.deepEqual(page.albumRequests[0], albums.slice(0, 4));
  assert.deepEqual(page.setQueue[0], ['10001', '10002', '10003', '10101', '10102', '10103', '10201', '10202', '10203', '10301', '10302', '10303']);
  assert.equal(page.shuffle, 0);
  await settle();
  assert.equal(page.active, true, 'la página avisa los cambios de tema mientras dura la cola');
  // Quedaban 11 por sonar (< 12): se agregaron los 6 discos siguientes al final.
  assert.deepEqual(page.albumRequests[1], albums.slice(4, 10));
  assert.deepEqual(page.playLater[0].slice(0, 3), ['10401', '10402', '10403']); assert.equal(page.playLater[0].length, 18); assert.equal(page.queue.length, 30);
  // Next, Next…: al acercarse al final se agregan los dos discos que quedan; después ya no hay más que agregar.
  page.position = 20; wake(); await settle();
  assert.deepEqual(page.albumRequests[2], albums.slice(10)); assert.equal(page.queue.length, 36); assert.deepEqual(page.queue.slice(-3), ['11101', '11102', '11103']);
  page.position = 35; wake(); await settle();
  assert.equal(page.playLater.length, 2); assert.equal(page.active, false);
  assert.ok(page.logs.some(([event, fields]) => event === 'Cola de discos: terminada' && fields?.fin === 0));
  destroy();
});

test('Shuffle: cada disco suena mezclado, pero los discos siguen el orden de la lista también al alargar la cola', async t => {
  const { page, queue, destroy } = fakePage(); t.after(destroy);
  const albums = Array.from({ length: 6 }, (_, i) => String(200 + i));
  assert.equal(await queue.start(albums, 'shuffle', 'ar'), 'requested');
  await settle();
  const groups = (songs: string[]): string[] => songs.map(id => id.slice(0, 3)).filter((album, i, list) => list.indexOf(album) === i);
  assert.deepEqual(groups(page.queue), albums);
  for (const album of albums) assert.deepEqual(page.queue.filter(id => id.startsWith(album)).sort(), [album + '01', album + '02', album + '03']);
  assert.ok(page.logs.some(([event, fields]) => event === 'Cola de discos: reproducir' && fields?.modo === 1));
  destroy();
});

test('si el usuario reproduce otra cosa, la cola de discos termina y no vuelve a tocar la cola de Apple', async t => {
  const { page, queue, wake, destroy } = fakePage(); t.after(destroy);
  await queue.start(Array.from({ length: 30 }, (_, i) => String(300 + i)), 'in-order', 'ar');
  await settle();
  const appended = page.playLater.length;
  page.queue = ['900001', '900002']; page.position = 0; wake(); await settle();
  assert.equal(page.playLater.length, appended); assert.equal(page.active, false);
  assert.ok(page.logs.some(([event, fields]) => event === 'Cola de discos: terminada' && fields?.fin === 1));
  page.position = 1; wake(); await settle();
  assert.equal(page.playLater.length, appended);
  destroy();
});

test('un disco elegido sin temas reproducibles no arma ninguna cola; los discos vacíos del medio se saltean', async t => {
  const first = fakePage({ emptyAlbums: ['400'] }); t.after(first.destroy);
  assert.equal(await first.queue.start(['400', '401'], 'in-order', 'ar'), 'empty');
  assert.equal(first.page.setQueue.length, 0); assert.equal(first.page.active, false);
  first.destroy();
  const second = fakePage({ emptyAlbums: ['411'] }); t.after(second.destroy);
  assert.equal(await second.queue.start(['410', '411', '412'], 'in-order', 'ar'), 'requested');
  assert.deepEqual(second.page.setQueue[0], ['41001', '41002', '41003', '41201', '41202', '41203']);
  // Un país inválido o una lista vacía no llegan a la página.
  assert.equal(await second.queue.start([], 'in-order', 'ar'), 'failed'); assert.equal(await second.queue.start(['1'], 'in-order', 'arg'), 'failed');
  second.destroy();
});

test('una cola nueva reemplaza a la anterior: la vieja deja de alargarse', async t => {
  const { page, queue, wake, destroy } = fakePage(); t.after(destroy);
  await queue.start(Array.from({ length: 30 }, (_, i) => String(500 + i)), 'in-order', 'ar');
  await settle();
  await queue.start(['600', '601'], 'shuffle', 'ar');
  assert.ok(page.logs.some(([event, fields]) => event === 'Cola de discos: terminada' && fields?.fin === 2));
  page.position = 4; wake(); await settle();
  assert.ok(page.queue.every(id => id.startsWith('60')));
  assert.ok(page.playLater.every(list => list.every(id => id.startsWith('50'))));
  destroy();
});

test('un Play que no prospera no corta la cola que ya sonaba: la vieja se sigue alargando', async t => {
  const { page, queue, wake, destroy } = fakePage(); t.after(destroy);
  await queue.start(Array.from({ length: 30 }, (_, i) => String(700 + i)), 'in-order', 'ar');
  await settle();
  const appended = page.playLater.length;
  page.failStart = true;
  assert.equal(await queue.start(['800', '801'], 'in-order', 'ar'), 'unavailable');
  await settle();
  assert.ok(!page.logs.some(([event]) => event === 'Cola de discos: terminada'), 'la cola vieja sigue viva');
  assert.equal(page.active, true);
  page.position = 20; wake(); await settle();
  assert.equal(page.playLater.length, appended + 1, 'y se sigue alargando');
  destroy();
});

test('si Apple deja otro ID para un tema, la cola lo toma como propio y se sigue alargando', async t => {
  const { page, queue, wake, destroy } = fakePage({ relink: { '90001': '55501', '90401': '55541' } }); t.after(destroy);
  await queue.start(Array.from({ length: 12 }, (_, i) => String(900 + i)), 'in-order', 'ar');
  await settle();
  assert.equal(page.queue[0], '55501'); assert.equal(page.playLater.length, 1);
  page.position = 20; wake(); await settle();
  assert.equal(page.playLater.length, 2, 'los IDs cambiados por Apple no terminan la cola');
  assert.ok(!page.logs.some(([event, fields]) => event === 'Cola de discos: terminada' && fields?.fin === 1));
  destroy();
});

test('un arranque que no prospera sin cola previa no deja la marca de cola puesta', async t => {
  const { page, queue, destroy } = fakePage(); t.after(destroy);
  page.failStart = true; page.active = true;
  assert.equal(await queue.start(['950'], 'in-order', 'ar'), 'unavailable');
  await settle();
  assert.equal(page.active, false);
  destroy();
});

test('desde un tema del disco desplegado: la cola empieza en ese tema y sigue con los discos siguientes; un tema ajeno no arranca nada', () => {
  const albums = [['1', '2', '3'], ['4', '5'], ['6']];
  assert.deepEqual(firstSongs(albums, 'in-order', '2'), ['2', '3', '4', '5', '6']);
  assert.deepEqual(firstSongs(albums, 'in-order'), ['1', '2', '3', '4', '5', '6']);
  assert.equal(firstSongs(albums, 'in-order', '4'), undefined, 'un tema de otro disco no vale');
  assert.equal(firstSongs(albums, 'in-order', '99'), undefined);
  assert.deepEqual(firstSongs(albums, 'shuffle', '3', () => 0)?.slice(0, 1), ['3']);
});
