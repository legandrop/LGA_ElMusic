// Actualizaciones automáticas en Windows.
//
// Mismo contrato que las demás apps LGA: el manifiesto de LGA_Updates (GitHub Pages, sin la API de GitHub) dice cuál es
// el último instalador del release público y su SHA-256. La app lo baja a su carpeta de datos, verifica tamaño y hash,
// deja un script de PowerShell que espera a que la app se cierre y abre el instalador sobre la misma carpeta, y se cierra.
// El instalador muestra su asistente (no se corre en silencio) y vuelve a abrir la app al terminar.
//
// Sólo corre en una instalación hecha con el instalador: su desinstalador al lado del exe y sin el marcador de prototipo.
// En un build, en QA o en una copia suelta no hay una carpeta a la que se pueda instalar con seguridad.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { networkRetry, pauseFor } from './network-retry';
import { writeJsonAtomic } from './paths';

export const updateSource = {
  manifest: 'https://legandrop.github.io/LGA_Updates/versions.json',
  product: 'legandrop/LGA_ElMusic',
  releases: 'https://github.com/legandrop/LGA_ElMusic/releases/download/',
  page: 'https://github.com/legandrop/LGA_ElMusic/releases/latest',
};
// Primer chequeo a los 5 s del arranque; después cada 3 h ± 15 min contra el reloj (un tic cada 5 min sobrevive a la
// suspensión); un chequeo fallido se repite a los 10 min. «Remind me later» calla un día.
export const updateTiming = { firstCheckMs: 5000, intervalMs: 3 * 3600_000, jitterMs: 15 * 60_000, retryMs: 10 * 60_000,
  tickMs: 5 * 60_000, snoozeMs: 24 * 3600_000 };
const limits = { manifest: 4 * 1024 * 1024, notes: 256 * 1024, setup: 400 * 1024 * 1024, requestMs: 20000, stallMs: 60000 };
const setupName = /^LGA_ElMusic_Setup_v(\d+(?:\.\d+){1,3})\.exe$/;
const tagText = /^v\d+(?:\.\d+){1,3}$/;
const versionText = /^\d+(?:\.\d+){1,3}$/;
const digestText = /^sha256:([0-9a-f]{64})$/;
// La descarga sale de github.com y GitHub la redirige a su almacenamiento de releases.
const downloadHosts = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export const helperLog = 'update-helper.log';
export const updateFiles = { setup: setupName, helper: /^LGA_ElMusic_Update_Helper_\d+\.ps1$/, partial: /^LGA_ElMusic_Setup_v\d+(?:\.\d+){1,3}\.exe\.part$/ };

// Regla de versiones de las apps LGA (FM_VersionCompare y build_whats_new de LGA_RepoTools): el minor es un decimal y
// se compara rellenado a tres cifras, así que 0.91 == 0.910, 0.99 < 0.991 y 0.91 > 0.1.60. Lo que sigue al minor son
// enteros y los ceros finales no cuentan.
function versionKey(text: string): number[] {
  const [major = '0', minor = '0', ...rest] = text.split('.');
  const numbers = [Number(major), Number(minor.padEnd(3, '0')), ...rest.map(Number)];
  while (numbers.length > 1 && numbers[numbers.length - 1] === 0) numbers.pop();
  return numbers;
}

