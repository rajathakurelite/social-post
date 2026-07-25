/**
 * Feature 256: regenerate env var table comments from config/config.js names (never values).
 * Usage: node scripts/generate-env-docs.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configSrc = fs.readFileSync(path.join(root, 'config', 'config.js'), 'utf8');

/** Collect env names referenced via req('NAME') or process.env.NAME in config.js */
export function collectEnvNames(source = configSrc) {
  const names = new Set();
  const reReq = /req\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
  const reEnv = /process\.env\.([A-Z0-9_]+)/g;
  let m;
  while ((m = reReq.exec(source))) names.add(m[1]);
  while ((m = reEnv.exec(source))) names.add(m[1]);
  // isEnabled('FOO_ENABLED') pattern
  const reEn = /isEnabled\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
  while ((m = reEn.exec(source))) names.add(m[1]);
  return [...names].sort();
}

const names = collectEnvNames();
const markerStart = '# --- AUTO-GENERATED ENV NAMES (scripts/generate-env-docs.js) ---';
const markerEnd = '# --- END AUTO-GENERATED ENV NAMES ---';
const block = [
  markerStart,
  '# Names only — never paste live values here.',
  ...names.map((n) => `# ${n}`),
  markerEnd,
].join('\n');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envExamplePath = path.join(root, '.env.example');
  let example = fs.readFileSync(envExamplePath, 'utf8');
  if (example.includes(markerStart) && example.includes(markerEnd)) {
    example = example.replace(new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}`), () => block);
  } else {
    example = `${example.trimEnd()}\n\n${block}\n`;
  }
  fs.writeFileSync(envExamplePath, example, 'utf8');
  console.log(`generate-env-docs: ${names.length} names → .env.example`);
}
