import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, readFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const ecsVersion = '44.5.1+wvcus';
export const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

export function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export async function digest(path) {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}

export async function inventory(directory) {
  const files = {};
  async function visit(current, prefix = '') {
    for (const entry of (await readdir(current)).sort()) {
      const path = join(current, entry);
      const name = prefix ? `${prefix}/${entry}` : entry;
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (!inside(directory, resolve(dirname(path), target))) throw new Error(`Package symlink escapes root: ${name}`);
        files[name] = { link: target };
      }
      else if (info.isDirectory()) await visit(path, name);
      else if (info.isFile()) files[name] = { sha256: await digest(path), size: info.size };
      else throw new Error(`Unsupported package entry: ${name}`);
    }
  }
  await visit(directory);
  return files;
}

export async function verifyInventory(directory, expected) {
  const actual = await inventory(directory);
  for (const [name, record] of Object.entries(expected)) {
    if (!(name in actual)) throw new Error(`Missing package entry: ${name}`);
    const mutable = name.endsWith('.sig');
    if (!mutable && JSON.stringify(actual[name]) !== JSON.stringify(record)) {
      throw new Error(`Package integrity mismatch: ${name}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected) && !name.endsWith('.sig')) {
      throw new Error(`Unexpected package entry: ${name}`);
    }
  }
  return actual;
}

export async function readManifest(stage) {
  if (!inside(join(root, 'release'), stage)) throw new Error('Stage must be inside this repository release directory.');
  const manifest = JSON.parse(await readFile(join(stage, 'stage-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.ecs !== ecsVersion || manifest.version !== metadata.version) {
    throw new Error('Stage is incompatible with current app/runtime version; stage again.');
  }
  if (!inside(stage, join(stage, manifest.packageDirectory))) throw new Error('Invalid package directory.');
  return manifest;
}
