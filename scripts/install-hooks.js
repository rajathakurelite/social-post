/**
 * Feature 255: optional pre-commit hook (secret-scan + lint). No husky.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hookDir = path.join(root, '.git', 'hooks');
const dest = path.join(hookDir, 'pre-commit');

if (!fs.existsSync(path.join(root, '.git'))) {
  console.error('install-hooks: .git not found');
  process.exit(1);
}
fs.mkdirSync(hookDir, { recursive: true });
const body = `#!/bin/sh
node scripts/secret-scan.js || exit 1
npm run lint || exit 1
`;
fs.writeFileSync(dest, body, 'utf8');
try {
  fs.chmodSync(dest, 0o755);
} catch {
  // Windows may ignore chmod
}
console.log('install-hooks: wrote', dest);
