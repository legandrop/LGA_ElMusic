import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths, visibleBounds, shouldRegisterInstallation } from '../src/paths';

const windows = { platform: 'win32' as const, packaged: true, executable: 'C:\\Apps\\ElMusic\\ElMusic.exe',
  appData: 'C:\\Users\\QA\\AppData\\Roaming', repo: 'C:\\Dev\\ElMusic' };

test('Windows heavy profile stays beside installed executable; preferences are small AppData files', () => {
  const result = resolvePaths(windows);
  assert.equal(result.heavy, 'C:\\Apps\\ElMusic\\data');
  assert.equal(result.preferences, 'C:\\Users\\QA\\AppData\\Roaming\\LGA\\ElMusic');
  assert.equal(result.crashDumps, 'C:\\Apps\\ElMusic\\data\\crashes');
});

test('development is determined by packaged state, not directory name', () => {
  assert.equal(resolvePaths({ ...windows, executable: 'C:\\Builds\\Apps\\ElMusic.exe' }).heavy, 'C:\\Builds\\Apps\\data');
  assert.equal(resolvePaths({ ...windows, packaged: false }).heavy, 'C:\\Dev\\ElMusic\\.local\\browser');
});

test('Mac writes outside the application bundle', () => {
  const result = resolvePaths({ platform: 'darwin', packaged: true, executable: '/Applications/LGA El Music.app/Contents/MacOS/ElMusic',
    appData: '/Users/qa/Library/Application Support', repo: '/Users/qa/repo' });
  assert.equal(result.heavy, '/Users/qa/Library/Application Support/ElMusic/browser');
  assert.equal(result.registry, '/Users/qa/Library/Application Support/LGA/ElMusic.json');
});

test('QA isolates all profile data and preferences inside its own case directory', () => {
  const result = resolvePaths({ ...windows, qaOut: 'C:\\Dev\\ElMusic\\.qa\\case-1' });
  assert.equal(result.heavy, 'C:\\Dev\\ElMusic\\.qa\\case-1\\browser');
  assert.equal(result.preferences, 'C:\\Dev\\ElMusic\\.qa\\case-1\\preferences');
  for (const qaOut of ['C:\\temp\\case', 'C:\\Dev\\ElMusic\\.qa', 'C:\\Dev\\ElMusic\\.qa\\..\\escape',
    'C:\\Dev\\ElMusic\\.qa2\\case', 'relative', 'C:relative']) {
    assert.throws(() => resolvePaths({ ...windows, qaOut }), /QA_OUTPUT_OUTSIDE_REPO/);
  }
});

test('missing monitors restore geometry to a visible default', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.deepEqual(visibleBounds({ x: 5000, y: 0, width: 1280, height: 800 }, displays), { width: 1280, height: 800 });
  assert.deepEqual(visibleBounds({ x: 100, y: 50, width: 1280, height: 800 }, displays), { x: 100, y: 50, width: 1280, height: 800 });
  assert.deepEqual(visibleBounds({ width: NaN, height: 800 }, displays), { width: 1280, height: 840 });
});

test('prototype markers suppress registry writes in legacy and sealed Mac layouts without relying on QA mode', () => {
  const fixtures = path.resolve(process.env.LGA_TEST_RESOURCES || '.qa', 'registry-guard');
  mkdirSync(fixtures, { recursive: true });
  const install = mkdtempSync(path.join(fixtures, 'prototype-'));
  const resources = path.join(install, 'Contents', 'Resources');
  mkdirSync(resources, { recursive: true });
  try {
    assert.equal(shouldRegisterInstallation(true, false, install, resources), true);
    assert.equal(shouldRegisterInstallation(false, false, install, resources), false);
    assert.equal(shouldRegisterInstallation(true, true, install, resources), false);
    const legacy = path.join(install, '.lga-staging');
    writeFileSync(legacy, 'UNVERIFIED');
    assert.equal(shouldRegisterInstallation(true, false, install, resources), false);
    unlinkSync(legacy);
    writeFileSync(path.join(resources, '.lga-staging'), 'UNVERIFIED');
    assert.equal(shouldRegisterInstallation(true, false, install, resources), false);
  } finally { rmSync(install, { recursive: true }); }
});
