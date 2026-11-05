import path from 'node:path';
import fs from 'node:fs';

export interface AppPaths {
  heavy: string;
  preferences: string;
  crashDumps: string;
  registry: string;
}

interface PathOptions {
  platform: NodeJS.Platform;
  packaged: boolean;
  executable: string;
  appData: string;
  repo: string;
  qaOut?: string;
}

export function resolvePaths(options: PathOptions): AppPaths {
  const p = options.platform === 'win32' ? path.win32 : path.posix;
  const { appData, repo, qaOut } = options;
  let heavy: string;
  let preferences: string;
  if (qaOut) {
    const qaRoot = p.resolve(repo, '.qa');
    const relative = p.relative(qaRoot, qaOut);
    if (!p.isAbsolute(qaOut) || !relative || relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) {
      throw new Error('QA_OUTPUT_OUTSIDE_REPO');
    }
    heavy = p.join(qaOut, 'browser');
    preferences = p.join(qaOut, 'preferences');
  } else {
    heavy = options.packaged
      ? options.platform === 'win32' ? p.join(p.dirname(options.executable), 'data') : p.join(appData, 'ElMusic', 'browser')
      : p.join(repo, '.local', 'browser');
    preferences = options.packaged ? p.join(appData, 'LGA', 'ElMusic') : p.join(repo, '.local', 'preferences');
  }
  return { heavy, preferences, crashDumps: p.join(heavy, 'crashes'), registry: p.join(appData, 'LGA', 'ElMusic.json') };
}

export function prepareDirectories(paths: AppPaths, qaOut?: string, repo?: string): void {
  if (qaOut && repo) {
    // QA no puede escapar mediante junction o symlink aunque la ruta textual sea válida.
    let cursor = qaOut;
    const root = path.resolve(repo);
    while (cursor !== root) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('QA_OUTPUT_LINK');
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('QA_OUTPUT_OUTSIDE_REPO');
      cursor = parent;
    }
  }
  for (const directory of [paths.heavy, paths.preferences, paths.crashDumps]) {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.write-probe-${process.pid}`);
    const descriptor = fs.openSync(probe, 'wx');
    fs.closeSync(descriptor);
    fs.unlinkSync(probe);
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function shouldRegisterInstallation(packaged: boolean, qa: boolean, installPath: string, resourcesPath: string): boolean {
  return packaged && !qa && !fs.existsSync(path.join(installPath, '.lga-staging')) &&
    !fs.existsSync(path.join(resourcesPath, '.lga-staging'));
}

export interface WindowBounds { x?: number; y?: number; width: number; height: number; }

export function visibleBounds(saved: WindowBounds | undefined,
  displays: Array<{ x: number; y: number; width: number; height: number }>): WindowBounds {
  const fallback = { width: 1280, height: 840 };
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return fallback;
  const width = Math.max(900, Math.min(2400, saved.width));
  const height = Math.max(600, Math.min(1800, saved.height));
  const x = saved.x;
  const y = saved.y;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
  const display = displays.find(d => x >= d.x && y >= d.y && x + 160 <= d.x + d.width && y + 80 <= d.y + d.height);
  return display ? { x, y, width: Math.min(width, display.width), height: Math.min(height, display.height) } : { width, height };
}
