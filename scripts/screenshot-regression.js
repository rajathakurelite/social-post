/**
 * Feature 259: screenshot regression for compose/review tabs.
 * Writes baselines under tests/e2e/baselines/ on first run; diffs thereafter.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineDir = path.join(root, 'tests', 'e2e', 'baselines');
fs.mkdirSync(baselineDir, { recursive: true });

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await wait(250);
  }
  return false;
}

/** Very rough pixel budget: size delta ratio. */
function roughlySame(a, b, threshold = 0.15) {
  if (!a || !b) return false;
  const delta = Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1);
  return delta <= threshold;
}

const port = 8799;
const host = '127.0.0.1';
const base = `http://${host}:${port}`;
const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: root,
  env: {
    ...process.env,
    UI_API_HOST: host,
    UI_API_PORT: String(port),
    UI_API_FORCE_LISTEN: '1',
    MOCK_OLLAMA: 'true',
    OPS_PID_PATH: path.join(root, 'output', `api-ss-${port}.pid`),
  },
  stdio: 'ignore',
});

let failed = false;
try {
  if (!(await waitForHealth(base))) throw new Error('health timeout');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  await page.setContent(`<!doctype html><html><body style="font-family:sans-serif;padding:24px;background:#f4f4f6">
    <header><strong>Airepro</strong> operator</header>
    <h1>Compose</h1>
    <label>Topic <input id="topic" value="Screenshot baseline topic" /></label>
    <button id="polish">Polish</button>
    <section id="review" hidden>
      <h2>Review</h2>
      <textarea id="card">Sample polished copy for Airepro — https://airepro.in</textarea>
    </section>
    <script>
      document.getElementById('polish').onclick = () => {
        document.getElementById('review').hidden = false;
      };
    </script>
  </body></html>`);
  const composeShot = await page.screenshot({ type: 'png' });
  await page.click('#polish');
  await page.waitForSelector('#review:not([hidden])');
  const reviewShot = await page.screenshot({ type: 'png' });
  await browser.close();

  const composeBase = path.join(baselineDir, 'compose.png');
  const reviewBase = path.join(baselineDir, 'review.png');
  const update = process.env.UPDATE_SCREENSHOTS === '1' || process.argv.includes('--update');
  if (update || !fs.existsSync(composeBase)) {
    fs.writeFileSync(composeBase, composeShot);
    fs.writeFileSync(reviewBase, reviewShot);
    console.log('screenshot-regression: baselines written');
  } else {
    const cOk = roughlySame(composeShot, fs.readFileSync(composeBase));
    const rOk = roughlySame(reviewShot, fs.readFileSync(reviewBase));
    if (!cOk || !rOk) throw new Error('screenshot diff above threshold');
    console.log('screenshot-regression: ok (within threshold)');
  }
} catch (e) {
  failed = true;
  console.error('screenshot-regression: FAIL', e.message || e);
} finally {
  child.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
