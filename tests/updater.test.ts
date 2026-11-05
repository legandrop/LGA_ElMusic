import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { networkRetry } from '../src/network-retry';
import { displayVersion } from '../src/app-version';
import {
  Updater, compareVersions, downloadSetup, findNotes, findUpdate, helperScript, notesText, parseWhatsNew, readUpdatePrefs,
  saveUpdatePrefs, sweepUpdates, updateBlockReason, updateSource, updateToastScript, writeHelper,
} from '../src/updater';
import type { ReleaseAsset, UpdateAnswer, UpdaterHost } from '../src/updater';

networkRetry.delayMs = 1;
const temp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'elmusic-updater-'));
const sha = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
const asset = (name: string, tag: string, data: Buffer | string) => ({ tag, name, digest: `sha256:${sha(data)}`, size: Buffer.byteLength(data) });
const manifestWith = (assetLatest: unknown[], extra: Record<string, unknown> = {}) =>
  ({ schemaVersion: 1, products: { [updateSource.product]: { tag: 'v0.92', assets: [], assetLatest, ...extra } } });
const notesJson = (versions: unknown[]) => JSON.stringify({ schemaVersion: 1, product: updateSource.product, name: 'El Music', versions });
function respond(body: Buffer | string, init: { status?: number; url?: string; headers?: Record<string, string> } = {}): Response {
  const response = new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: init.status ?? 200, headers: init.headers });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
}

test('versions compare by number, with missing parts as zero', () => {
  assert.equal(compareVersions('0.91', '0.90'), 1);
  assert.equal(compareVersions('0.1.9', '0.1.10'), -1);
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
});

test('the minor compares as a three-digit decimal, like the other LGA apps', () => {
  assert.equal(compareVersions('0.91', '0.1.60'), 1);
  assert.equal(compareVersions('0.91', '0.910'), 0);
  assert.equal(compareVersions('0.99', '0.991'), -1);
  assert.equal(compareVersions('0.92', '0.915'), 1);
  assert.equal(compareVersions('1.00', '0.99'), 1);
});

test('the version shown is X.YY while package.json keeps X.YY.0', () => {
  assert.equal(displayVersion('0.91.0'), '0.91');
  assert.equal(displayVersion('1.0.0'), '1.00');
  assert.equal(displayVersion('0.5.0'), '0.05');
  assert.equal(displayVersion('0.1.60'), '0.1.60');
});

test('the offer is the highest installer in the manifest, only if newer and with a matching tag and digest', () => {
  const setup60 = asset('LGA_ElMusic_Setup_v0.91.exe', 'v0.91', 'a');
  const setup61 = asset('LGA_ElMusic_Setup_v0.92.exe', 'v0.92', 'bb');
  const notes = asset('whats_new.json', 'v0.92', '{}');
  const zip = asset('LGA-El-Music-0.90-win-x64.zip', 'v0.90', 'zip');
  const manifest = manifestWith([zip, setup60, setup61, notes]);
  const offer = findUpdate(manifest, '0.90');
  assert.equal(offer?.version, '0.92');
  assert.equal(offer?.setup.sha256, sha('bb'));
  assert.equal(offer?.notes?.name, 'whats_new.json');
  assert.equal(findUpdate(manifest, '0.92'), undefined);
  assert.equal(findUpdate(manifest, '1.00'), undefined);
  // Un tag que no coincide con el nombre, un digest ausente o un manifiesto de otro esquema no ofrecen nada.
  assert.equal(findUpdate(manifestWith([{ ...setup61, tag: 'v0.91' }]), '0.90')?.version, undefined);
  assert.equal(findUpdate(manifestWith([{ ...setup61, digest: undefined }]), '0.90'), undefined);
  assert.equal(findUpdate({ ...manifest, schemaVersion: 2 }, '0.90'), undefined);
  assert.equal(findUpdate(manifestWith([{ ...setup61, name: 'LGA_ElMusic_Setup_v0.92.exe.bat' }]), '0.90'), undefined);
  // Sin assetLatest, los assets del último tag.
  const tagged = { schemaVersion: 1, products: { [updateSource.product]: { tag: 'v0.92', assets: [{ name: setup61.name, digest: setup61.digest, size: setup61.size }] } } };
  assert.equal(findUpdate(tagged, '0.91')?.version, '0.92');
  assert.equal(findNotes(manifest)?.tag, 'v0.92');
});

