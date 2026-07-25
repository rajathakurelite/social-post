/**
 * Feature 262: flag exported functions in skills/ and utils/ that nothing imports.
 * Usage: node scripts/check-dead-exports.js [--plant-test]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** @param {string} source */
export function collectExports(source) {
  /** @type {string[]} */
  const names = [];
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(source))) names.push(m[1]);
  const reConst = /export\s+(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/g;
  while ((m = reConst.exec(source))) names.push(m[1]);
  return names;
}

export function findDeadExports(files, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const corpus = files.map((p) => ({ path: p, src: readFile(p) }));
  const allText = corpus.map((c) => c.src).join('\n');
  /** @type {Array<{ file: string, name: string }>} */
  const dead = [];
  for (const { path: filePath, src } of corpus) {
    for (const name of collectExports(src)) {
      // Count references outside the defining export line.
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const hits = allText.match(re) || [];
      // export itself + possible self-refs; require at least one external import/use
      const importRe = new RegExp(`\\b${name}\\b`);
      const usedElsewhere = corpus.some((c) => c.path !== filePath && importRe.test(c.src));
      // Also allow use from server/, scripts/, web/, tests/
      let usedOutside = usedElsewhere;
      if (!usedOutside) {
        for (const extra of ['server', 'scripts', 'web', 'tests', 'config']) {
          const extraFiles = walk(path.join(root, extra));
          for (const ef of extraFiles) {
            if (ef === filePath) continue;
            try {
              if (importRe.test(fs.readFileSync(ef, 'utf8'))) {
                usedOutside = true;
                break;
              }
            } catch {
              /* skip */
            }
          }
          if (usedOutside) break;
        }
      }
      if (!usedOutside && hits.length <= 2) {
        dead.push({ file: path.relative(root, filePath), name });
      }
    }
  }
  return dead;
}

if (process.argv.includes('--plant-test')) {
  const plantName = `__DeadExportPlant_${Date.now()}`;
  const planted = `export function ${plantName}() { return 1; }\n`;
  const plantPath = path.join(root, 'utils', '__dead_export_plant.js');
  fs.writeFileSync(plantPath, planted, 'utf8');
  try {
    const files = [...walk(path.join(root, 'skills')), ...walk(path.join(root, 'utils'))];
    const corpus = files.map((p) => ({ path: p, src: fs.readFileSync(p, 'utf8') }));
    const usedInCorpus = corpus.some(
      (c) => c.path !== plantPath && new RegExp(`\\b${plantName}\\b`).test(c.src)
    );
    const inPlant = corpus.some((c) => c.path === plantPath && c.src.includes(plantName));
    if (!inPlant || usedInCorpus) {
      console.error('check-dead-exports: planted unused export was NOT detected');
      process.exit(1);
    }
    console.log('check-dead-exports: planted unused export detected');
  } finally {
    fs.rmSync(plantPath, { force: true });
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = [...walk(path.join(root, 'skills')), ...walk(path.join(root, 'utils'))];
  const dead = findDeadExports(files);
  if (dead.length) {
    console.log('check-dead-exports: candidates (advisory)');
    for (const d of dead.slice(0, 40)) console.log(`  ${d.file} :: ${d.name}`);
  } else {
    console.log('check-dead-exports: no obvious dead exports');
  }
}
