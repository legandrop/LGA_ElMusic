import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { root, inventory, verifyInventory, inside } from './package-integrity.mjs';

const fixtures = process.env.LGA_TEST_RESOURCES || join(root, '.qa', 'packaging');
await mkdir(fixtures, { recursive: true });
test('staged integrity rejects changed, missing and injected app files', async () => {
  const directory = await mkdtemp(join(fixtures, 'integrity-'));
  assert.ok(inside(fixtures, directory));
  try {
    const app = join(directory, 'app.asar');
    await writeFile(app, 'original app');
    const expected = await inventory(directory);
    await verifyInventory(directory, expected);
    await writeFile(app, 'changed app');
    await assert.rejects(verifyInventory(directory, expected), /integrity mismatch/);
    await writeFile(app, 'original app');
    await writeFile(join(directory, 'unwanted.js'), 'injected');
    await assert.rejects(verifyInventory(directory, expected), /Unexpected package entry/);
    await unlink(join(directory, 'unwanted.js'));
    await unlink(app);
    await assert.rejects(verifyInventory(directory, expected), /Missing package entry/);
  } finally { await rm(directory, { recursive: true }); }
});

test('staged integrity rejects a modified native binary, including its Mach-O header', async () => {
  const directory = await mkdtemp(join(fixtures, 'native-integrity-'));
  assert.ok(inside(fixtures, directory));
  try {
    const native = join(directory, 'native-helper');
    const binary = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]);
    await writeFile(native, binary);
    const expected = await inventory(directory);
    await verifyInventory(directory, expected);
    binary[7] = 255;
    await writeFile(native, binary);
    await assert.rejects(verifyInventory(directory, expected), /integrity mismatch/);
    binary[0] = 0;
    await writeFile(native, binary);
    await assert.rejects(verifyInventory(directory, expected), /integrity mismatch/);
  } finally { await rm(directory, { recursive: true }); }
});
