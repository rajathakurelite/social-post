/**
 * Dry-run smoke: health, upload, polish auto creative, polish+publish upload.
 * No live Facebook Graph calls.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const base = process.env.UI_API_BASE || 'http://127.0.0.1:8787';
const outPath = path.join(root, 'output', 'ui-smoke-verify.json');

async function api(pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${pathname} → ${res.status}`);
  return data;
}

function tinyPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
}

const results = { passed: false };

try {
  console.log('=== HEALTH ===');
  const health = await api('/api/health', { timeoutMs: 20_000 });
  results.health = { ok: health.ok, ollama: health.ollama?.ok };
  console.log(results.health);
  if (!health.ollama?.ok) throw new Error(`Ollama down: ${health.ollama?.error}`);

  console.log('=== UPLOAD ===');
  const form = new FormData();
  form.append('image', new Blob([tinyPng()], { type: 'image/png' }), 'verify.png');
  const upload = await api('/api/upload', { method: 'POST', body: form, timeoutMs: 30_000 });
  results.upload = { uploadId: upload.uploadId, url: upload.url };
  console.log(results.upload);

  console.log('=== POLISH auto creative ===');
  const t0 = Date.now();
  const polish = await api('/api/polish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'dream internship for students',
      notes: 'verify auto creative',
      platforms: ['facebook'],
    }),
  });
  const fb = polish.posts?.facebook;
  console.log('ms=', Date.now() - t0, 'imageSource=', fb?.imageSource, 'url=', fb?.creativeUrl);
  if (fb?.imageSource !== 'creative') throw new Error(`expected creative, got ${fb?.imageSource}`);
  results.polishAuto = {
    imageSource: fb.imageSource,
    creativeUrl: fb.creativeUrl,
    ms: Date.now() - t0,
  };

  console.log('=== DRY-RUN publish auto ===');
  const pub = await api('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true, platforms: ['facebook'], posts: { facebook: fb } }),
    timeoutMs: 60_000,
  });
  if (!(pub.ok && pub.dryRun && pub.results?.[0]?.imageSource === 'creative')) {
    throw new Error(`auto publish fail: ${JSON.stringify(pub)}`);
  }
  results.publishAuto = { ok: true, dryRun: true, imageSource: 'creative' };
  console.log('auto publish OK');

  console.log('=== POLISH with upload ===');
  const t1 = Date.now();
  const polishUp = await api('/api/polish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: 'upload path verify',
      notes: 'use operator upload',
      platforms: ['facebook'],
      uploadId: upload.uploadId,
    }),
  });
  const fbUp = polishUp.posts?.facebook;
  console.log('ms=', Date.now() - t1, 'imageSource=', fbUp?.imageSource, 'uploadId=', fbUp?.uploadId);
  if (fbUp?.imageSource !== 'upload') throw new Error(`expected upload, got ${fbUp?.imageSource}`);
  results.polishUpload = {
    imageSource: fbUp.imageSource,
    uploadId: fbUp.uploadId,
    imageUrl: fbUp.imageUrl,
    ms: Date.now() - t1,
  };

  console.log('=== DRY-RUN publish upload ===');
  const pubUp = await api('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dryRun: true,
      platforms: ['facebook'],
      uploadId: upload.uploadId,
      posts: { facebook: fbUp },
    }),
    timeoutMs: 60_000,
  });
  if (!(pubUp.ok && pubUp.dryRun && pubUp.results?.[0]?.imageSource === 'upload')) {
    throw new Error(`upload publish fail: ${JSON.stringify(pubUp)}`);
  }
  results.publishUpload = { ok: true, dryRun: true, imageSource: 'upload' };
  console.log('upload publish OK');

  const u = await fetch(`${base}${upload.url}`);
  const c = await fetch(`${base}${fb.creativeUrl}`);
  results.getAssets = { upload: u.status, creative: c.status };
  if (u.status !== 200 || c.status !== 200) throw new Error('asset GET failed');

  results.passed = true;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('\nALL API DRY-RUN CHECKS PASSED →', outPath);
} catch (e) {
  results.error = e.message || String(e);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.error('SMOKE FAILED:', results.error);
  process.exit(1);
}
