import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelCacheLimits, labelFresh, readLabelCache, saveLabelCache } from '../src/label-cache';
import type { CachedLabel } from '../src/label-cache';

const day = 24 * 60 * 60 * 1000;

test('la caché de sellos se guarda y se lee: vencen los viejos y los «sin dato» antes', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'el-music-labels-'));
  try {
    const file = path.join(folder, 'label-cache.json'), now = Date.UTC(2026, 9, 18);
    assert.equal(readLabelCache(file, now).size, 0);
    const cache = new Map<string, CachedLabel>([
      ['1', { name: 'Warp', link: { kind: 'name', name: 'Warp' }, saved: now - day }],
      ['n:Rejjie Snow\u0001PEACE', { name: 'Honeymoon', saved: now - 10 * day }],
      ['2', { name: 'Ninja Tune', link: { kind: 'mb', id: 'dc940013-b8a8-4362-a465-291b2fa0d3b5', name: 'Ninja Tune' }, saved: now }],
      ['3', { name: '', saved: now - 8 * day }], ['4', { name: '', saved: now - day }], ['5', { name: 'Old', saved: now - 91 * day }],
      ['6', { name: '℗ Holder', saved: now - 8 * day }], ['7', { name: '℗ Holder', saved: now - day }]]);
    saveLabelCache(file, cache);
    // Un «℗ …» provisional vence como un «sin dato», para que MusicBrainz pueda confirmarlo más adelante.
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1', 'n:Rejjie Snow\u0001PEACE', '2', '4', '7']);
    // Un temporal de un guardado cortado se borra al leer.
    fs.writeFileSync(file + '.0f8fad5b-d9cb-469f-a165-70867728950e.tmp', 'x'); fs.writeFileSync(path.join(folder, 'other.tmp'), 'x');
    readLabelCache(file, now); assert.deepEqual(fs.readdirSync(folder).sort(), ['label-cache.json', 'other.tmp']);
    fs.rmSync(path.join(folder, 'other.tmp'));
    assert.deepEqual(readLabelCache(file, now).get('2')?.link, { kind: 'mb', id: 'dc940013-b8a8-4362-a465-291b2fa0d3b5', name: 'Ninja Tune' });
    assert.equal(labelFresh({ name: 'x', saved: now + day }, now), false);
    assert.deepEqual(fs.readdirSync(folder), ['label-cache.json']);
    // Un archivo que no es el nuestro se rechaza entero y no se reinterpreta.
    for (const content of ['{"version":1,"entries":[["1","x",null,1]],"token":"x"}', '{"version":1,"entries":[["../x","x",null,1]]}',
      '{"version":1,"entries":[["1","x",{"kind":"apple","url":"https://evil.test","name":"x"},1]]}', '{"version":8,"entries":[]}', 'no json', '{"version":6,"entries":[["1","x",null,1]]}',
      '{"version":4,"entries":[["1","x",null,1,"2"]]}', '{"version":4,"entries":[["n:AB","x",null,1,"x"]]}', '{"version":3,"entries":[["n:AB","x",null,1,"2"]]}']) {
      fs.writeFileSync(file, content); assert.throws(() => readLabelCache(file, now), /INVALID/);
    }
    // Archivos de las versiones 1 y 2 (0.1.33–0.1.35) conservan sus sellos y descartan sus «sin dato» (tope 429 mal leído).
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [['1', 'Warp', null, now], ['n:A\u0001B', '', null, now]] }));
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1']);
    fs.writeFileSync(file, JSON.stringify({ version: 2, entries: [['1', 'Warp', null, now], ['n:A0001B', '', null, now]] }));
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1']);
    fs.writeFileSync(file, JSON.stringify({ version: 3, entries: [['1', 'Warp', null, now], ['n:A0001B', '', null, now]] }));
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1', 'n:A0001B']);
    // Versión 4 (0.1.39): las claves por nombre guardan el ID de catálogo del álbum; las claves por ID no lo repiten.
    saveLabelCache(file, new Map<string, CachedLabel>([['n:Le Vasco\u0001Feu', { name: 'Nowadays Records', saved: now, id: '1600000000' }],
      ['8', { name: 'Warp', saved: now, id: '9' }]]));
    // Versión 5 (0.1.40): siete campos fijos, con fecha de lanzamiento y género; los archivos v4 se siguen leyendo.
    // Versión 6 (0.1.41): misma forma; un archivo v5 conserva sus sellos y descarta sus «sin dato» (matcher sin acentos/apóstrofos/«EP»).
    // Versión 7 (0.1.53): un octavo campo con los artistas del álbum, o null si todavía no se pidieron.
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 7, entries: [['n:Le Vasco\u0001Feu', 'Nowadays Records', null, now, '1600000000', '', '', null], ['8', 'Warp', null, now, null, '', '', null]] });
    assert.equal(readLabelCache(file, now).get('n:Le Vasco\u0001Feu')?.id, '1600000000');
    fs.writeFileSync(file, JSON.stringify({ version: 5, entries: [['1', 'Warp', null, now, null, '2020-01-01', 'Pop'], ['n:A\u0001B', '', null, now, null, '', '']] }));
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1']);
    fs.writeFileSync(file, JSON.stringify({ version: 6, entries: [['1', 'Warp', null, now, null, '2020-01-01', 'Pop'], ['n:A\u0001B', '', null, now, null, '', '']] }));
    assert.deepEqual([...readLabelCache(file, now).keys()], ['1', 'n:A\u0001B']);
    fs.writeFileSync(file, JSON.stringify({ version: 4, entries: [['n:Le Vasco\u0001Feu', 'Nowadays Records', null, now, '1600000000'], ['8', 'Warp', null, now]] }));
    assert.equal(readLabelCache(file, now).get('n:Le Vasco\u0001Feu')?.id, '1600000000');
    saveLabelCache(file, new Map<string, CachedLabel>([['9', { name: 'Warp', saved: now, released: '2024-05-17', genre: 'Electronic' }], ['10', { name: '', saved: now, released: 'ayer' }]]));
    assert.deepEqual(readLabelCache(file, now).get('9'), { name: 'Warp', saved: now, released: '2024-05-17', genre: 'Electronic' });
    assert.deepEqual(readLabelCache(file, now).get('10'), { name: '', saved: now });
    for (const content of ['{"version":5,"entries":[["1","x",null,1,null,"24-01","g"]]}', '{"version":5,"entries":[["1","x",null,1,"2","",""]]}', '{"version":5,"entries":[["1","x",null,1,null,""]]}']) {
      fs.writeFileSync(file, content); assert.throws(() => readLabelCache(file, now), /INVALID/);
    }
    // Artistas: se guardan y se leen; una v6 los deja sin pedir (undefined); un octavo campo malformado rechaza el archivo.
    saveLabelCache(file, new Map<string, CachedLabel>([['11', { name: 'Brainfeeder', saved: now, artists: [['Lapalux', '412778295']] }], ['12', { name: 'Warp', saved: now, artists: [] }]]));
    assert.deepEqual(readLabelCache(file, now).get('11')?.artists, [['Lapalux', '412778295']]); assert.deepEqual(readLabelCache(file, now).get('12')?.artists, []);
    fs.writeFileSync(file, JSON.stringify({ version: 6, entries: [['1', 'Warp', null, now, null, '2020-01-01', 'Pop']] }));
    assert.equal(readLabelCache(file, now).get('1')?.artists, undefined);
    for (const content of ['{"version":7,"entries":[["1","x",null,1,null,"","",[["A","x"]]]]}', '{"version":7,"entries":[["1","x",null,1,null,"",""]]}', '{"version":7,"entries":[["1","x",null,1,null,"","","A"]]}']) {
      fs.writeFileSync(file, content); assert.throws(() => readLabelCache(file, now), /INVALID/);
    }
    fs.writeFileSync(file, Buffer.alloc(labelCacheLimits.bytes + 1)); assert.throws(() => readLabelCache(file, now), /INVALID/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
