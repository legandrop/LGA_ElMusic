// Firma candidata Mac sobre ruta fija (.qa/mac-signing), sin copias por versión.
// Mismo procedimiento auditado de 0.1.2-0.1.14: candidato aislado, EVS streaming,
// codesign ad hoc con @electron/osx-sign, DMG desde el .app firmado, extracción read-only.
// Pasos: prepare | codesign | verify | dmg | install  (EVS lo corre scripts/evs-mac.py entre pasos)
import { createRequire } from 'node:module';
import { readFile, writeFile, access, rm, mkdir, lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { inventory, digest, readManifest, verifyInventory, metadata } from './package-integrity.mjs';

// Raíz del checkout: la carpeta que contiene scripts/.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const qa = join(root, '.qa/mac-signing');
const stage = join(root, 'release/staging-mac-arm64');
const base = join(qa, 'candidate/mac-arm64');
const app = join(base, 'LGA El Music.app');
const installed = join(qa, 'installed-prototype');
const output = join(root, 'release/prototypes');
const version = metadata.version;
const name = `LGA-El-Music-${version}-mac-arm64-EVS-UNVERIFIED`;
const require = createRequire(join(root, 'package.json'));
const plist = require('plist');
const exists = path => access(path).then(() => true, () => false);
const json = async file => JSON.parse(await readFile(join(qa, file), 'utf8'));
const save = (file, data) => writeFile(join(qa, file), JSON.stringify(data, null, 2) + '\n');
const evsOk = r => r.exitCode === 0 && r.validSignature && !r.developmentOnly;
process.env.TMPDIR = process.env.TMP = process.env.TEMP = join(root, '.local/tmp');

const step = process.argv[2];
if (step === 'prepare') {
  const manifest = await readManifest(stage);
  if (manifest.version !== version || manifest.platform !== 'mac' || manifest.arch !== 'arm64' || !manifest.ownIcon) throw Error('Stage 0.1.x mac-arm64 con icono propio requerido');
  await verifyInventory(join(stage, manifest.packageDirectory), manifest.files);
  // Fuente == paquete: cada módulo de dist/ idéntico dentro del ASAR.
  const asar = require('@electron/asar');
  const archive = join(stage, manifest.packageDirectory, 'LGA El Music.app/Contents/Resources/app.asar');
  const dist = [];
  async function walk(dir, prefix) { for (const e of (await readdir(dir)).sort()) { const p = join(dir, e); if ((await lstat(p)).isDirectory()) await walk(p, `${prefix}/${e}`); else dist.push(`${prefix}/${e}`); } }
  await walk(join(root, 'dist'), 'dist');
  const differ = dist.filter(f => Buffer.compare(asar.extractFile(archive, f), require('node:fs').readFileSync(join(root, f))) !== 0);
  if (differ.length) throw Error(`dist distinto del ASAR: ${differ.join(', ')}`);
  await rm(qa, { recursive: true, force: true });
  await mkdir(join(qa, 'candidate'), { recursive: true });
  execFileSync('/usr/bin/ditto', [join(stage, manifest.packageDirectory), base]);
  const original = await inventory(base);
  if (JSON.stringify(original) !== JSON.stringify(manifest.files)) throw Error('Candidato distinto del stage');
  await save('original-inventory.json', original);
  // Objetivos canónicos: Mach-O y bundles app/framework/xpc, sin seguir enlaces.
  const targets = [];
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      if (/\.(app|framework|xpc)$/.test(path)) targets.push(path);
    } else if (info.isFile() && execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' }).includes('Mach-O')) targets.push(path);
  }
  await visit(app);
  await save('sign-targets.json', targets);
  const result = { version, distModules: dist.length, distEqualsAsar: true, entries: Object.keys(original).length, targets: targets.length };
  await save('source-integrity.json', result);
  console.log(JSON.stringify(result));
} else if (step === 'codesign') {
  if (!evsOk(await json('evs-pre-codesign.json'))) throw Error('Verificación EVS de producción requerida');
  const targets = new Set(await json('sign-targets.json'));
  const { signAsync } = require('@electron/osx-sign');
  await signAsync({
    app, platform: 'darwin', identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true,
    ignore: file => !targets.has(file),
    optionsForFile: () => ({ timestamp: 'none', hardenedRuntime: true, entitlements: join(root, 'resources/entitlements.mac.plist') }),
  });
  const result = { success: true, tool: '@electron/osx-sign', version: '1.3.3', identity: 'ad-hoc', hardenedRuntime: true, strictVerify: true, provisioningProfile: false, notarized: false };
  await save('codesign.json', result);
  console.log(JSON.stringify(result));
} else if (step === 'verify') {
  const original = await json('original-inventory.json');
  const targets = await json('sign-targets.json');
  const signed = await inventory(base);
  const own = plist.parse(await readFile(join(root, 'resources/entitlements.mac.plist'), 'utf8'));
  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  const executables = new Set();
  for (const target of targets) {
    const file = (await lstat(target)).isFile();
    if (file) executables.add(relative(base, target));
    const kind = file ? spawnSync('/usr/bin/file', ['-b', target], { encoding: 'utf8' }).stdout : 'bundle';
    const processCode = target.endsWith('.app') || kind.includes('executable');
    const detail = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', target], { encoding: 'utf8' });
    const ent = spawnSync('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', target], { encoding: 'utf8' });
    const permissions = ent.stdout.trim() ? plist.parse(ent.stdout) : {};
    const ok = spawnSync('/usr/bin/codesign', ['--verify', '--strict', target]).status === 0;
    if (detail.status !== 0 || !detail.stderr.includes('Signature=adhoc') || !/flags=.*runtime/.test(detail.stderr) || !same(permissions, processCode ? own : {}) || !ok) throw Error(`Firma incorrecta: ${relative(base, target)}`);
  }
  const sig = 'LGA El Music.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Electron Framework.sig';
  for (const n of Object.keys(original)) if (!(n in signed)) throw Error(`Falta ${n}`);
  const changes = Object.keys(signed).filter(n => JSON.stringify(signed[n]) !== JSON.stringify(original[n]));
  for (const n of changes) if (!executables.has(n) && n !== sig && !n.endsWith('/_CodeSignature/CodeResources')) throw Error(`Cambio ajeno a la firma: ${n}`);
  const strict = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (strict.status !== 0) throw Error('strict/deep falló');
  await save('signed-inventory.json', signed);
  const result = { version, original: Object.keys(original).length, signed: Object.keys(signed).length, targets: targets.length, changes: changes.length, onlySignatureRelatedChanges: true, strictDeepExit: 0, marker: 'Contents/Resources/.lga-staging', playback: 'UNVERIFIED', notarized: false };
  await save('signed-integrity.json', result);
  console.log(JSON.stringify(result));
} else if (step === 'dmg') {
  if (!evsOk(await json('evs-post-codesign.json'))) throw Error('Verificación EVS posterior requerida');
  const expected = await json('signed-inventory.json');
  if (JSON.stringify(await inventory(base)) !== JSON.stringify(expected)) throw Error('Candidato firmado cambió');
  // Un solo DMG vigente: se reemplaza la carpeta entera.
  await rm(output, { recursive: true, force: true });
  process.env.ELECTRON_CACHE = join(root, '.local/ecs-cache');
  process.env.ELECTRON_BUILDER_CACHE = join(root, '.local/builder-cache');
  process.env.APP_BUILDER_TMP_DIR = join(root, '.local/builder-tmp');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME']) delete process.env[key];
  const { build, Platform, Arch } = require('electron-builder');
  const config = require(join(root, 'electron-builder.cjs'));
  await build({ projectDir: root, publish: 'never', targets: Platform.MAC.createTarget('dmg', Arch.arm64), prepackaged: app, config: { ...config, artifactName: `${name}.\${ext}`, directories: { ...config.directories, output } } });
  if (JSON.stringify(await inventory(base)) !== JSON.stringify(expected)) throw Error('El empaquetador modificó el candidato firmado');
  for (const tmp of [process.env.TMPDIR, process.env.APP_BUILDER_TMP_DIR])
    for (const e of await readdir(tmp)) if (e.startsWith('icon-compile-')) await rm(join(tmp, e), { recursive: true, force: true });
  const artifact = join(output, `${name}.dmg`);
  const result = { version, artifact: relative(root, artifact), sha256: await digest(artifact), entries: Object.keys(expected).length, candidateUnchanged: true, evsProduction: true, macAdhoc: true, notarized: false, playback: 'UNVERIFIED' };
  await save('dmg-created.json', result);
  console.log(JSON.stringify(result));
} else if (step === 'install') {
  const dmg = await json('dmg-created.json');
  const mount = join(qa, 'dmg-mounted');
  await mkdir(mount); await mkdir(installed);
  let device, result;
  try {
    const info = plist.parse(execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-plist', join(root, dmg.artifact)], { encoding: 'utf8', timeout: 30000 }));
    device = info['system-entities'].find(x => x['mount-point'] === mount)?.['dev-entry'];
    if (!device) throw Error('Dispositivo propio no encontrado');
    execFileSync('/usr/bin/ditto', [join(mount, 'LGA El Music.app'), join(installed, 'LGA El Music.app')], { timeout: 60000 });
    if (JSON.stringify(await inventory(installed)) !== JSON.stringify(await json('signed-inventory.json'))) throw Error('Bytes instalados distintos');
    if (spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(installed, 'LGA El Music.app')]).status !== 0) throw Error('Firma instalada inválida');
    if (!(await exists(join(installed, 'LGA El Music.app/Contents/Resources/.lga-staging')))) throw Error('Falta el marcador de prototipo');
    result = { success: true, version, sha256: dmg.sha256, installedIdentical: true, strictDeepExit: 0, markerPreserved: true, readonly: true };
  } finally {
    if (device) { const r = spawnSync('/usr/bin/hdiutil', ['detach', device]); if (r.status !== 0) throw Error('No se pudo desmontar'); }
    await rm(mount, { recursive: true, force: true });
  }
  await save('dmg-result.json', result);
  console.log(JSON.stringify(result));
} else throw Error('Uso: sign.mjs prepare|codesign|verify|dmg|install');
