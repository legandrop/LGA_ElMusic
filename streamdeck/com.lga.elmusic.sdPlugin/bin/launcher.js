'use strict';
// Abre El Music cuando no está corriendo, con la ruta que la app instalada guarda en sus preferencias (launch.json).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function launchFile(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'LGA', 'ElMusic', 'launch.json');
  return path.posix.join(home, 'Library', 'Application Support', 'LGA', 'ElMusic', 'launch.json');
}

// Sólo el ejecutable de El Music (Windows) o su bundle .app (Mac), nunca otra ruta que figure en el archivo.
function launchTarget(platform, executable) {
  if (typeof executable !== 'string' || executable.length > 1024) return;
  if (platform === 'win32') {
    return path.win32.isAbsolute(executable) && path.win32.basename(executable).toLowerCase() === 'lga_el_music.exe' ? executable : undefined;
  }
  if (platform !== 'darwin' || !path.posix.isAbsolute(executable)) return;
  const bundle = path.posix.resolve(executable, '..', '..', '..');
  return bundle.endsWith('.app') && path.posix.relative(bundle, executable) === path.posix.join('Contents', 'MacOS', path.posix.basename(executable)) ? bundle : undefined;
}

function launchApp(file = launchFile()) {
  let target;
  try { target = launchTarget(process.platform, JSON.parse(fs.readFileSync(file, 'utf8'))?.executable); } catch { return 'no-path'; }
  if (!target || !fs.existsSync(target)) return 'no-path';
  const child = process.platform === 'darwin'
    ? spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' })
    : spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore' });
  child.on('error', () => { /* Stream Deck ya mostró el aviso de la tecla. */ });
  child.unref();
  return 'launched';
}

module.exports = { launchApp, launchFile, launchTarget };