test('release notes keep this platform, known kinds and plain text, newest first, within the range', () => {
  const raw = JSON.parse(notesJson([
    { version: '0.91', items: [{ kind: 'new', text: 'Installer\nand updates' }, { kind: 'fixed', text: 'Mac only', platform: ['mac'] }, { kind: 'odd', text: 'x' }] },
    { version: '0.92', items: [{ kind: 'improved', text: 'Faster' }] },
    { version: '0.90', items: [{ kind: 'fixed', text: 'Old' }] },
  ]));
  const versions = parseWhatsNew(raw, 'win');
  assert.deepEqual(versions.map(entry => entry.version), ['0.92', '0.91', '0.90']);
  assert.deepEqual(versions[1].items, [{ kind: 'new', text: 'Installer and updates' }]);
  assert.equal(notesText(versions, '0.90', '0.92'), '0.92\n•  Improved: Faster\n\n0.91\n•  New: Installer and updates');
  assert.equal(notesText(versions, '0.91', '0.91'), '');
  assert.match(notesText(versions, undefined, '0.92', 3), /More in Help › What’s New\.$/);
  assert.deepEqual(parseWhatsNew({ ...raw, product: 'someone/else' }, 'win'), []);
  assert.equal(parseWhatsNew({ ...raw, product: undefined }, 'win').length, 3);
});

