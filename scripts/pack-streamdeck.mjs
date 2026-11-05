// Empaqueta el plugin Stream Deck como .streamDeckPlugin (ZIP) con la versión de package.json, sin herramientas externas.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginName = 'com.lga.elmusic.sdPlugin';
const source = join(root, 'streamdeck', pluginName);

async function files(directory) {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'logs') found.push(...await files(path)); }
    else if (entry.isFile() && !/\.(?:psd|log)$/i.test(entry.name) && !/^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(entry.name)) found.push(path);
  }
  return found;
}

export function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  // Fecha fija (1/1/2026): el paquete depende sólo del contenido.
  const time = 0, date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const stored = compressed.length >= data.length;
    const body = stored ? data : compressed;
    const crc = crc32(data) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(stored ? 0 : 8, 8); header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26); header.writeUInt16LE(0, 28);
    local.push(header, nameBytes, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(stored ? 0 : 8, 10); record.writeUInt16LE(time, 12); record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(body.length, 20); record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packStreamDeck(output = join(root, 'dist', 'streamdeck', 'com.lga.elmusic.streamDeckPlugin')) {
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Versión semver inválida en package.json');
  const entries = [];
  for (const path of await files(source)) {
    const name = `${pluginName}/${relative(source, path).split('\\').join('/')}`;
    let data = await readFile(path);
    if (name === `${pluginName}/manifest.json`) {
      const manifest = JSON.parse(data.toString('utf8'));
      manifest.Version = `${version}.0`;
      data = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    entries.push({ name, data });
  }
  await mkdir(join(output, '..'), { recursive: true });
  await writeFile(output, zip(entries));
  return { output, files: entries.length, version };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await packStreamDeck();
