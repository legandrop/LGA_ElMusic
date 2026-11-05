import { copyFile, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { root, metadata, readManifest, inventory, digest, inside } from './package-integrity.mjs';

const stage = join(root, `release/staging-win-x64-evs-candidate-${metadata.version}`);
const source = join(root, 'release/staging-win-x64');
const signature = 'LGA_El_Music.exe.sig';
const factoryAlias = 'electron.exe.sig';
const factoryAliasHash = '872d0b99762a872f96e13d8c7dcc41ea90d4ef4b7daae592ba1c2c3f5e2a3e3f';
const action = process.argv[2];
if (!['prepare', 'sign', 'verify'].includes(action) || process.platform !== 'win32') {
  throw new Error('Uso en Windows: node scripts/sign-win.mjs prepare|sign|verify');
}

function strictInventory(actual, expected, requireSignature = false) {
  for (const [name, record] of Object.entries(expected)) {
    if (record.link || JSON.stringify(actual[name]) !== JSON.stringify(record)) {
      throw new Error(`Distribución modificada: ${name}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected) && name !== signature) throw new Error(`Archivo inesperado: ${name}`);
  }
  if (requireSignature && (!actual[signature]?.sha256 || !actual[signature].size)) {
    throw new Error('Falta firma EVS exacta.');
  }
}

function immutableFiles(manifest) {
  const alias = manifest.files[factoryAlias];
  if (alias && (alias.sha256 !== factoryAliasHash || alias.size !== 1467)) {
    throw new Error('Alias de fábrica ECS distinto al auditado; revisar antes de firmar.');
  }
  return Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== factoryAlias));
}

if (action === 'prepare') {
  const manifest = await readManifest(source);
  if (manifest.platform !== 'win' || manifest.arch !== 'x64' || manifest.packageDirectory !== 'win-unpacked') {
    throw new Error('Distribución Windows incompatible.');
  }
  const expected = immutableFiles(manifest);
  await mkdir(stage);
  const dest = join(stage, 'win-unpacked');
  await mkdir(dest);
  for (const [name, record] of Object.entries(manifest.files)) {
    const from = join(source, 'win-unpacked', name);
    const to = join(dest, name);
    if (!inside(dest, to) || record.link || name === 'data' || name.startsWith('data/') || (name.endsWith('.sig') && name !== factoryAlias)) {
      throw new Error('Manifest de origen no es una distribución sin perfil/firma.');
    }
    if (await digest(from) !== record.sha256) throw new Error(`Origen modificado: ${name}`);
    if (name === factoryAlias) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  strictInventory(await inventory(dest), expected);
  await writeFile(join(stage, 'stage-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ prepared: true, version: metadata.version, files: Object.keys(expected).length, factoryAliasOmitted: Boolean(manifest.files[factoryAlias]), profileCopied: false }));
} else {
  const manifest = await readManifest(stage);
  const candidate = join(stage, 'win-unpacked');
  const expected = immutableFiles(manifest);
  strictInventory(await inventory(candidate), expected);
  if (action === 'sign' && !(await stat(join(root, '.local/evs/config.json')).catch(() => null))?.isFile()) {
    throw new Error('Primero iniciar sesión humana con tools/evs-account-win.ps1.');
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(join(root, 'tools/python_runtime/windows/python.exe'),
      ['-I', '-B', join(root, 'tools/evs-win.py'), action, candidate],
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', bytes => { if (output.length < 4096) output += bytes.toString(); });
    // Los errores crudos del cliente nunca se publican ni se guardan.
    child.stderr.resume();
    child.on('error', () => reject(new Error('No se pudo iniciar el runtime EVS local.')));
    child.on('close', code => {
      try {
        const parsed = JSON.parse(output);
        resolve({ code, ok: parsed.ok === true, production: parsed.production === true, streaming: parsed.streaming === true });
      } catch { reject(new Error('Resultado EVS no verificable; revisar configuración local.')); }
    });
  });
  const actual = await inventory(candidate);
  strictInventory(actual, expected, result.ok);
  const evidence = { version: metadata.version, ecs: manifest.ecs, ...result,
    immutableFiles: Object.keys(expected).length, factoryAliasOmitted: Boolean(manifest.files[factoryAlias]), signature: actual[signature] ?? null,
    appleAudioConfirmed: false, recordedAt: new Date().toISOString() };
  await writeFile(join(stage, 'evs-verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence));
  if (result.code !== 0 || !result.ok || !result.production || !result.streaming) process.exitCode = 1;
}
