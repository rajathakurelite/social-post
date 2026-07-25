/**
 * Feature 236: run smoke scripts and print a pass/fail table.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokes = [
  { name: 'auto-reply', cmd: ['node', 'scripts/smoke-auto-reply.js'] },
  { name: 'ui-dryrun', cmd: ['node', 'scripts/smoke-ui-dryrun.js'], env: { MOCK_OLLAMA: 'true' } },
];

let failed = 0;
console.log('Smoke matrix\n------------');
for (const s of smokes) {
  const t0 = Date.now();
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
    cwd: root,
    env: { ...process.env, ...(s.env || {}) },
    encoding: 'utf8',
    shell: false,
  });
  const ms = Date.now() - t0;
  const pass = r.status === 0;
  if (!pass) failed += 1;
  const color = pass ? '\x1b[32m' : '\x1b[31m';
  console.log(`${color}${pass ? 'PASS' : 'FAIL'}\x1b[0m  ${s.name.padEnd(16)} ${ms}ms`);
  if (!pass && r.stderr) console.error(r.stderr.slice(0, 500));
}
process.exit(failed ? 1 : 0);
