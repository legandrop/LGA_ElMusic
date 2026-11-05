import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { musicLinkFunctionScript } from '../src/music-navigation';

test('router success requires newly rendered native content; stale and own headings cannot acknowledge', () => {
  for (const rendering of ['stale', 'new', 'own-panel', 'detached', 'cancelled', 'fast-back']) {
    let callback = false, alert = false, tick: (() => void) | undefined, click: ((event: object) => void) | undefined;
    const player = { isConnected: true };
    const oldHeading = { textContent: 'Same title', closest: () => null };
    let headings = [oldHeading];
    const location = { href: 'https://music.apple.com/ar/album/old/111', origin: 'https://music.apple.com', pathname: '/ar/album/old/111' };
    const link = { href: '', isConnected: true, addEventListener: (_type: string, fn: (event: object) => void) => { click = fn; }, after: () => { alert = true; } };
    const context = { URL, Map, location, link, title: 'Same title', url: 'https://music.apple.com/ar/album/new/222',
      accepted: () => { callback = true; }, setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, PopStateEvent: class {},
      document: { querySelector: () => player, querySelectorAll: () => headings, getElementById: (id: string) => id === 'el-music-navigation' && ['detached', 'cancelled'].includes(rendering) ? { appendChild: () => { alert = true; } } : null, createElement: () => ({ setAttribute: () => {}, textContent: '' }) },
      history: { pushState: (_state: unknown, _unused: string, url: string) => { const next = new URL(url); Object.assign(location, { href: next.href, origin: next.origin, pathname: next.pathname }); } },
      dispatchEvent: () => { if (['detached', 'cancelled'].includes(rendering)) link.isConnected = false; else if (rendering !== 'stale') headings = [{ textContent: 'Same title', closest: () => rendering === 'own-panel' ? {} as never : null }]; } };
    new vm.Script(`${musicLinkFunctionScript}\nmusicLink(link,url,title,accepted);`).runInNewContext(context);
    click?.({ preventDefault: () => {} });
    if (rendering === 'cancelled') { location.href = 'https://music.apple.com/ar/library/artists'; location.pathname = '/ar/library/artists'; }
    if (rendering === 'fast-back') { location.href = 'https://music.apple.com/ar/album/old/111'; location.pathname = '/ar/album/old/111'; }
    for (let i=0;i<40;i++) tick?.();
    assert.equal(callback, rendering === 'new'); assert.equal(alert, !['new', 'cancelled', 'fast-back'].includes(rendering));
  }
});
test('a rejected discovery follow never changes history or acknowledges an already open destination', () => {
  for (const alreadyOpen of [false, true]) {
    let click: ((event: object) => void) | undefined; let pushes = 0; let accepted = 0; let preparations = 0; let timers = 0;
    const url = 'https://music.apple.com/ar/song/example/222';
    const value = new URL(alreadyOpen ? url : 'https://music.apple.com/ar/album/example/111');
    const link = { addEventListener: (_type: string, fn: (event: object) => void) => { click = fn; } };
    const context = { URL, Map, link, url, location: value, title: 'Example',
      accepted: () => { accepted++; }, prepare: () => { preparations++; return false; },
      document: { getElementById: () => null, querySelector: () => ({ isConnected: true }), querySelectorAll: () => [{ textContent: 'Example', closest: () => null }] },
      history: { pushState: () => { pushes++; } }, dispatchEvent: () => {}, PopStateEvent: class {},
      setInterval: () => { timers++; return 1; }, clearInterval: () => { timers--; }, addEventListener: () => {}, removeEventListener: () => {} };
    new vm.Script(`${musicLinkFunctionScript}\nmusicLink(link,url,title,accepted,prepare);`).runInNewContext(context);
    click?.({ preventDefault: () => {} });
    assert.equal(preparations, 1); assert.equal(pushes, 0); assert.equal(accepted, 0); assert.equal(timers, 0);
  }
});
