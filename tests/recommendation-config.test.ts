import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readLastFmKey, saveLastFmKey } from '../src/recommendation-config';
import { trustedRecommendationSettingsRequest } from '../src/policy';

test('optional key uses a private atomic preference, clears explicitly and preserves foreign files', () => {
  const fixtures = process.env.LGA_TEST_RESOURCES || path.join(process.cwd(), '.qa');
  fs.mkdirSync(fixtures, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtures, 'recommendation-key-test-'));
  const file = path.join(root, 'recommendations.json'), key = 'a'.repeat(32);
  try {
    assert.equal(readLastFmKey(root), undefined);
    assert.throws(() => saveLastFmKey(root, 'wrong'), /KEY_INVALID/); assert.equal(fs.existsSync(file), false);
    saveLastFmKey(root, key); assert.equal(readLastFmKey(root), key);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ['recommendations.json']);
    saveLastFmKey(root, ''); assert.equal(readLastFmKey(root), undefined);
    for (const foreign of ['{"otherApp":true}', 'invalid', 'x'.repeat(4097)]) {
      fs.writeFileSync(file, foreign);
      assert.throws(() => saveLastFmKey(root, key), /CONFIG_INVALID/);
      assert.equal(fs.readFileSync(file, 'utf8'), foreign);
    }
    fs.unlinkSync(file); const target = path.join(root, 'foreign-target'); fs.mkdirSync(target);
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'file');
    assert.throws(() => saveLastFmKey(root, key), /CONFIG_INVALID/);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('key IPC is confined to the exact local settings main frame and closed arguments', () => {
  const url = 'file:///app/ui/index.html?state=recommendation-settings', key = 'a'.repeat(32);
  const trusted = (args: unknown[], action: 'set-key' | 'open-setup' | 'close' = 'set-key', frame = url, main = true, sender = 1, expected = url): boolean =>
    trustedRecommendationSettingsRequest(sender, main, frame, 1, expected, args, action);
  assert.equal(trusted([key]), true); assert.equal(trusted(['']), true); assert.equal(trusted([], 'open-setup'), true);
  for (const args of [[], [key, key], ['secret'], [{}], ['https://evil.test']]) assert.equal(trusted(args), false);
  assert.equal(trusted([key], 'open-setup'), false);
  assert.equal(trusted([], 'close'), true); assert.equal(trusted([key], 'close'), false);
  assert.equal(trusted([], 'close', url, false), false); assert.equal(trusted([], 'close', url, true, 2), false);
  assert.equal(trusted([key], 'set-key', url, false), false); assert.equal(trusted([key], 'set-key', url, true, 2), false);
  for (const page of ['https://music.apple.com/ar/new', 'file:///app/ui/index.html?state=about', `${url}#extra`, `${url}&extra=yes`]) {
    assert.equal(trusted([key], 'set-key', page, true, 1, page), false);
  }
});
