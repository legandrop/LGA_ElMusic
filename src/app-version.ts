// La versión de El Music es X.YY (dos cifras decimales, como el resto de las apps LGA): 0.91, 0.92… package.json la
// guarda como X.YY.0 porque npm y electron-builder sólo aceptan semver; la app, el instalador y los releases muestran
// X.YY. La misma conversión vive en scripts/version.mjs, que no puede importar código de la app.
export function displayVersion(semver: string): string {
  const match = /^(\d+)\.(\d+)\.0$/.exec(semver);
  return match ? `${Number(match[1])}.${match[2].padStart(2, '0')}` : semver;
}
