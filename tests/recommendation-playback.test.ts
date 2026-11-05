import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { recommendationPlayback, recommendationPlaybackScript, recommendationQueue } from '../src/recommendation-playback';

const epoch = '00000000-0000-4000-8000-000000000001';
function fixture(ids = ['123', '456', '789']): {
  run: (songs?: string[]) => Promise<unknown>; nav: { dataset: Record<string, string> }; root: { dataset: Record<string, string> };
  calls: Array<{ songs: string[]; startPlaying: boolean; repeatMode: number }>; plays: () => number;
  setQueue: (result: () => Promise<unknown>) => void; close: () => void; replace: () => void;
  changes: number[]; setChange: (result: () => Promise<void>) => void;
  replaceQueue: () => void; reverseQueue: () => void; changeRows: () => void; disableChange: () => void;
  changeQueueEvent: () => void; listeners: () => number; changeModes: () => void;
} {
  const root = { dataset: {} as Record<string, string> }; const nav = { dataset: { recommendationEpoch: epoch } as Record<string, string> };
  const rows = ids.map(id => ({ dataset: { elMusicRecommendationId: id } }));
  let panel: unknown; const originalPanel = { dataset: { recommendationEpoch: epoch }, querySelectorAll: (selector: string) => selector === '[data-el-music-recommendation-id]' ? rows : [] };
  panel = originalPanel;
  const calls: Array<{ songs: string[]; startPlaying: boolean; repeatMode: number }> = []; let count = 0;
  let queue: (songs: string[]) => Promise<unknown> = async songs => ({ items: songs.map(id => ({ id })), position: 0 });
  const changes: number[] = []; let change: () => Promise<void> = async () => {};
  const queueListeners = new Set<() => void>();
  const music = { shuffleMode: 1, repeatMode: 0, queue: undefined as { items?: object[] } | undefined,
    setQueue: async (options: { songs: string[]; startPlaying: boolean; repeatMode: number }): Promise<unknown> => {
      calls.push(JSON.parse(JSON.stringify(options))); const result = await queue(options.songs);
      music.queue = result as typeof music.queue; return result;
    }, play: async (): Promise<void> => { count++; throw new Error('El comando único no emite un play adicional'); },
    changeToMediaAtIndex: ((index: number): Promise<void> => { changes.push(index); return change(); }) as ((index: number) => Promise<void>) | undefined,
    addEventListener: (name: string, listener: () => void) => { assert.equal(name, 'queueItemsDidChange'); queueListeners.add(listener); },
    removeEventListener: (name: string, listener: () => void) => { assert.equal(name, 'queueItemsDidChange'); queueListeners.delete(listener); } };
  Object.defineProperties(music, { developerToken: { get: () => { throw new Error('No leer credenciales'); } }, musicUserToken: { get: () => { throw new Error('No leer credenciales'); } }, api: { get: () => { throw new Error('No API de catálogo'); } } });
  const frame = {};
  const context = vm.createContext({ MusicKit: { getInstance: () => music, PlayerShuffleMode: { off: 0 }, PlayerRepeatMode: { none: 0 } },
    document: { documentElement: root, getElementById: (id: string) => id === 'el-music-navigation' ? nav : panel },
    top: frame, self: frame, URL, location: new URL('https://music.apple.com/ar/new') });
  return { run: songs => vm.runInContext(recommendationPlaybackScript(epoch, songs ?? ids), context), nav, root, calls, plays: () => count,
    setQueue: next => { queue = next; }, close: () => { panel = undefined; }, replace: () => { panel = { ...originalPanel }; },
    changes, setChange: next => { change = next; }, replaceQueue: () => { music.queue = { items: music.queue?.items?.map(item => ({ ...item })) }; },
    reverseQueue: () => { music.queue?.items?.reverse(); }, changeRows: () => { rows.reverse(); }, disableChange: () => { music.changeToMediaAtIndex = undefined; },
    changeQueueEvent: () => { for (const listener of [...queueListeners]) listener(); }, listeners: () => queueListeners.size,
    changeModes: () => { music.shuffleMode = 1; music.repeatMode = 1; } };
}