export function compareVersions(a: string, b: string): number {
  const left = versionKey(a), right = versionKey(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export interface ReleaseAsset { tag: string; name: string; sha256: string; size: number }
export interface UpdateOffer { version: string; setup: ReleaseAsset; notes?: ReleaseAsset }

function releaseAsset(raw: unknown, fallbackTag: unknown): ReleaseAsset | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  const tag = value.tag ?? fallbackTag, digest = typeof value.digest === 'string' ? digestText.exec(value.digest) : null;
  if (typeof tag !== 'string' || !tagText.test(tag) || typeof value.name !== 'string' || !digest
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) return;
  return { tag, name: value.name, sha256: digest[1], size: value.size };
}

// Los assets del producto: assetLatest (lo último de cada familia de nombres) y, si falta, los del último tag.
function productAssets(manifest: unknown): ReleaseAsset[] {
  if (!manifest || typeof manifest !== 'object') return [];
  const root = manifest as { schemaVersion?: unknown; products?: unknown };
  if (root.schemaVersion !== 1 || !root.products || typeof root.products !== 'object') return [];
  const product = (root.products as Record<string, unknown>)[updateSource.product];
  if (!product || typeof product !== 'object') return [];
  const entry = product as { tag?: unknown; assets?: unknown; assetLatest?: unknown };
  const latest = Array.isArray(entry.assetLatest) ? entry.assetLatest.map(raw => releaseAsset(raw, undefined)) : [];
  const tagged = Array.isArray(entry.assets) ? entry.assets.map(raw => releaseAsset(raw, entry.tag)) : [];
  return [...latest, ...tagged].filter((asset): asset is ReleaseAsset => !!asset);
}

// Las notas más nuevas que publica el manifiesto (whats_new.json del último release que lo trae).
export function findNotes(manifest: unknown): ReleaseAsset | undefined {
  return productAssets(manifest).filter(asset => asset.name === 'whats_new.json' && asset.size <= limits.notes)
    .sort((a, b) => compareVersions(b.tag.slice(1), a.tag.slice(1)))[0];
}

// El instalador de versión más alta, si es más nuevo que la instalada. El nombre y el tag tienen que decir la misma versión.
export function findUpdate(manifest: unknown, current: string): UpdateOffer | undefined {
  let best: UpdateOffer | undefined;
  for (const asset of productAssets(manifest)) {
    const version = setupName.exec(asset.name)?.[1];
    if (!version || asset.tag !== `v${version}` || asset.size > limits.setup) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { version, setup: asset };
  }
  if (!best || !versionText.test(current) || compareVersions(best.version, current) <= 0) return;
  return { ...best, notes: findNotes(manifest) };
}

export type NoteKind = 'new' | 'improved' | 'fixed';
export interface NotesVersion { version: string; items: Array<{ kind: NoteKind; text: string }> }
const noteKinds = new Set<NoteKind>(['new', 'improved', 'fixed']);

// whats_new.json del release: sólo versiones, tipo y texto plano; lo que no es de esta plataforma queda afuera.
export function parseWhatsNew(raw: unknown, platform: 'win' | 'mac'): NotesVersion[] {
  if (!raw || typeof raw !== 'object') return [];
  const root = raw as { schemaVersion?: unknown; product?: unknown; versions?: unknown };
  // Sin `product` vale (el lector de las apps Qt no lo exige); con otro producto, no.
  if (root.schemaVersion !== 1 || (root.product !== undefined && root.product !== updateSource.product) || !Array.isArray(root.versions)) return [];
  const result: NotesVersion[] = [];
  for (const entry of root.versions.slice(0, 60)) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as { version?: unknown; items?: unknown };
    if (typeof value.version !== 'string' || !versionText.test(value.version) || !Array.isArray(value.items)) continue;
    const items: NotesVersion['items'] = [];
    for (const item of value.items.slice(0, 30)) {
      if (!item || typeof item !== 'object') continue;
      const note = item as { kind?: unknown; text?: unknown; platform?: unknown };
      if (typeof note.kind !== 'string' || !noteKinds.has(note.kind as NoteKind) || typeof note.text !== 'string') continue;
      if (Array.isArray(note.platform) && !note.platform.includes(platform)) continue;
      const text = note.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (text) items.push({ kind: note.kind as NoteKind, text });
    }
    if (items.length) result.push({ version: value.version, items });
  }
  return result.sort((a, b) => compareVersions(b.version, a.version));
}

