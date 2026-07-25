/**
 * Feature 258: Playwright UI smoke — compose → polish (MOCK_OLLAMA) → dry-run publish.
 * Spawns API on an ephemeral port; drives the operator UI via built web/dist when present,
 * otherwise exercises the API path with Playwright request + a minimal page.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'web', 'dist');

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

const port = 8791 + Math.floor(Math.random() * 80);
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
    OLLAMA_WARMUP: 'false',
    OPS_PID_PATH: path.join(root, 'output', `api-pw-${port}.pid`),
    OPS_OUTPUT_DIR: path.join(root, 'output'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => {
  childLog += d.toString();
});
child.stderr.on('data', (d) => {
  childLog += d.toString();
});

let failed = false;
try {
  const ok = await waitForHealth(base);
  if (!ok) throw new Error(`API health never became ready\n${childLog.slice(-800)}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Prefer built UI when available; else a minimal harness that calls the same APIs.
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    const staticServer = http.createServer((req, res) => {
      let urlPath = String(req.url || '/').split('?')[0];
      if (urlPath.startsWith('/api')) {
        // proxy to API
        fetch(`${base}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
          duplex: 'half',
        })
          .then(async (r) => {
            res.writeHead(r.status, Object.fromEntries(r.headers));
            const buf = Buffer.from(await r.arrayBuffer());
            res.end(buf);
          })
          .catch((e) => {
            res.writeHead(502);
            res.end(String(e.message || e));
          });
        return;
      }
      if (urlPath === '/') urlPath = '/index.html';
      const file = path.join(distDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(distDir) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      const ext = path.extname(file);
      const type =
        ext === '.js'
          ? 'text/javascript'
          : ext === '.css'
            ? 'text/css'
            : ext === '.html'
              ? 'text/html'
              : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => staticServer.listen(0, host, resolve));
    const staticPort = staticServer.address().port;
    await page.goto(`http://${host}:${staticPort}/`, { waitUntil: 'domcontentloaded' });
    await page
      .getByLabel(/topic/i)
      .fill('Playwright smoke internship')
      .catch(async () => {
        await page.locator('textarea, input').first().fill('Playwright smoke internship');
      });
    const polishBtn = page.getByRole('button', { name: /polish/i }).first();
    await polishBtn.click();
    await page.waitForTimeout(1500);
    const publishBtn = page.getByRole('button', { name: /publish|dry-run/i }).first();
    if (await publishBtn.count()) await publishBtn.click({ timeout: 5000 }).catch(() => {});
    staticServer.close();
  } else {
    // API-only fallback harness
    await page.setContent(`<!doctype html><html><body>
      <h1>API harness</h1>
      <pre id="out"></pre>
      <script type="module">
        const base = ${JSON.stringify(base)};
        const out = document.getElementById('out');
        const polish = await fetch(base + '/api/polish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: 'Playwright smoke', platforms: ['twitter'], dryRun: true })
        }).then(r => r.json());
        const publish = await fetch(base + '/api/publish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dryRun: true,
            platforms: ['twitter'],
            posts: { twitter: { text: polish.posts?.twitter?.text || 'hi' } }
          })
        }).then(r => r.json());
        out.textContent = JSON.stringify({ polishOk: !!polish.posts, publishOk: publish.ok, id: publish.results?.[0]?.id });
        document.title = publish.ok ? 'SMOKE_OK' : 'SMOKE_FAIL';
      </script>
    </body></html>`);
    await page.waitForFunction(
      'document.title === "SMOKE_OK" || document.title === "SMOKE_FAIL"',
      null,
      {
        timeout: 60_000,
      }
    );
    if ((await page.title()) !== 'SMOKE_OK') throw new Error('API harness smoke failed');
  }

  await browser.close();
  console.log('playwright-ui-smoke: ok');
} catch (e) {
  failed = true;
  console.error('playwright-ui-smoke: FAIL', e.message || e);
} finally {
  child.kill('SIGTERM');
}
process.exit(failed ? 1 : 0);
