import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { artistColorScript, defaultArtistColor, readArtistColor, saveArtistColor } from '../src/appearance';
import { trustedRecommendationSettingsRequest } from '../src/policy';

test('artist color uses a private atomic preference, a strict hex value and preserves foreign files', () => {
  const fixtures = process.env.LGA_TEST_RESOURCES || path.join(process.cwd(), '.qa');
  fs.mkdirSync(fixtures, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtures, 'appearance-test-'));
  const file = path.join(root, 'appearance.json');
  try {
    assert.equal(readArtistColor(root), defaultArtistColor);
    for (const wrong of ['purple', '#abc', '#12345g', 'url(x)', '#1234567', 7]) assert.throws(() => saveArtistColor(root, wrong), /COLOR_INVALID/);
    assert.equal(fs.existsSync(file), false);
    saveArtistColor(root, '#A0B1C2'); assert.equal(readArtistColor(root), '#a0b1c2');
    assert.deepEqual(fs.readdirSync(root), ['appearance.json']);
    for (const foreign of ['{"otherApp":true}', '{"artistColor":"red"}', 'invalid', 'x'.repeat(4097)]) {
      fs.writeFileSync(file, foreign);
      assert.throws(() => readArtistColor(root), /CONFIG_INVALID/);
      assert.throws(() => saveArtistColor(root, '#ffffff'), /CONFIG_INVALID/);
      assert.equal(fs.readFileSync(file, 'utf8'), foreign);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artist color script sets only the CSS variable on the exact music origin', () => {
  assert.throws(() => artistColorScript('red;}body{display:none'), /COLOR_INVALID/);
  const run = (href: string): string | undefined => {
    const values = new Map<string, string>();
    const url = new URL(href);
    const self = {};
    vm.runInNewContext(artistColorScript('#B48CFF'), { URL, top: self, self, location: { href, protocol: url.protocol, hostname: url.hostname, port: url.port },
      document: { documentElement: { style: { setProperty: (name: string, value: string) => values.set(name, value) } } } });
    return values.get('--el-music-artist-color');
  };
  assert.equal(run('https://music.apple.com/ar/new'), '#b48cff');
  for (const href of ['https://music.apple.com.evil.test/ar/new', 'https://user@music.apple.com/ar/new', 'https://music.apple.com:444/ar/new', 'http://music.apple.com/ar/new'])
    assert.equal(run(href), undefined);
});

test('settings accepts only one strict hex color for the artist color action', () => {
  const url = 'file:///app/ui/index.html?state=recommendation-settings';
  const allowed = (args: unknown[]): boolean => trustedRecommendationSettingsRequest(1, true, url, 1, url, args, 'set-artist-color');
  assert.equal(allowed(['#b48cff']), true);
  for (const args of [[], ['#b48cf'], ['b48cff'], ['#b48cff', 'x'], [0xb48cff], ['#b48cff;']]) assert.equal(allowed(args), false);
  assert.equal(trustedRecommendationSettingsRequest(1, true, 'file:///app/ui/index.html?state=about', 1, 'file:///app/ui/index.html?state=about', ['#b48cff'], 'set-artist-color'), false);
});