test('related queue starts at the clicked song and includes every other known song once', () => {
  const items = [{ id: '123' }, { id: '456' }, { id: '789' }];
  assert.deepEqual(recommendationQueue(items, '456', 8), ['456', '789', '123']);
  assert.deepEqual(recommendationQueue(items, '789', 8), ['789', '123', '456']);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1) }));
  assert.equal(recommendationQueue(twelve, '1', 8)?.length, 8); assert.equal(recommendationQueue(twelve, '1', 12)?.length, 12);
  const thirtyTwo = Array.from({ length: 32 }, (_, i) => ({ id: String(i + 1) }));
  assert.deepEqual(recommendationQueue(thirtyTwo, '30', 24), ['30', '31', '32', ...Array.from({ length: 21 }, (_, i) => String(i + 1))]);
  for (const items of [[], [{ id: 'bad' }], [{ id: '123' }, { id: '123' }], [...thirtyTwo, { id: '33' }]]) assert.equal(recommendationQueue(items, '123', 24), undefined);
  for (const limit of [0, -1, 25, 1.5, NaN]) assert.equal(recommendationQueue(items, '123', limit), undefined);
  assert.equal(recommendationQueue([{ id: '123' }], '999', 8), undefined);
});

test('another verified song in the same native queue changes index without reloading or a second play', async () => {
  const f = fixture(); assert.equal(await f.run(['456', '789', '123']), 'requested');
  f.replace();
  assert.equal(await f.run(['123', '456', '789']), 'requested');
  assert.equal(await f.run(['789', '123', '456']), 'requested');
  assert.equal(f.calls.length, 1); assert.equal(f.plays(), 0); assert.deepEqual(f.changes, [2, 1]);
});

test('changed public queue references or order reloads the requested verified queue', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.replaceQueue(), (f: ReturnType<typeof fixture>) => f.reverseQueue()]) {
    const f = fixture(); await f.run(); mutate(f);
    assert.equal(await f.run(['456', '789', '123']), 'requested');
    assert.equal(f.calls.length, 2); assert.equal(f.plays(), 0); assert.deepEqual(f.changes, []);
  }
});

test('SDKs without the public index command use the ordered queue fallback', async () => {
  const f = fixture(); await f.run(); f.disableChange();
  assert.equal(await f.run(['456', '789', '123']), 'requested');
  assert.equal(f.calls.length, 2); assert.equal(f.plays(), 0); assert.deepEqual(f.changes, []);
});

test('a public queue change notification invalidates even unchanged item references without accumulating listeners', async () => {
  const f = fixture(); await f.run(); assert.equal(f.listeners(), 1);
  f.changeQueueEvent(); assert.equal(f.listeners(), 0);
  assert.equal(await f.run(['456', '789', '123']), 'requested');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.changes, []); assert.equal(f.listeners(), 1);
  f.reverseQueue(); await f.run(); assert.equal(f.listeners(), 1);
});

test('shuffle or repeat drift rebuilds an ordered queue instead of using an obsolete index', async () => {
  const f = fixture(); await f.run(); f.changeModes();
  assert.equal(await f.run(['456', '789', '123']), 'requested');
  assert.equal(f.calls.length, 2); assert.deepEqual(f.changes, []);
});

test('malformed or duplicate visible IDs and unbounded command lists cannot mutate playback', async () => {
  for (const ids of [['123', '123'], ['123', 'bad'], Array.from({ length: 33 }, (_, i) => String(i + 1))]) {
    const f = fixture(ids); assert.equal(await f.run(['123']), 'view-changed'); assert.equal(f.calls.length, 0); assert.equal(f.plays(), 0);
  }
  for (const songs of [['123', '123'], Array.from({ length: 25 }, (_, i) => String(i + 1))]) {
    assert.throws(() => recommendationPlaybackScript(epoch, songs), /inválida/);
  }
});

test('a changed list or epoch never reuses previous queue provenance', async () => {
  const changed = fixture(); await changed.run(); changed.changeRows();
  assert.equal(await changed.run(['789', '456', '123']), 'requested'); assert.equal(changed.calls.length, 2); assert.deepEqual(changed.changes, []);
  const stale = fixture(); await stale.run(); stale.nav.dataset.recommendationEpoch = 'new-context';
  assert.equal(await stale.run(), 'view-changed'); assert.equal(stale.calls.length, 1); assert.deepEqual(stale.changes, []);
});