const kindLabel: Record<NoteKind, string> = { new: 'New', improved: 'Improved', fixed: 'Fixed' };
// Texto plano para un cuadro de diálogo: las versiones de (after, upTo], la más nueva primero, con un tope de renglones.
export function notesText(versions: NotesVersion[], after: string | undefined, upTo: string, maxLines = 16): string {
  const lines: string[] = [];
  const chosen = versions.filter(entry => compareVersions(entry.version, upTo) <= 0 && (!after || compareVersions(entry.version, after) > 0));
  let omitted = false;
  for (const entry of chosen) {
    const block = [`${entry.version}`, ...entry.items.map(item => `•  ${kindLabel[item.kind]}: ${item.text}`)];
    for (const line of block) { if (lines.length < maxLines) lines.push(line); else omitted = true; }
    if (lines.length < maxLines) lines.push('');
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (omitted) lines.push('', 'More in Help › What’s New.');
  return lines.join('\n');
}

export interface UpdatePrefs { autoCheck: boolean; snoozeUntil?: number; skipped?: string; seen?: string }
const prefsFile = (directory: string): string => path.join(directory, 'updates.json');
const notesCache = (directory: string): string => path.join(directory, 'whats-new.json');

// updates.json en preferencias: si falta o no se puede leer, vale el valor por defecto (buscar actualizaciones).
export function readUpdatePrefs(directory: string): UpdatePrefs {
  try {
    const file = prefsFile(directory), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return { autoCheck: true };
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const prefs: UpdatePrefs = { autoCheck: value.autoCheck !== false };
    if (typeof value.snoozeUntil === 'number' && Number.isFinite(value.snoozeUntil)) prefs.snoozeUntil = value.snoozeUntil;
    if (typeof value.skipped === 'string' && versionText.test(value.skipped)) prefs.skipped = value.skipped;
    if (typeof value.seen === 'string' && versionText.test(value.seen)) prefs.seen = value.seen;
    return prefs;
  } catch { return { autoCheck: true }; }
}
export function saveUpdatePrefs(directory: string, prefs: UpdatePrefs): void { writeJsonAtomic(prefsFile(directory), prefs); }

export type UpdateBlock = 'platform' | 'development' | 'qa' | 'staging' | 'not-installed';
export function updateBlockReason(options: { platform: NodeJS.Platform; packaged: boolean; qa: boolean; installDir: string;
  exists?: (file: string) => boolean }): UpdateBlock | undefined {
  const exists = options.exists ?? fs.existsSync;
  if (options.platform !== 'win32') return 'platform';
  if (!options.packaged) return 'development';
  if (options.qa) return 'qa';
  if (exists(path.join(options.installDir, '.lga-staging'))) return 'staging';
  if (!exists(path.join(options.installDir, 'unins000.exe'))) return 'not-installed';
}

export class UpdateError extends Error {
  constructor(readonly kind: 'network' | 'http' | 'host' | 'size' | 'hash' | 'format' | 'stalled', readonly server = '', readonly status = 0) {
    super(`UPDATE_${kind.toUpperCase()}`);
  }
}
type Fetch = typeof fetch;
// Fallas que se reintentan: la conexión no se pudo hacer o se cortó, se quedó sin datos, o el servidor respondió que
// está ocupado o caído (408, 429, 5xx), como en las demás apps LGA.
const isNetworkFailure = (error: unknown): boolean => error instanceof UpdateError
  && (error.kind === 'network' || error.kind === 'stalled' || (error.kind === 'http' && (error.status === 408 || error.status === 429 || error.status >= 500)));

// Reintentos por servidor: cada destino tiene sus propios 3, cada 5 s (un firewall por aplicación pregunta por cada uno,
// y la descarga pasa de github.com a su almacenamiento de releases), con un tope de 10 en total. Cada reintento empieza
// desde la primera dirección; un servidor que ya respondió no gasta los suyos.
const retryLimit = 10;
async function withServerRetries<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const used = new Map<string, number>();
  let total = 0;
  for (;;) {
    try { return await run(); } catch (error) {
      if (signal?.aborted || !isNetworkFailure(error)) throw error;
      const server = (error as UpdateError).server, count = used.get(server) ?? 0;
      if (count >= networkRetry.retries || total >= retryLimit) throw error;
      used.set(server, count + 1); total++;
      await pauseFor(networkRetry.delayMs, signal);
    }
  }
}

