import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'dist-tests', 'tests');
const files = (await readdir(directory)).filter(name => name.endsWith('.test.js')).sort().map(name => join(directory, name));
if (!files.length) throw new Error('No compiled tests found; compile tsconfig.test.json first.');
files.push(join(root, 'scripts', 'integrity-selftest.mjs'));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
