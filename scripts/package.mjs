import { createRequire } from 'node:module';
import { readFile, writeFile, access, mkdir, mkdtemp, cp, copyFile, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { release as osRelease } from 'node:os';
import { root, ecsVersion, metadata, inventory, readManifest, verifyInventory } from './package-integrity.mjs';

const require = createRequire(import.meta.url);
const [platform, action] = process.argv.slice(2);
if (!['win', 'mac'].includes(platform) || !['stage', 'prototype', 'finalize'].includes(action)) {
  throw new Error('Usage: node scripts/package.mjs win|mac stage|prototype|finalize');
}
if (action === 'finalize') throw new Error('Final release preparation is pending: finalize is disabled until real playback validation and an audited signing pipeline are completed. Do not modify stage manifests to bypass this gate.');
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use repository Node 24 LTS.');
if ((platform === 'win' && process.platform !== 'win32') || (platform === 'mac' && process.platform !== 'darwin')) {
  throw new Error('Packages must be built and validated on their target OS.');
}
const arch = platform === 'win' ? 'x64' : process.arch;
if (platform === 'win' && process.arch !== 'x64') throw new Error('Windows v1 requires x64.');
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported architecture.');
if (platform === 'mac' && Number(osRelease().split('.')[0]) < 22) throw new Error('macOS 13 or later is required.');
process.env.ELECTRON_CACHE = join(root, '.local', 'ecs-cache');
process.env.ELECTRON_BUILDER_CACHE = join(root, '.local', 'builder-cache');
process.env.APP_BUILDER_TMP_DIR = join(root, '.local', 'builder-tmp');
process.env.EVS_CONFIG_FILE = join(root, '.local', 'evs', 'config.json');
process.env.EVS_CACHE_FILE = join(root, '.local', 'evs', 'cache.json');
process.env.PYTHONPYCACHEPREFIX = join(root, '.local', 'python-cache');
await mkdir(process.env.APP_BUILDER_TMP_DIR, { recursive: true });
// electron-builder deja sus icon-compile-* en os.tmpdir(): se fijan dentro del repo y se borran al terminar.
process.env.TMPDIR = process.env.APP_BUILDER_TMP_DIR;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME']) delete process.env[name];
const { build, Platform, Arch } = require('electron-builder');
const config = require('../electron-builder.cjs');
const stage = join(root, 'release', `staging-${platform}-${arch}`);
const targets = (platform === 'win' ? Platform.WINDOWS : Platform.MAC).createTarget('dir', arch === 'x64' ? Arch.x64 : Arch.arm64);

// electron-builder compila el .icon sin --standalone-icon-behavior all y el icns de respaldo queda
// en 256 px. Assets.car sigue siendo el icono principal; este icns completo cubre macOS < 26.
async function fullIcns(target) {
  const work = await mkdtemp(join(process.env.APP_BUILDER_TMP_DIR, 'icns-'));
  try {
    await cp(join(root, config.mac.icon), join(work, 'AppIcon.icon'), { recursive: true });
    await mkdir(join(work, 'out'));
    execFileSync('xcrun', ['actool', join(work, 'AppIcon.icon'), '--compile', join(work, 'out'), '--platform', 'macosx',
      '--minimum-deployment-target', '26.0', '--app-icon', 'AppIcon', '--standalone-icon-behavior', 'all',
      '--output-partial-info-plist', join(work, 'partial.plist')], { stdio: 'ignore' });
    await copyFile(join(work, 'out', 'AppIcon.icns'), target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (action === 'stage') {
  try { await access(stage); throw new Error(`Stage already exists: ${stage}. Preserve evidence, then remove or move that directory explicitly before rebuilding.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const electronRoot = dirname(require.resolve('electron/package.json'));
  const installed = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'));
  const electronDist = join(electronRoot, 'dist');
  const version = (await readFile(join(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '');
  if (installed.version !== ecsVersion || version !== ecsVersion) throw new Error(`Expected Castlabs ECS ${ecsVersion}; got ${installed.version}/${version}.`);
  if (installed.repository !== 'https://github.com/castlabs/electron-releases' || !(await readFile(join(electronRoot, 'electron.d.ts'), 'utf8')).includes('const components: Components')) {
    throw new Error('Installed Electron dependency is not the expected Castlabs distribution.');
  }
  // Mac usa el .icon de Icon Composer (Assets.car + icns); Windows el .ico. Ruta tomada de electron-builder.cjs.
  const ownIcon = await access(join(root, config[platform].icon)).then(() => true, () => false);
  const platformConfig = { ...config[platform] };
  if (!ownIcon) delete platformConfig.icon;
  await mkdir(stage, { recursive: true });
  await build({ projectDir: root, publish: 'never', targets, config: { ...config, [platform]: platformConfig, electronDist, directories: { ...config.directories, output: stage } } });
  const directory = platform === 'win' ? 'win-unpacked' : `mac${arch === 'arm64' ? '-arm64' : ''}`;
  const markerRoot = platform === 'win' ? join(stage, directory) : join(stage, directory, `${config.productName}.app`);
  const markerDirectory = platform === 'mac' ? join(markerRoot, 'Contents', 'Resources') : markerRoot;
  if (platform === 'mac' && ownIcon) await fullIcns(join(markerDirectory, 'icon.icns'));
  for (const name of await readdir(process.env.APP_BUILDER_TMP_DIR)) {
    if (name.startsWith('icon-compile-')) await rm(join(process.env.APP_BUILDER_TMP_DIR, name), { recursive: true, force: true });
  }
  await writeFile(join(markerDirectory, '.lga-staging'), 'UNVERIFIED prototype: do not register as an installed application.\n');
  const files = await inventory(join(stage, directory));
  // No downloaded Widevine, profile or QA data may enter a distributable.
  if (Object.keys(files).some(name => /(?:^|\/)(?:WidevineCdm|widevinecdm|data|sessionData)(?:\/|$)/i.test(name))) {
    throw new Error('Unexpected profile or Widevine CDM in staged package.');
  }
  await writeFile(join(stage, 'stage-manifest.json'), JSON.stringify({ schema: 1, version: metadata.version, ecs: ecsVersion, platform, arch, ownIcon, packageDirectory: directory, status: 'UNVERIFIED', created: new Date().toISOString(), files }, null, 2));
  console.log(`Staged UNVERIFIED prototype: ${join(stage, directory)}. DRM and Apple Music playback require real validation.`);
} else {
  const manifest = await readManifest(stage);
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Stage platform/architecture mismatch.');
  const packaged = join(stage, manifest.packageDirectory);
  await verifyInventory(packaged, manifest.files);
  const label = '-UNVERIFIED';
  const output = join(root, 'release', 'prototypes');
  const before = await inventory(packaged);
  const prepackaged = platform === 'mac' ? join(packaged, `${config.productName}.app`) : packaged;
  const platformConfig = { ...config[platform] };
  if (!manifest.ownIcon) delete platformConfig.icon;
  await build({ projectDir: root, publish: 'never', targets: (platform === 'win' ? Platform.WINDOWS : Platform.MAC).createTarget(platform === 'win' ? 'zip' : 'dmg', arch === 'x64' ? Arch.x64 : Arch.arm64), prepackaged, config: { ...config, [platform]: platformConfig, artifactName: `LGA-El-Music-${metadata.version}-${platform}-${arch}${label}.\${ext}`, directories: { ...config.directories, output } } });
  await verifyInventory(packaged, before);
  await writeFile(join(output, `LGA-El-Music-${metadata.version}-${platform}-${arch}${label}.verification.json`), JSON.stringify({ schema: 1, version: metadata.version, ecs: ecsVersion, platform, arch, status: 'UNVERIFIED', playback: 'REQUIRES_HUMAN_VALIDATION', files: before }, null, 2));
  console.log(`${action} artifact created in ${output}. Apple Music playback is not certified by this command.`);
}