test('preferences default to checking and ignore damaged values', () => {
  const directory = temp();
  try {
    assert.deepEqual(readUpdatePrefs(directory), { autoCheck: true });
    saveUpdatePrefs(directory, { autoCheck: false, skipped: '0.92', snoozeUntil: 5, seen: '0.91' });
    assert.deepEqual(readUpdatePrefs(directory), { autoCheck: false, skipped: '0.92', snoozeUntil: 5, seen: '0.91' });
    fs.writeFileSync(path.join(directory, 'updates.json'), '{"autoCheck":"no","skipped":"../x"}');
    assert.deepEqual(readUpdatePrefs(directory), { autoCheck: true });
    fs.writeFileSync(path.join(directory, 'updates.json'), 'not json');
    assert.deepEqual(readUpdatePrefs(directory), { autoCheck: true });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('only a Windows copy installed with the installer updates itself', () => {
  const dir = 'D:\\Apps\\ElMusic';
  const files = (names: string[]) => (file: string) => names.some(name => file === path.join(dir, name));
  assert.equal(updateBlockReason({ platform: 'win32', packaged: true, qa: false, installDir: dir, exists: files(['unins000.exe']) }), undefined);
  assert.equal(updateBlockReason({ platform: 'win32', packaged: true, qa: false, installDir: dir, exists: files(['unins000.exe', '.lga-staging']) }), 'staging');
  assert.equal(updateBlockReason({ platform: 'win32', packaged: true, qa: false, installDir: dir, exists: files([]) }), 'not-installed');
  assert.equal(updateBlockReason({ platform: 'win32', packaged: false, qa: false, installDir: dir, exists: files(['unins000.exe']) }), 'development');
  assert.equal(updateBlockReason({ platform: 'win32', packaged: true, qa: true, installDir: dir, exists: files(['unins000.exe']) }), 'qa');
  assert.equal(updateBlockReason({ platform: 'darwin', packaged: true, qa: false, installDir: dir, exists: files(['unins000.exe']) }), 'platform');
});

test('the installer downloads to a .part file, checks size and hash, and keeps its exact name', async () => {
  const directory = temp();
  try {
    const data = crypto.randomBytes(300_000);
    const setup = asset('LGA_ElMusic_Setup_v0.92.exe', 'v0.92', data) as unknown as Record<string, unknown>;
    const release: ReleaseAsset = { tag: 'v0.92', name: 'LGA_ElMusic_Setup_v0.92.exe', sha256: sha(data), size: data.length };
    const urls: string[] = []; const progress: number[] = [];
    const fetchOk = (async (url: string) => { urls.push(url); return respond(data, { url: 'https://release-assets.githubusercontent.com/x', headers: { 'content-length': String(data.length) } }); }) as unknown as typeof fetch;
    const file = await downloadSetup(release, directory, { fetch: fetchOk, onProgress: received => progress.push(received) });
    assert.equal(file, path.join(directory, 'LGA_ElMusic_Setup_v0.92.exe'));
    assert.equal(sha(fs.readFileSync(file)), sha(data));
    assert.deepEqual(urls, ['https://github.com/legandrop/LGA_ElMusic/releases/download/v0.92/LGA_ElMusic_Setup_v0.92.exe']);
    assert.equal(progress.at(-1), data.length);
    assert.equal(setup.size, data.length);
    // Uno ya bajado y correcto no se descarga de nuevo.
    let calls = 0;
    await downloadSetup(release, directory, { fetch: (async () => { calls++; return respond(data); }) as unknown as typeof fetch });
    assert.equal(calls, 0);
    fs.rmSync(file);
    // Hash distinto, host ajeno o tamaño distinto: error y ningún archivo.
    await assert.rejects(downloadSetup({ ...release, sha256: sha('other') }, directory, { fetch: fetchOk }), /UPDATE_HASH/);
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => respond('', { status: 302, headers: { location: 'https://evil.example/x' } })) as unknown as typeof fetch }), /UPDATE_HOST/);
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => respond('', { status: 302, headers: { location: 'http://release-assets.githubusercontent.com/x' } })) as unknown as typeof fetch }), /UPDATE_HOST/);
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => respond(data.subarray(1))) as unknown as typeof fetch }), /UPDATE_SIZE/);
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => respond('', { status: 404 })) as unknown as typeof fetch }), /UPDATE_HTTP/);
    await assert.rejects(downloadSetup({ ...release, name: 'evil.exe' }, directory, { fetch: fetchOk }), /UPDATE_FORMAT/);
    assert.deepEqual(fs.readdirSync(directory), []);
    // Una falla de red se reintenta.
    let attempts = 0;
    const flaky = (async () => { attempts++; if (attempts < 3) throw new TypeError('fetch failed'); return respond(data); }) as unknown as typeof fetch;
    await downloadSetup(release, directory, { fetch: flaky });
    assert.equal(attempts, 3);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the startup sweep removes only El Music installers, helpers and partial downloads', () => {
  const directory = temp();
  try {
    for (const name of ['LGA_ElMusic_Setup_v0.91.exe', 'LGA_ElMusic_Setup_v0.92.exe.part', 'LGA_ElMusic_Update_Helper_1730000000000.ps1',
      'update-helper.log', 'other.exe', 'LGA_FrameRev_Setup_v1.0.exe']) fs.writeFileSync(path.join(directory, name), 'x');
    assert.equal(sweepUpdates(directory), 3);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['LGA_FrameRev_Setup_v1.0.exe', 'other.exe', 'update-helper.log']);
    // El registro del script se empieza de nuevo cuando pasa de 64 KB.
    fs.writeFileSync(path.join(directory, 'update-helper.log'), Buffer.alloc(70 * 1024, 120));
    assert.equal(sweepUpdates(directory), 1);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['LGA_FrameRev_Setup_v1.0.exe', 'other.exe']);
    assert.equal(sweepUpdates(path.join(directory, 'missing')), 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the helper script is ASCII, waits for this install folder and opens the installer on it', () => {
  const directory = temp();
  try {
    const script = helperScript();
    assert.equal(/[^\x00-\x7f]/.test(script), false);
    assert.match(script, /\$_.Name -ieq 'LGA_El_Music\.exe'/);
    assert.match(script, /'\/DIR="' \+ \$AppDir \+ '"'/);
    assert.doesNotMatch(script, /VERYSILENT|Stop-Process/);
    assert.ok(script.includes('Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256'));
    assert.ok(script.indexOf('Get-FileHash') < script.indexOf('Start-Process -FilePath $InstallerPath'));
    const file = writeHelper(directory, 42);
    assert.equal(path.basename(file), 'LGA_ElMusic_Update_Helper_42.ps1');
    assert.match(fs.readFileSync(file, 'latin1'), /\r\n/);
    if (process.platform === 'win32') {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const parse = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); $e.Count`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.equal(parse.stdout.trim(), '0');
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the download notice only runs in the Apple Music top frame and builds its text without HTML', () => {
  const script = updateToastScript({ text: '<b>Downloading</b>', detail: 'x', working: true });
  assert.match(script, /location\.hostname !== 'music\.apple\.com'/);
  assert.match(script, /createTextNode\(state\.text\)/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(updateToastScript(null), /const state = null/);
});

function fakeHost(directory: string, overrides: Partial<UpdaterHost> & { files?: Record<string, Buffer | string> } = {}) {
  const calls = { asked: [] as string[], told: [] as string[], launched: [] as string[][], progress: 0, whatsNew: [] as string[] };
  const files = overrides.files ?? {};
  let answer: UpdateAnswer = 'cancel';
  const host: UpdaterHost = {
    version: '0.91', preferences: path.join(directory, 'prefs'), downloads: path.join(directory, 'updates'), installDir: directory, platform: 'win',
    log: () => {}, ask: async offer => { calls.asked.push(offer.version); return answer; },
    tell: async message => { calls.told.push(message); }, progress: () => { calls.progress++; },
    launch: async (setup, helper, _log, sha256) => { calls.launched.push([setup, helper, sha256]); return true; },
    whatsNew: async (title, text) => { calls.whatsNew.push(`${title}|${text}`); },
    fetch: (async (url: string) => {
      const name = url === updateSource.manifest ? 'manifest' : decodeURIComponent(url.split('/').pop()!);
      return name in files ? respond(files[name]) : respond('', { status: 404 });
    }) as unknown as typeof fetch,
    now: () => 1_000_000, random: () => 0.5, ...overrides,
  };
  fs.mkdirSync(host.preferences, { recursive: true });
  return { host, calls, answer: (value: UpdateAnswer) => { answer = value; } };
}

test('an automatic check asks once; skip and later are remembered, a manual check always asks', async () => {
  const directory = temp();
  try {
    const setup = Buffer.from('installer bytes');
    const notes = notesJson([{ version: '0.92', items: [{ kind: 'new', text: 'Updates' }] }]);
    const manifest = JSON.stringify(manifestWith([asset('LGA_ElMusic_Setup_v0.92.exe', 'v0.92', setup), asset('whats_new.json', 'v0.92', notes)]));
    const { host, calls, answer } = fakeHost(directory, { files: { manifest, 'whats_new.json': notes, 'LGA_ElMusic_Setup_v0.92.exe': setup } });
    const updater = new Updater(host);
    answer('skip');
    await updater.check(false);
    assert.deepEqual(calls.asked, ['0.92']);
    assert.equal(readUpdatePrefs(host.preferences).skipped, '0.92');
    await updater.check(false);
    assert.deepEqual(calls.asked, ['0.92']);
    answer('later');
    await updater.check(true);
    assert.deepEqual(calls.asked, ['0.92', '0.92']);
    assert.equal(readUpdatePrefs(host.preferences).snoozeUntil, 1_000_000 + 24 * 3600_000);
    // Las notas quedaron guardadas para mostrarlas después de actualizar.
    assert.equal(parseWhatsNew(JSON.parse(fs.readFileSync(path.join(host.preferences, 'whats-new.json'), 'utf8')), 'win')[0].version, '0.92');
    answer('update');
    await updater.check(true);
    assert.equal(calls.launched.length, 1);
    const [setupFile, helperFile, digest] = calls.launched[0];
    assert.equal(digest, sha(setup));
    // Elegir actualizar deja sin efecto el «después» y el «saltear» anteriores.
    assert.equal(readUpdatePrefs(host.preferences).snoozeUntil, undefined);
    assert.equal(readUpdatePrefs(host.preferences).skipped, undefined);
    assert.equal(fs.readFileSync(setupFile, 'utf8'), 'installer bytes');
    assert.match(path.basename(helperFile), /^LGA_ElMusic_Update_Helper_\d+\.ps1$/);
    assert.ok(calls.progress >= 2);
    assert.deepEqual(calls.told, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a manual check tells when there is nothing new, when it fails and when this copy cannot update', async () => {
  const directory = temp();
  try {
    const manifest = JSON.stringify(manifestWith([asset('LGA_ElMusic_Setup_v0.91.exe', 'v0.91', 'a')]));
    const upToDate = fakeHost(directory, { files: { manifest } });
    await new Updater(upToDate.host).check(true);
    assert.deepEqual(upToDate.calls.told, ['up-to-date']);
    const offline = fakeHost(directory, { fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
    await new Updater(offline.host).check(true);
    assert.deepEqual(offline.calls.told, ['check-failed']);
    await new Updater(offline.host).check(false);
    assert.deepEqual(offline.calls.told, ['check-failed']);
    const staging = fakeHost(directory, { blocked: 'staging' });
    await new Updater(staging.host).check(true);
    assert.deepEqual(staging.calls.told, ['blocked']);
    const broken = fakeHost(directory, { files: { manifest: JSON.stringify(manifestWith([asset('LGA_ElMusic_Setup_v0.92.exe', 'v0.92', 'good')])),
      'LGA_ElMusic_Setup_v0.92.exe': 'tampered' } });
    broken.answer('update');
    await new Updater(broken.host).check(true);
    assert.deepEqual(broken.calls.told, ['download-failed']);
    assert.equal(broken.calls.launched.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('after an update the new notes show once; a fresh install shows nothing', async () => {
  const directory = temp();
  try {
    const first = fakeHost(directory);
    await new Updater(first.host).afterStart();
    assert.deepEqual(first.calls.whatsNew, []);
    assert.equal(readUpdatePrefs(first.host.preferences).seen, '0.91');
    fs.writeFileSync(path.join(first.host.preferences, 'whats-new.json'), notesJson([
      { version: '0.92', items: [{ kind: 'new', text: 'Installer' }] }, { version: '0.91', items: [{ kind: 'fixed', text: 'Old' }] }]));
    const next = fakeHost(directory, { version: '0.92' });
    await new Updater(next.host).afterStart();
    assert.deepEqual(next.calls.whatsNew, ['What’s new in El Music 0.92|0.92\n•  New: Installer']);
    await new Updater(next.host).afterStart();
    assert.equal(next.calls.whatsNew.length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('each server gets its own three network retries, and busy or down servers are retried too', async () => {
  const directory = temp();
  try {
    const data = crypto.randomBytes(1000);
    const release: ReleaseAsset = { tag: 'v0.92', name: 'LGA_ElMusic_Setup_v0.92.exe', sha256: sha(data), size: data.length };
    // github.com falla dos veces y su almacenamiento de releases tres: con un presupuesto compartido de 3, no llegaría.
    const hits = { github: 0, assets: 0 };
    const twoServers = (async (url: string) => {
      if (new URL(url).hostname === 'github.com') {
        if (++hits.github <= 2) throw new TypeError('fetch failed');
        return respond('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/x?sig=1' } });
      }
      if (++hits.assets <= 3) throw new TypeError('fetch failed');
      return respond(data);
    }) as unknown as typeof fetch;
    await downloadSetup(release, directory, { fetch: twoServers });
    // Cada reintento vuelve a empezar por github.com: 2 fallos + 4 redirecciones.
    assert.deepEqual(hits, { github: 6, assets: 4 });
    fs.rmSync(path.join(directory, release.name));
    // Un cuarto fallo seguido del mismo servidor ya no se reintenta.
    let down = 0;
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => { down++; throw new TypeError('fetch failed'); }) as unknown as typeof fetch }), /UPDATE_NETWORK/);
    assert.equal(down, 4);
    // 503 y 429 se reintentan; 404 no.
    let busy = 0;
    await downloadSetup(release, directory, { fetch: (async () => (++busy === 1 ? respond('', { status: 503 }) : busy === 2 ? respond('', { status: 429 }) : respond(data))) as unknown as typeof fetch });
    assert.equal(busy, 3);
    fs.rmSync(path.join(directory, release.name));
    let missing = 0;
    await assert.rejects(downloadSetup(release, directory, { fetch: (async () => { missing++; return respond('', { status: 404 }); }) as unknown as typeof fetch }), /UPDATE_HTTP/);
    assert.equal(missing, 1);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('if the update script cannot start, the app stays open and says so', async () => {
  const directory = temp();
  try {
    const setup = Buffer.from('installer bytes');
    const manifest = JSON.stringify(manifestWith([asset('LGA_ElMusic_Setup_v0.92.exe', 'v0.92', setup)]));
    const { host, calls, answer } = fakeHost(directory, { files: { manifest, 'LGA_ElMusic_Setup_v0.92.exe': setup },
      launch: async () => false });
    answer('update');
    await new Updater(host).check(true);
    assert.deepEqual(calls.told, ['install-failed']);
    // El script que no arrancó no queda en la carpeta.
    assert.deepEqual(fs.readdirSync(host.downloads).filter(name => name.endsWith('.ps1')), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the update script does not open an installer that changed after the download', { skip: process.platform !== 'win32' }, () => {
  const directory = temp();
  try {
    const appDir = path.join(directory, 'El Music app');
    fs.mkdirSync(appDir, { recursive: true });
    const installer = path.join(appDir, 'LGA_ElMusic_Setup_v9.9.9.exe');
    fs.writeFileSync(installer, 'changed bytes');
    const helper = writeHelper(appDir, 7);
    const logFile = path.join(appDir, 'update-helper.log');
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-InstallerPath', installer, '-AppDir', appDir, '-LogPath', logFile, '-Sha256', sha('original bytes')],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(run.status, 4);
    assert.equal(fs.existsSync(installer), false);
    assert.equal(fs.existsSync(helper), false);
    assert.match(fs.readFileSync(logFile, 'utf8'), /El instalador cambio despues de la descarga/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
