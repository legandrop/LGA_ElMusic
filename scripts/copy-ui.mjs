import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
await mkdir(new URL('dist/ui/', root), { recursive: true });
await cp(fileURLToPath(new URL('src/ui/', root)), fileURLToPath(new URL('dist/ui/', root)), { recursive: true });