// Respuesta de un host permitido y por https, con un tope de tiempo sin datos. Las redirecciones se siguen a mano: así
// se valida cada salto y se sabe qué servidor falló.
interface Pending { response: Response; server: string; stall: () => void; done: () => void; failure: (error: unknown) => unknown }
const redirects = new Set([301, 302, 303, 307, 308]);
async function request(url: string, fetchImpl: Fetch, signal: AbortSignal | undefined, allowed: (host: string) => boolean): Promise<Pending> {
  const controller = new AbortController();
  const both = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let stalled = false, server = '';
  let timer = setTimeout(() => { stalled = true; controller.abort(); }, limits.requestMs);
  const stall = (): void => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; controller.abort(); }, limits.stallMs); };
  const done = (): void => clearTimeout(timer);
  // Un corte por falta de datos se trata como falla de red (se reintenta); una cancelación del usuario, no. Una falla
  // de conexión de fetch llega como TypeError.
  const failure = (error: unknown): unknown => signal?.aborted || error instanceof UpdateError ? error
    : stalled ? new UpdateError('stalled', server) : error instanceof TypeError ? new UpdateError('network', server) : error;
  let current = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const target = new URL(current);
      if (target.protocol !== 'https:' || target.port || target.username || target.password || !allowed(target.hostname)) throw new UpdateError('host', target.hostname);
      server = target.hostname;
      const response = await fetchImpl(current, { redirect: 'manual', signal: both });
      const location = response.headers.get('location');
      if (redirects.has(response.status) && location) {
        await response.body?.cancel().catch(() => {});
        current = new URL(location, current).href;
        continue;
      }
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new UpdateError('http', server, response.status); }
      return { response, server, stall, done, failure };
    }
    throw new UpdateError('host', server);
  } catch (error) {
    done();
    throw failure(error);
  }
}

async function readLimited(url: string, limit: number, fetchImpl: Fetch, signal?: AbortSignal, host = 'legandrop.github.io'): Promise<Buffer> {
  return withServerRetries(async () => {
    const { response, stall, done, failure } = await request(url, fetchImpl, signal, name => name === host || downloadHosts.has(name));
    try {
      const chunks: Buffer[] = []; let size = 0;
      const reader = response.body!.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel().catch(() => {}); throw new UpdateError('size'); }
        chunks.push(Buffer.from(value)); stall();
      }
      return Buffer.concat(chunks);
    } catch (error) { throw failure(error); } finally { done(); }
  }, signal);
}

export async function readManifest(fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  const body = await readLimited(updateSource.manifest, limits.manifest, fetchImpl, signal);
  try { return JSON.parse(body.toString('utf8')); } catch { throw new UpdateError('format'); }
}

export function releaseUrl(asset: ReleaseAsset): string {
  return `${updateSource.releases}${encodeURIComponent(asset.tag)}/${encodeURIComponent(asset.name)}`;
}

