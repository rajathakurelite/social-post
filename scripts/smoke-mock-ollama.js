/**
 * Feature 248: polish E2E against the HTTP mock Ollama server.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mockPort = 11439;
const apiPort = 8789;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUrl(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await wait(200);
  }
  return false;
}

const mock = spawn(process.execPath, [path.join(root, 'scripts', 'mock-ollama.js')], {
  cwd: root,
  env: { ...process.env, MOCK_OLLAMA_PORT: String(mockPort) },
  stdio: 'ignore',
});

const api = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: root,
  env: {
    ...process.env,
    UI_API_HOST: '127.0.0.1',
    UI_API_PORT: String(apiPort),
    UI_API_FORCE_LISTEN: '1',
    OLLAMA_URL: `http://127.0.0.1:${mockPort}`,
    MODEL: 'mock',
    MOCK_OLLAMA: 'false',
    OLLAMA_WARMUP: 'false',
    OPS_PID_PATH: path.join(root, 'output', `api-mock-${apiPort}.pid`),
  },
  stdio: 'ignore',
});

let failed = false;
try {
  if (!(await waitUrl(`http://127.0.0.1:${mockPort}/api/tags`)))
    throw new Error('mock-ollama down');
  if (!(await waitUrl(`http://127.0.0.1:${apiPort}/api/health`))) throw new Error('api down');
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: 'Mock ollama smoke', platforms: ['twitter'] }),
  });
  const data = await res.json();
  if (!res.ok || !data.posts?.twitter?.text) {
    throw new Error(data.error || `polish failed ${res.status}`);
  }
  console.log('smoke:mock-ollama ok');
} catch (e) {
  failed = true;
  console.error('smoke:mock-ollama FAIL', e.message || e);
} finally {
  mock.kill();
  api.kill();
}
process.exit(failed ? 1 : 0);
