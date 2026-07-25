/**
 * Feature 264: prune old creatives/uploads/rotated logs. Dry-run by default.
 * Usage: node scripts/prune-output.js --days 14 [--delete]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 14 : 14;
const doDelete = args.includes('--delete');
const cutoff = Date.now() - days * 86400_000;

const dirs = [path.join(root, 'output', 'creatives'), path.join(root, 'output', 'uploads')];

/** @type {string[]} */
const would = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) {
      would.push(p);
      if (doDelete) fs.rmSync(p, { force: true });
    }
  }
}

console.log(
  doDelete
    ? `prune: deleted ${would.length} files older than ${days}d`
    : `prune: dry-run — would delete ${would.length} files older than ${days}d (pass --delete to apply)`
);
for (const p of would.slice(0, 20)) console.log(' ', path.relative(root, p));