// Notas del release, verificadas contra el hash del manifiesto.
export async function readNotes(asset: ReleaseAsset, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<unknown> {
  const body = await readLimited(releaseUrl(asset), Math.min(asset.size, limits.notes), fetchImpl, signal, 'github.com');
  if (body.length !== asset.size || crypto.createHash('sha256').update(body).digest('hex') !== asset.sha256) throw new UpdateError('hash');
  try { return JSON.parse(body.toString('utf8')); } catch { throw new UpdateError('format'); }
}

export function cacheNotes(directory: string, notes: unknown): void { writeJsonAtomic(notesCache(directory), notes); }
export function cachedNotes(directory: string): unknown {
  try {
    const file = notesCache(directory), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > limits.notes) return;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return undefined; }
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// Baja el instalador a la carpeta de actualizaciones, a medida que llega y con el hash calculado en el camino. Se
// escribe como .part y recién con tamaño y hash correctos toma su nombre; uno ya bajado y correcto se reutiliza.
export async function downloadSetup(asset: ReleaseAsset, directory: string, options: { fetch?: Fetch; signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void } = {}): Promise<string> {
  if (!setupName.test(asset.name) || asset.size > limits.setup) throw new UpdateError('format');
  fs.mkdirSync(directory, { recursive: true });
  const final = path.join(directory, asset.name), partial = `${final}.part`;
  try {
    if (fs.statSync(final).size === asset.size && await sha256File(final) === asset.sha256) return final;
    fs.rmSync(final, { force: true });
  } catch { /* No había uno bajado. */ }
  const fetchImpl = options.fetch ?? fetch;
  return withServerRetries(async () => {
    const { response, stall, done, failure } = await request(releaseUrl(asset), fetchImpl, options.signal, host => downloadHosts.has(host));
    const length = Number(response.headers.get('content-length'));
    let file: fs.promises.FileHandle;
    try {
      if (Number.isFinite(length) && length > 0 && length !== asset.size) throw new UpdateError('size');
      file = await fs.promises.open(partial, 'w');
    } catch (error) { await response.body?.cancel().catch(() => {}); done(); throw error; }
    const hash = crypto.createHash('sha256');
    let received = 0;
    try {
      const reader = response.body!.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        received += value.byteLength;
        if (received > asset.size) { await reader.cancel().catch(() => {}); throw new UpdateError('size'); }
        hash.update(value); await file.write(value); stall();
        options.onProgress?.(received, asset.size);
      }
    } catch (error) {
      await file.close().catch(() => {}); fs.rmSync(partial, { force: true }); done();
      throw failure(error);
    }
    await file.close(); done();
    if (received !== asset.size) { fs.rmSync(partial, { force: true }); throw new UpdateError('size'); }
    if (hash.digest('hex') !== asset.sha256) { fs.rmSync(partial, { force: true }); throw new UpdateError('hash'); }
    fs.renameSync(partial, final);
    return final;
  }, options.signal);
}

// Restos de intentos anteriores: sólo instaladores, scripts y descargas parciales de El Music con su nombre exacto.
export function sweepUpdates(directory: string): number {
  let removed = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (!updateFiles.setup.test(name) && !updateFiles.helper.test(name) && !updateFiles.partial.test(name)) continue;
    try { fs.rmSync(path.join(directory, name), { force: true }); removed++; } catch { /* Lo retiene otro proceso: queda para el próximo arranque. */ }
  }
  // El registro del script de actualización suma unas líneas por update: se empieza de nuevo si pasa de 64 KB.
  try { if (fs.lstatSync(path.join(directory, helperLog)).size > 64 * 1024) { fs.rmSync(path.join(directory, helperLog), { force: true }); removed++; } } catch { /* No hay. */ }
  return removed;
}

