import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyShuffleScript, readShuffle, readShuffleScript, saveShuffle } from '../src/playback-prefs';

test('el modo shuffle se guarda como un booleano propio y no pisa un archivo ajeno', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-playback-'));
  try {
    assert.equal(readShuffle(folder), false);
    saveShuffle(folder, true); assert.equal(readShuffle(folder), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'playback.json'), 'utf8')), { shuffle: true });
    saveShuffle(folder, false); assert.equal(readShuffle(folder), false);
    fs.writeFileSync(path.join(folder, 'playback.json'), '{"shuffle":true,"token":"x"}');
    assert.throws(() => readShuffle(folder), /INVALID/); assert.throws(() => saveShuffle(folder, false), /INVALID/);
    assert.equal(fs.readFileSync(path.join(folder, 'playback.json'), 'utf8'), '{"shuffle":true,"token":"x"}');
    assert.equal(fs.readdirSync(folder).length, 1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('sólo lee y escribe shuffleMode del MusicKit de la página oficial', () => {
  const frame = {};
  const root: { dataset: Record<string, string> } = { dataset: {} };
  const page = (hostname: string, music?: Record<string, unknown>) => vm.createContext({ top: frame, self: frame, URL, document: { documentElement: root },
    location: { href: `https://${hostname}/library/playlist/p.x`, protocol: 'https:', hostname, port: '' },
    MusicKit: music ? { getInstance: () => music } : undefined });
  const music = { shuffleMode: 0 };
  assert.equal(vm.runInContext(readShuffleScript, page('music.apple.com', music)), false);
  assert.equal(vm.runInContext(applyShuffleScript(true), page('music.apple.com', music)), true); assert.equal(music.shuffleMode, 1);
  assert.equal(vm.runInContext(readShuffleScript, page('music.apple.com', music)), true);
  assert.equal(vm.runInContext(applyShuffleScript(true), page('evil.test', music)), null);
  assert.equal(vm.runInContext(readShuffleScript, page('music.apple.com')), null);
  // Una cola de Related apaga el shuffle a propósito: no se lee como cambio del usuario.
  root.dataset.elMusicRecommendationQueueBusy = 't';
  assert.equal(vm.runInContext(readShuffleScript, page('music.apple.com', music)), 'related');
});
