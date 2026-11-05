// Arma el instalador de Windows (Inno Setup 6) con la carpeta win-unpacked ya firmada con Castlabs EVS.
//
// Uso: node scripts/installer-win.mjs [carpeta win-unpacked firmada]
// Sin argumento usa el candidato que deja `scripts/sign-win.mjs` para la versión de package.json. El instalador sale
// en release/LGA_ElMusic_Setup_v<X.YY>.exe: es el nombre que busca el actualizador de la app en el manifiesto de
// LGA_Updates. No ejecuta el instalador.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { root, metadata } from './package-integrity.mjs';
import { displayVersion } from './version.mjs';

if (process.platform !== 'win32') throw new Error('The Windows installer is built on Windows.');
// El candidato y la evidencia de la firma llevan la versión de package.json (X.YY.0); el instalador, la que ve el
// usuario (X.YY).
const packaged = metadata.version;
const version = displayVersion(packaged);
const source = resolve(process.argv[2] ?? join(root, `release/staging-win-x64-evs-candidate-${packaged}/win-unpacked`));

// Sólo una carpeta firmada, sin perfil ni datos: lo que entra acá llega a la PC de cada usuario.
for (const file of ['LGA_El_Music.exe', 'LGA_El_Music.exe.sig', 'resources/app.asar']) {
  if (!existsSync(join(source, file))) throw new Error(`Missing ${file} in ${source}`);
}
for (const forbidden of ['data', 'WidevineCdm', 'electron.exe.sig']) {
  if (existsSync(join(source, forbidden))) throw new Error(`${forbidden} must not be packaged: ${join(source, forbidden)}`);
}
const evidence = join(dirname(source), 'evs-verification.json');
if (existsSync(evidence)) {
  const record = JSON.parse(readFileSync(evidence, 'utf8'));
  if (record.version !== packaged || record.ok !== true || record.production !== true || record.streaming !== true) {
    throw new Error(`EVS evidence does not match a production streaming signature for ${version}.`);
  }
  const sig = readFileSync(join(source, 'LGA_El_Music.exe.sig'));
  if (createHash('sha256').update(sig).digest('hex') !== record.signature?.sha256) throw new Error('The signature sidecar differs from the EVS evidence.');
} else throw new Error(`Missing EVS evidence beside the package: ${evidence}`);

const compilers = ['C:/Program Files (x86)/Inno Setup 6/ISCC.exe', 'C:/Program Files/Inno Setup 6/ISCC.exe'];
const iscc = compilers.find(path => existsSync(path));
if (!iscc) throw new Error('Inno Setup 6 (ISCC.exe) is not installed.');
const output = join(root, 'release');
const result = spawnSync(iscc, ['/Q', `/DMyAppVersion=${version}`, `/DSourceDir=${source}`, `/O${output}`, join(root, 'LGA_ElMusic_installer.iss')],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`ISCC failed with code ${result.status}`);
const setup = join(output, `LGA_ElMusic_Setup_v${version}.exe`);
const hash = createHash('sha256');
for await (const chunk of createReadStream(setup)) hash.update(chunk);
console.log(JSON.stringify({ setup, size: statSync(setup).size, sha256: hash.digest('hex') }, null, 2));