// Script que espera a que se cierre la app instalada y abre el instalador sobre la misma carpeta. Es el helper de las
// apps LGA (libs/lgaupdate) para una app sin procesos de fondo: si la app sigue abierta a los 15 s no se fuerza nada,
// se avisa, se vuelve a abrir la app y el update queda para otra vez. Sólo ASCII: PowerShell 5.1 lee un .ps1 sin BOM
// con la página de códigos del sistema.
export function helperScript(): string {
  return String.raw`param([string]$InstallerPath, [string]$AppDir, [string]$LogPath, [string]$Sha256)
$ErrorActionPreference = 'SilentlyContinue'
$script:helperSelfPath = $MyInvocation.MyCommand.Path
function Remove-Self { if ($script:helperSelfPath) { Remove-Item -LiteralPath $script:helperSelfPath -Force -ErrorAction SilentlyContinue } }
function Write-Log([string]$Message) {
    if ($LogPath) {
        $line = '[{0}] [helper {1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $Message
        Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    }
}
if (-not $InstallerPath -or -not (Test-Path -LiteralPath $InstallerPath)) { Write-Log "No existe el instalador"; Remove-Self; exit 1 }
Write-Log "Inicio del helper"
function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    try { return [System.IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant() } catch { return $Path.TrimEnd('\').ToLowerInvariant() }
}
$appDirNorm = Normalize-Path $AppDir
function Test-InAppDir([string]$Path) {
    $norm = Normalize-Path $Path
    if (-not $appDirNorm -or -not $norm) { return $false }
    return ($norm -eq $appDirNorm) -or $norm.StartsWith($appDirNorm + '\')
}
function Get-AppProcesses { Get-CimInstance Win32_Process | Where-Object { ($_.Name -ieq 'LGA_El_Music.exe') -and (Test-InAppDir $_.ExecutablePath) } }
$deadline = (Get-Date).AddMilliseconds(15000)
while ((Get-AppProcesses | Select-Object -First 1) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (Get-AppProcesses | Select-Object -First 1) {
    Write-Log 'Update postergado: la app sigue abierta'
    try { $shell = New-Object -ComObject WScript.Shell; $shell.Popup('The update was postponed because El Music is still open. Close it and choose El Music > Check for Updates again.', 0, 'El Music Update', 48) | Out-Null } catch {}
    try { Start-Process -FilePath (Join-Path $AppDir 'LGA_El_Music.exe') } catch {}
    Remove-Self
    exit 3
}
# El instalador se vuelve a verificar justo antes de abrirlo: pasaron segundos desde la descarga.
$actual = ''
try { $actual = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() } catch {}
if (-not $Sha256 -or $actual -ne $Sha256.ToLowerInvariant()) {
    Write-Log 'El instalador cambio despues de la descarga: no se abre'
    Remove-Item -LiteralPath $InstallerPath -Force -ErrorAction SilentlyContinue
    try { Start-Process -FilePath (Join-Path $AppDir 'LGA_El_Music.exe') } catch {}
    Remove-Self
    exit 4
}
for ($i = 0; $i -lt 20; $i++) {
    try {
        $dirArgument = '/DIR="' + $AppDir + '"'
        Start-Process -FilePath $InstallerPath -ArgumentList $dirArgument -ErrorAction Stop
        Write-Log 'Instalador lanzado'
        Remove-Self
        exit 0
    } catch { Start-Sleep -Milliseconds 500 }
}
Write-Log 'No se pudo lanzar el instalador despues de 20 intentos'
Remove-Self
exit 2
`;
}

export function writeHelper(directory: string, now = Date.now()): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `LGA_ElMusic_Update_Helper_${now}.ps1`);
  fs.writeFileSync(file, helperScript().replace(/\r?\n/g, '\r\n'), { encoding: 'ascii', flag: 'wx' });
  return file;
}

// Aviso de la descarga en la página de Apple (abajo a la derecha, para no tapar los avisos propios del centro).
export function updateToastScript(state: { text: string; detail?: string; working?: boolean; hideAfterMs?: number } | null): string {
  return `(() => {
    if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port) return null;
    const state = ${JSON.stringify(state)};
    let box = document.getElementById('el-music-update-toast');
    if (!state) { box?.remove(); return true; }
    if (!box) { box = document.createElement('div'); box.id = 'el-music-update-toast'; box.className = 'el-music-toast el-music-toast--update'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    box.replaceChildren();
    const row = document.createElement('div');
    if (state.working) { const ring = document.createElement('span'); ring.className = 'el-music-toast__spinner'; ring.setAttribute('aria-hidden', 'true'); row.appendChild(ring); }
    row.appendChild(document.createTextNode(state.text)); box.appendChild(row);
    if (state.detail) { const more = document.createElement('div'); more.className = 'el-music-toast__detail'; more.textContent = state.detail; box.appendChild(more); }
    clearTimeout(box._elMusicHide);
    if (state.hideAfterMs) box._elMusicHide = setTimeout(() => box.remove(), state.hideAfterMs);
    return true;
  })()`;
}

export type UpdateAnswer = 'update' | 'later' | 'skip' | 'cancel';
export type UpdateMessage = 'up-to-date' | 'check-failed' | 'download-failed' | 'install-failed' | 'blocked' | 'busy' | 'notes-unavailable';
export interface UpdaterHost {
  version: string; preferences: string; downloads: string; installDir: string; platform: 'win' | 'mac'; blocked?: UpdateBlock;
  log(event: string, fields?: Record<string, string | number | boolean>): void;
  ask(offer: UpdateOffer, notes: string): Promise<UpdateAnswer>;
  tell(message: UpdateMessage, detail?: string): Promise<void>;
  progress(state: { version: string; received: number; total: number } | { version: string; verifying: true } | null): void;
  launch(setup: string, helper: string, logFile: string, sha256: string): Promise<boolean>;
  whatsNew(title: string, text: string): Promise<void>;
  fetch?: Fetch; now?: () => number; random?: () => number;
}

