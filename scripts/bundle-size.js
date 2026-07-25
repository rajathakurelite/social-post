/**
 * Feature 261: fail if main web chunk gzip estimate exceeds budget (250 KB).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'web', 'dist', 'assets');
const BUDGET = Number(process.env.BUNDLE_BUDGET_BYTES) || 250 * 1024;

if (!fs.existsSync(assets)) {
  console.error('bundle-size: run npm run build:web first');
  process.exit(1);
}

let main = null;
for (const name of fs.readdirSync(assets)) {
  if (/^index-.*\.js$/.test(name)) {
    main = path.join(assets, name);
    break;
  }
}
if (!main) {
  console.error('bundle-size: main index-*.js not found');
  process.exit(1);
}
const raw = fs.readFileSync(main);
const gzip = zlib.gzipSync(raw).length;
console.log(`bundle-size: ${path.basename(main)} gzip=${gzip} budget=${BUDGET}`);
if (gzip > BUDGET) {
  console.error('bundle-size: OVER BUDGET');
  process.exit(1);
}
console.log('bundle-size: OK');
