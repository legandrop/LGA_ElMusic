// Versión de El Music: X.YY, con dos cifras decimales (0.91, 0.92… 0.99, 1.00). package.json la guarda como semver
// X.YY.0 (npm y electron-builder no aceptan otra cosa) y es la única fuente; todo lo que ve el usuario (la app, el
// instalador, el tag y los assets del release) usa X.YY. src/app-version.ts hace la misma conversión dentro de la app.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const versionRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseText = /^(\d+)\.(\d{2})$/;

// "0.91.0" -> "0.91". Corta si package.json no tiene la forma X.YY.0.
export function displayVersion(semver) {
  const match = /^(\d+)\.(\d+)\.0$/.exec(semver);
  if (!match || match[2].length > 2) throw new Error(`package.json version must be X.YY.0 (got ${semver})`);
  return `${Number(match[1])}.${match[2].padStart(2, '0')}`;
}

// "0.91" -> "0.91.0".
export function semverFor(version) {
  const match = releaseText.exec(version);
  if (!match) throw new Error(`Version must be X.YY (got ${version})`);
  return `${Number(match[1])}.${Number(match[2])}.0`;
}

// La versión en centésimos, para sumar sin errores de coma flotante: "0.91" -> 91, "1.00" -> 100.
export function hundredths(version) {
  const match = releaseText.exec(version);
  if (!match) throw new Error(`Version must be X.YY (got ${version})`);
  return Number(match[1]) * 100 + Number(match[2]);
}

export function fromHundredths(value) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

export function packageVersion() {
  return JSON.parse(readFileSync(join(versionRoot, 'package.json'), 'utf8')).version;
}

export function appVersion() {
  return displayVersion(packageVersion());
}