export class Updater {
  private timers: NodeJS.Timeout[] = [];
  private nextAt = 0;
  private busy = false;
  private dismissed = new Set<string>();
  private download?: AbortController;
  private prefs: UpdatePrefs;
  constructor(private readonly host: UpdaterHost) { this.prefs = readUpdatePrefs(host.preferences); }

  get blocked(): UpdateBlock | undefined { return this.host.blocked; }
  get autoCheck(): boolean { return this.prefs.autoCheck; }
  get checking(): boolean { return this.busy; }
  private now(): number { return (this.host.now ?? Date.now)(); }
  private save(): void { try { saveUpdatePrefs(this.host.preferences, this.prefs); } catch { this.host.log('No se pudo guardar updates.json'); } }
  private scheduleNext(delay: number): void { this.nextAt = this.now() + delay; }
  private regular(): number { return updateTiming.intervalMs + Math.round(((this.host.random ?? Math.random)() * 2 - 1) * updateTiming.jitterMs); }

  start(): void {
    if (this.blocked) { this.host.log('Actualizaciones: desactivadas en esta copia', { motivo: this.blocked }); return; }
    const removed = sweepUpdates(this.host.downloads);
    if (removed) this.host.log('Actualizaciones: restos borrados', { archivos: removed });
    this.scheduleNext(updateTiming.firstCheckMs);
    this.timers.push(setTimeout(() => this.tick(), updateTiming.firstCheckMs + 50));
    const interval = setInterval(() => this.tick(), updateTiming.tickMs); interval.unref?.();
    this.timers.push(interval);
  }
  stop(): void { for (const timer of this.timers) { clearTimeout(timer); clearInterval(timer); } this.timers = []; this.download?.abort(); }

  setAutoCheck(enabled: boolean): void {
    this.prefs = { ...this.prefs, autoCheck: enabled }; this.save();
    this.host.log('Actualizaciones: búsqueda automática', { activa: enabled });
    if (enabled && this.nextAt < this.now()) this.scheduleNext(0);
  }

  private tick(): void {
    if (!this.prefs.autoCheck || this.busy || this.now() < this.nextAt) return;
    void this.check(false);
  }

  async check(manual: boolean): Promise<void> {
    if (this.blocked) { if (manual) await this.host.tell('blocked', this.blocked); return; }
    if (this.busy) { if (manual) await this.host.tell('busy'); return; }
    this.busy = true;
    let offer: UpdateOffer | undefined;
    try {
      const manifest = await readManifest(this.host.fetch);
      offer = findUpdate(manifest, this.host.version);
      this.scheduleNext(this.regular());
      this.host.log('Actualizaciones: chequeo', { manual, nueva: offer?.version ?? '' });
    } catch (error) {
      this.scheduleNext(updateTiming.retryMs);
      this.host.log('Actualizaciones: no se pudo leer el manifiesto', { error: error instanceof UpdateError ? error.kind : error instanceof TypeError ? 'network' : 'other' });
      this.busy = false;
      if (manual) await this.host.tell('check-failed');
      return;
    }
    try {
      if (!offer) { if (manual) await this.host.tell('up-to-date'); return; }
      if (!manual && (this.prefs.skipped === offer.version || (this.prefs.snoozeUntil ?? 0) > this.now() || this.dismissed.has(offer.version))) return;
      let notes = '';
      if (offer.notes) {
        try {
          const raw = await readNotes(offer.notes, this.host.fetch);
          const versions = parseWhatsNew(raw, this.host.platform);
          if (versions.length) { try { cacheNotes(this.host.preferences, raw); } catch { this.host.log('No se pudo guardar whats-new.json'); } }
          notes = notesText(versions, this.host.version, offer.version, 12);
        } catch { this.host.log('Actualizaciones: notas no disponibles'); }
      }
      const answer = await this.host.ask(offer, notes);
      this.host.log('Actualizaciones: respuesta', { respuesta: answer, versión: offer.version });
      if (answer === 'later') { this.prefs = { ...this.prefs, snoozeUntil: this.now() + updateTiming.snoozeMs }; this.save(); }
      else if (answer === 'skip') { this.prefs = { ...this.prefs, skipped: offer.version }; this.save(); }
      else if (answer === 'cancel') this.dismissed.add(offer.version);
      else {
        // Elegir actualizar deja sin efecto un «después» o un «saltear» anteriores, como en las demás apps LGA.
        const { snoozeUntil: _snooze, skipped: _skipped, ...rest } = this.prefs;
        if (_snooze !== undefined || _skipped !== undefined) { this.prefs = rest; this.save(); }
        await this.install(offer);
      }
    } finally { this.busy = false; }
  }

