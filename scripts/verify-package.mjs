import { resolve, join } from 'node:path';
import { readManifest, verifyInventory } from './package-integrity.mjs';

const stage = process.argv[2];
if (!stage) throw new Error('Usage: node scripts/verify-package.mjs release/staging-win-x64');
const directory = resolve(stage);
const manifest = await readManifest(directory);
await verifyInventory(join(directory, manifest.packageDirectory), manifest.files);
console.log(JSON.stringify({ integrity: 'verified', signatureContentsExcluded: true, ecs: manifest.ecs, version: manifest.version, drm: 'UNVERIFIED', stage: directory }, null, 2));
