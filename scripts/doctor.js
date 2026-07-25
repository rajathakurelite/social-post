/**
 * Feature 270: local doctor — Node version, dirs, port, Ollama reachability.
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;

function ok(msg) {
  console.log('OK ', msg);
}
function bad(msg, hint) {
  failed += 1;
  console.error('FAIL', msg);
  if (hint) console.error('   →', hint);
}

const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node ${process.version}`);
else bad(`Node ${process.version}`, 'Install Node.js >= 18');

for (const d of ['output', 'output/creatives', 'output/uploads', 'config', 'config/brand']) {
  const p = path.join(root, d);
  try {
    fs.mkdirSync(p, { recursive: true });
    ok(`dir ${d}`);
  } catch (e) {
    bad(`dir ${d}`, e.message);
  }
}

const port = Number(process.env.UI_API_PORT) || 8787;
await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => {
    bad(`port ${port}`, 'Stop the other process or change UI_API_PORT');
    resolve();
  });
  srv.listen(port, '127.0.0.1', () => {
    ok(`port ${port} available`);
    srv.close(() => resolve());
  });
});

const ollama = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
try {
  const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(2000) });
  if (res.ok) ok(`Ollama reachable at ${ollama}`);
  else bad(`Ollama HTTP ${res.status}`, 'Start Ollama or set MOCK_OLLAMA=true');
} catch {
  // Not a hard fail for doctor exit — warn only when OLLAMA_REQUIRED
  if (process.env.OLLAMA_REQUIRED === 'true') {
    bad(`Ollama unreachable at ${ollama}`, 'Start Ollama or use MOCK_OLLAMA=true');
  } else {
    console.log('WARN Ollama unreachable (ok for offline/MOCK_OLLAMA)');
  }
}

process.exit(failed ? 1 : 0);