  private async install(offer: UpdateOffer): Promise<void> {
    const started = this.now();
    let last = -1;
    this.download = new AbortController();
    this.host.progress({ version: offer.version, received: 0, total: offer.setup.size });
    let setup: string;
    try {
      setup = await downloadSetup(offer.setup, this.host.downloads, { fetch: this.host.fetch, signal: this.download.signal, onProgress: (received, total) => {
        const percent = Math.floor(received * 100 / total);
        if (percent !== last) { last = percent; this.host.progress({ version: offer.version, received, total }); }
      } });
    } catch (error) {
      this.host.progress(null);
      this.host.log('No se pudo bajar la actualización', { error: error instanceof UpdateError ? error.kind : error instanceof TypeError ? 'network' : 'other' });
      if (!this.download.signal.aborted) await this.host.tell('download-failed');
      return;
    } finally { this.download = undefined; }
    this.host.log('Actualizaciones: instalador verificado', { versión: offer.version, ms: this.now() - started });
    this.host.progress({ version: offer.version, verifying: true });
    let helper: string;
    try { helper = writeHelper(this.host.downloads, this.now()); }
    catch { this.host.progress(null); this.host.log('No se pudo escribir el script de actualización'); await this.host.tell('install-failed'); return; }
    if (!await this.host.launch(setup, helper, path.join(this.host.downloads, helperLog), offer.setup.sha256)) {
      this.host.progress(null); fs.rmSync(helper, { force: true });
      this.host.log('No se pudo abrir el instalador de la actualización');
      await this.host.tell('install-failed');
    }
  }

  // Una vez después de actualizar: lo nuevo desde la versión que se usaba antes. En una instalación nueva no se muestra.
  async afterStart(): Promise<void> {
    const seen = this.prefs.seen;
    if (seen && compareVersions(this.host.version, seen) <= 0) return;
    this.prefs = { ...this.prefs, seen: this.host.version };
    if (this.prefs.skipped && compareVersions(this.prefs.skipped, this.host.version) <= 0) delete this.prefs.skipped;
    this.save();
    if (!seen || this.blocked) return;
    const text = notesText(parseWhatsNew(cachedNotes(this.host.preferences), this.host.platform), seen, this.host.version, 14);
    if (text) await this.host.whatsNew(`What’s new in El Music ${this.host.version}`, text);
  }

  // Help › What's New: las notas publicadas (o las guardadas, sin red) hasta la versión instalada.
  async whatsNew(): Promise<void> {
    let versions: NotesVersion[] = [];
    try {
      const asset = findNotes(await readManifest(this.host.fetch));
      if (asset) {
        const raw = await readNotes(asset, this.host.fetch);
        versions = parseWhatsNew(raw, this.host.platform);
        if (versions.length) { try { cacheNotes(this.host.preferences, raw); } catch { /* Se muestran igual. */ } }
      }
    } catch { /* Sin red: las guardadas. */ }
    if (!versions.length) versions = parseWhatsNew(cachedNotes(this.host.preferences), this.host.platform);
    const text = notesText(versions, undefined, this.host.version, 24);
    if (text) await this.host.whatsNew('What’s New in El Music', text);
    else await this.host.tell('notes-unavailable');
  }
}
