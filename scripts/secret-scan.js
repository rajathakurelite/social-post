/**
 * Feature 188: scan source (not .env) for token-like patterns.
 * Exit 1 on hits.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS = [/\bEAAG[A-Za-z0-9]{10,}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\b[A-Fa-f0-9]{40,}\b/];
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'output', 'web/dist', 'dist']);

/** @type {string[]} */
const hits = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.env' || name.startsWith('.env.')) continue;
    const p = path.join(dir, name);
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel.split('/')[0])) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'fixtures' && process.argv.includes('--allow-fixtures')) continue;
      walk(p);
      continue;
    }
    if (!/\.(js|jsx|mjs|cjs|ts|tsx|json|md|css|html)$/i.test(name)) continue;
    if (rel.startsWith('tests/') || rel.startsWith('coverage/')) continue;
    if (rel.includes('fixtures/') && !process.argv.includes('--scan-fixtures')) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const re of PATTERNS) {
      if (re.test(text)) {
        hits.push(`${rel}: matched ${re}`);
        break;
      }
    }
  }
}

walk(root);

if (process.argv.includes('--fixture-selftest')) {
  const fixture = path.join(root, 'fixtures', 'secret-scan-plant.txt');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, 'planted EAAG1234567890abcdefTOKEN\n', 'utf8');
  const text = fs.readFileSync(fixture, 'utf8');
  const caught = PATTERNS.some((re) => re.test(text));
  fs.rmSync(fixture, { force: true });
  if (!caught) {
    console.error('secret-scan selftest FAILED — planted token not caught');
    process.exit(1);
  }
  console.log('secret-scan selftest OK');
  process.exit(0);
}

if (hits.length) {
  console.error('secret-scan FAILED:');
  for (const h of hits) console.error(' ', h);
  process.exit(1);
}
console.log('secret-scan OK');