test('native index changes retain the document lock and never retry a failed audio effect', async () => {
  const f = fixture(); await f.run(); let resolve!: () => void;
  f.setChange(() => new Promise<void>(next => { resolve = next; }));
  const pending = f.run(['456', '789', '123']);
  assert.equal(await f.run(), 'busy'); assert.deepEqual(f.changes, [1]); assert.equal(f.calls.length, 1);
  resolve(); assert.equal(await pending, 'requested');
  f.setChange(async () => { throw new Error('No reintentar efectos'); });
  assert.equal(await f.run(['789', '123', '456']), 'failed'); assert.equal(f.calls.length, 1); assert.equal(f.plays(), 0);
});

test('a verified list larger than the native queue only queues its bounded selected window', async () => {
  const ids = Array.from({ length: 32 }, (_, i) => String(i + 1)), f = fixture(ids);
  const first = recommendationQueue(ids.map(id => ({ id })), '30', 24)!;
  assert.equal(await f.run(first), 'requested'); assert.equal(f.calls[0].songs.length, 24);
  const inQueue = recommendationQueue(ids.map(id => ({ id })), '5', 24)!;
  assert.equal(await f.run(inQueue), 'requested'); assert.equal(f.calls.length, 1); assert.deepEqual(f.changes, [7]);
  const outsideQueue = recommendationQueue(ids.map(id => ({ id })), '25', 24)!;
  assert.equal(await f.run(outsideQueue), 'requested'); assert.equal(f.calls.length, 2); assert.equal(f.plays(), 0);
});
test('one explicit request uses public ordered queue commands without reading credentials', async () => {
  const f = fixture(); assert.equal(await f.run(['456', '789', '123']), 'requested');
  assert.deepEqual(f.calls, [{ songs: ['456', '789', '123'], startPlaying: true, repeatMode: 0 }]); assert.equal(f.plays(), 0);
  assert.equal(f.root.dataset.elMusicRecommendationQueueBusy, undefined);
});
test('a document lock survives panel replacement and prevents concurrent queue mutation', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.setQueue(() => new Promise(next => { resolve = next; })); const first = f.run();
  assert.ok(f.root.dataset.elMusicRecommendationQueueBusy); f.replace();
  assert.equal(await f.run(), 'busy'); assert.equal(f.calls.length, 1);
  resolve({}); assert.equal(await first, 'requested'); assert.equal(f.plays(), 0); assert.equal(f.root.dataset.elMusicRecommendationQueueBusy, undefined);
});
test('closing after the single accepted queue command never claims its playback effect was suppressed', async () => {
  for (const action of ['close', 'mode', 'retry'] as const) {
    const f = fixture(); let resolve!: (value: unknown) => void;
    f.setQueue(() => new Promise(next => { resolve = next; })); const pending = f.run();
    if (action === 'close') f.close(); else f.nav.dataset.recommendationRequest = `open/${epoch}/${action === 'mode' ? 'artist' : 'track'}`;
    resolve({}); assert.equal(await pending, 'requested'); assert.equal(f.calls.length, 1); assert.equal(f.plays(), 0);
  }
});
test('unsupported queue return and SDK failures never call play or claim audio success', async () => {
  const unavailable = fixture(); unavailable.setQueue(async () => undefined); assert.equal(await unavailable.run(), 'unavailable'); assert.equal(unavailable.plays(), 0);
  const failed = fixture(); failed.setQueue(async () => { throw new Error('Contenido externo que no se devuelve'); }); assert.equal(await failed.run(), 'failed'); assert.equal(failed.plays(), 0);
  for (const value of [{ url: 'sensitive' }, true, 'playing', undefined]) assert.equal(recommendationPlayback(value), 'failed');
});

test('a changed list after dispatch never caches obsolete native queue provenance', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.setQueue(() => new Promise(next => { resolve = next; }));
  const pending = f.run(); f.changeRows();
  resolve({ items: [{}, {}, {}] });
  assert.equal(await pending, 'requested'); assert.equal(f.calls.length, 1); assert.equal(f.plays(), 0); assert.equal(f.listeners(), 0);
});
