import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import type { WebContents } from 'electron';
import { installAuthColorScheme } from '../src/auth-theme';

function fixture(url: string): { contents: WebContents; events: EventEmitter; styles: string[] } {
  const styles: string[] = [];
  const nodes = new Map<string, unknown>();
  const document = {
    getElementById: (id: string) => nodes.get(id),
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: (style: { id: string; textContent: string }) => {
      nodes.set(style.id, style); styles.push(style.textContent);
    } },
  };
  const events = new EventEmitter();
  const frame = Object.assign(new EventEmitter(), { url,
    executeJavaScript: async (code: string) => runInNewContext(code, { document }) });
  const contents = Object.assign(events, { mainFrame: frame }) as unknown as WebContents;
  installAuthColorScheme(contents, () => assert.fail('Fallo de inyección'));
  return { contents, events, styles };
}

test('auth roots follow light/dark while Music keeps its original root and repeated readiness adds no duplicate style', () => {
  for (const host of ['idmsa.apple.com', 'accounts.apple.com', 'appleid.apple.com']) {
    const view = fixture(`https://${host}/auth`);
    view.events.emit('dom-ready');
    view.events.emit('dom-ready');
    assert.equal(view.styles.length, 1);
    assert.match(view.styles[0], /:root \{ color-scheme: light dark !important; \}/);
    assert.match(view.styles[0], /color-scheme: inherit !important/);
    assert.doesNotMatch(view.styles[0], /background|input|password/);
    assert.match(view.styles[0], /scrollbar-color: #777 #202020/);
  }
  const music = fixture('https://music.apple.com/ar/new');
  music.events.emit('dom-ready');
  assert.equal(music.styles.length, 1);
  assert.doesNotMatch(music.styles[0], /:root/);
});

test('only Commerce documents enlarge the normal modal and preserve flexible, alert and narrow variants', () => {
  for (const url of ['https://music.apple.com/includes/commerce', 'https://music.apple.com/includes/commerce/navigator']) {
    const view = fixture(url); view.events.emit('dom-ready');
    assert.match(view.styles[0], /max-height: min\(720px, calc\(100vh - 32px\)\)/);
    assert.match(view.styles[0], /:not\(\.cc-modal__modal--flexible-size\):not\(\.cc-modal__modal--alert\):not\(\.cc-modal__modal--narrow\)/);
    assert.doesNotMatch(view.styles[0], /overflow|ck-placeholder/);
  }
  for (const url of ['https://music.apple.com/ar/new', 'https://music.apple.com/includes/commerceevil', 'https://idmsa.apple.com/includes/commerce/']) {
    const view = fixture(url); view.events.emit('dom-ready');
    assert.doesNotMatch(view.styles[0], /max-height/);
    assert.match(view.styles[0], /forced-colors: active/);
  }
});

test('auth style never executes for lookalike hosts, credentials, ports, local documents or unrelated Apple hosts', () => {
  for (const url of ['https://idmsa.apple.com.evil.test/', 'https://apple.com/', 'https://idmsa.apple.com:8443/',
    'https://user@idmsa.apple.com/', 'http://idmsa.apple.com/', 'file:///C:/private', 'about:blank',
    'https://idmsa.apple.com./', 'https://castlabs.github.io/']) {
    const view = fixture(url);
    view.events.emit('dom-ready');
    assert.deepEqual(view.styles, [], url);
  }
});

test('new auth frames receive the same origin guard on their own readiness', () => {
  const music = fixture('https://music.apple.com/');
  const child = fixture('https://accounts.apple.com/auth');
  music.events.emit('frame-created', {}, { frame: child.contents.mainFrame });
  (child.contents.mainFrame as unknown as EventEmitter).emit('dom-ready');
  assert.equal(child.styles.length, 1);
  assert.match(child.styles[0], /:root/);
  assert.deepEqual(music.styles, []);
});
