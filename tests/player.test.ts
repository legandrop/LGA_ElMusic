import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { playerSampleScript, playerSample } from '../src/player';
import { recommendationRequest } from '../src/record-recommendations';

test('current LCD seed comes from original marquee text, independently of the viewed album', () => {
  class Button { textContent = 'Sirens'; disabled = false; }
  const button = new Button();
  const fragments = ['Nicolas Jaar', '—', 'Sirens'].map(textContent => ({ textContent,
    querySelector: () => textContent === 'Sirens' ? button : null }));
  const secondary = { querySelectorAll: () => fragments };
  const metadata = { querySelector: (selector: string) => {
    assert.match(selector, /:not\(.marquee-line__scrolling-text-chunk--copy\)/);
    return selector.startsWith('.marquee--primary ') ? { textContent: ' No ' } : secondary;
  } };
  const frame = {}, url = 'https://music.apple.com/ar/album/other/999';
  const context = { top: frame, self: frame, URL, HTMLButtonElement: Button,
    location: { href: url, pathname: '/ar/album/other/999', protocol: 'https:', hostname: 'music.apple.com', port: '' },
    document: { querySelector: () => metadata, getElementById: () => ({ dataset: { recommendationRequest: 'open/e/track' } }),
      querySelectorAll: (selector: string) => selector === '.navigation a[href]' ? navigation.map(href => ({ getAttribute: () => href })) : [] } };
  let navigation = ['https://music.apple.com/us/home', 'https://evil.test/br/home'];
  const observed = playerSample(new vm.Script(playerSampleScript).runInNewContext(context));
  assert.deepEqual(observed?.seed, { title: 'No', artist: 'Nicolas Jaar', album: 'Sirens', country: 'ar' });
  // En la biblioteca no hay país en la URL: se toma de los enlaces públicos de la barra lateral (Related en todas partes).
  context.location = { href: 'https://music.apple.com/library/playlist/p.X', pathname: '/library/playlist/p.X', protocol: 'https:', hostname: 'music.apple.com', port: '' };
  assert.equal(playerSample(new vm.Script(playerSampleScript).runInNewContext(context))?.seed?.country, 'us');
  navigation = ['https://evil.test/br/home', '/library/recently-added'];
  assert.equal(playerSample(new vm.Script(playerSampleScript).runInNewContext(context))?.seed, undefined);
  context.location = { href: url, pathname: '/ar/album/other/999', protocol: 'https:', hostname: 'music.apple.com', port: '' };
  assert.equal(observed?.albumUrl, url); assert.equal(observed?.albumButtonAvailable, true);
  button.disabled = true;
  assert.equal(playerSample(new vm.Script(playerSampleScript).runInNewContext(context))?.albumButtonAvailable, false);
  context.self = {};
  assert.equal(new vm.Script(playerSampleScript).runInNewContext(context), null);
});
test('untrusted seeds and commands are bounded and cannot supply URLs or stale actions', () => {
  assert.equal(playerSample({ seed: { title: 'x'.repeat(241), artist: 'A', album: '', country: 'ar' } })?.seed, undefined);
  assert.equal(playerSample({ seed: { title: 'No', artist: 'A', album: '', country: 'ar/evil' } })?.seed, undefined);
  assert.deepEqual(recommendationRequest('open/e/artist', 'e'), { action: 'open', mode: 'artist' });
  assert.deepEqual(recommendationRequest('close/e', 'e'), { action: 'close' });
  for (const value of ['open/stale/track', 'open/e/track/extra', 'open/e/https://evil.test', 'close/e/extra', 'set-key/e/secret']) {
    assert.equal(recommendationRequest(value, 'e'), undefined);
  }
});
