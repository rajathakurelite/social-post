/**
 * Offline-first UI/API smoke for Batch 2 (features 101–150).
 * Never calls live social APIs. Polish/creative path is optional when Ollama is up.
 *
 * Requires the operator API on UI_API_BASE (default http://127.0.0.1:8787).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  addSchedule,
  listSchedules,
  runQueueOnce,
  schedulePath,
} from '../skills/schedule_store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const base = process.env.UI_API_BASE || 'http://127.0.0.1:8787';
const outPath = path.join(root, 'output', 'ui-smoke-verify.json');

async function api(pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
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
  results.health = {
    ok: health.ok,
    ollama: health.ollama?.ok,
    forceDryRun: Boolean(health.forceDryRun),
  };
  console.log(results.health);
  if (!health.ok) throw new Error('health.ok is false');

  console.log('=== WAVE3 COMPOSE APIs (offline) ===');
  const historyEmpty = await api('/api/publish/history?limit=5');
  if (!Array.isArray(historyEmpty.entries)) throw new Error('history entries missing');

  const badLimit = await fetch(`${base}/api/publish/history?limit=abc`);
  if (badLimit.status !== 400) throw new Error('history non-numeric limit should 400');

  const packs = await api('/api/compose/hashtag-packs');
  if (!Array.isArray(packs.packs) || packs.packs.length < 1) throw new Error('hashtag packs empty');

  const times = await api('/api/compose/best-times');
  const timeKeys = Array.isArray(times.hints)
    ? times.hints.map((h) => h.platform || h.id)
    : Object.keys(times.hints || {});
  for (const p of ['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp']) {
    if (!timeKeys.includes(p)) throw new Error(`best-times missing ${p}`);
  }

  const chips = await api('/api/compose/topic-chips');
  if (!Array.isArray(chips.chips)) throw new Error('topic chips missing');

  const drafts = await api('/api/drafts');
  if (!Array.isArray(drafts.drafts)) throw new Error('drafts missing');

  const draftName = `smoke-${Date.now()}`;
  const saved = await api('/api/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: draftName,
      draft: { topic: 'smoke draft', selected: { twitter: true } },
    }),
  });
  const got = await api(`/api/drafts/${encodeURIComponent(draftName)}`);
  if (JSON.stringify(got.entry.draft) !== JSON.stringify(saved.entry.draft)) {
    throw new Error('draft round-trip mismatch');
  }
  await api(`/api/drafts/${encodeURIComponent(draftName)}`, { method: 'DELETE' });

  results.wave3 = {
    history: true,
    packs: packs.packs.length,
    chips: chips.chips.length,
    drafts: true,
    bestTimes: timeKeys.length,
  };
  console.log(results.wave3);

  console.log('=== UPLOAD + ALT TEXT ===');
  const form = new FormData();
  form.append('image', new Blob([tinyPng()], { type: 'image/png' }), 'verify.png');
  form.append('altText', 'Smoke test alt text');
  const upload = await api('/api/upload', { method: 'POST', body: form, timeoutMs: 30_000 });
  if (upload.altText !== 'Smoke test alt text') throw new Error('altText not round-tripped');
  results.upload = { uploadId: upload.uploadId, altText: upload.altText };
  console.log(results.upload);

  console.log('=== DRY-RUN PUBLISH (crafted posts, no Ollama) ===');
  const pub = await api('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dryRun: true,
      topic: 'Wave3 smoke publish',
      platforms: ['twitter', 'facebook'],
      posts: {
        twitter: { text: 'Smoke tweet https://airepro.in/' },
        facebook: {
          text: 'Smoke Facebook caption https://airepro.in/',
          uploadId: upload.uploadId,
          altText: 'Smoke test alt text',
        },
      },
      uploadId: upload.uploadId,
    }),
    timeoutMs: 60_000,
  });
  if (!(pub.ok && pub.dryRun)) throw new Error(`publish fail: ${JSON.stringify(pub)}`);
  const fbRow = pub.results.find((r) => r.platform === 'facebook');
  if (fbRow?.imageSource !== 'upload') throw new Error('expected facebook imageSource=upload');
  results.publishCrafted = {
    ok: true,
    dryRun: true,
    platforms: pub.results.map((r) => r.platform),
  };
  console.log(results.publishCrafted);

  const historyAfter = await api('/api/publish/history?limit=3');
  if (!historyAfter.entries.some((e) => e.topic === 'Wave3 smoke publish')) {
    throw new Error('publish history missing smoke entry');
  }
  results.historyLogged = true;

  console.log('=== SCHEDULE + QUEUE RUNNER (dry-run) ===');
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduled = addSchedule({
    topic: 'Queue smoke',
    platforms: ['twitter'],
    posts: { twitter: { text: 'queued smoke' } },
    fireAt: future,
    dryRun: true,
  });
  const store = { schedules: listSchedules() };
  const entry = store.schedules.find((s) => s.id === scheduled.id);
  if (!entry) throw new Error('schedule missing after add');
  entry.fireAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(schedulePath, `${JSON.stringify(store, null, 2)}\n`);

  const queueResults = await runQueueOnce({
    publish: async ({ platforms, posts, dryRun, topic }) =>
      api('/api/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platforms, posts, dryRun, topic }),
      }),
  });
  const done = queueResults.find((r) => r.id === scheduled.id);
  if (!done || !done.ok || done.dryRun !== true) {
    throw new Error(`queue runner failed: ${JSON.stringify(queueResults)}`);
  }
  results.queue = { id: done.id, dryRun: done.dryRun, ok: done.ok };
  console.log(results.queue);

  if (health.ollama?.ok && process.env.SMOKE_SKIP_POLISH !== '1') {
    console.log('=== OPTIONAL POLISH (Ollama up) ===');
    try {
      const polish = await api('/api/polish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'smoke optional polish',
          platforms: ['twitter'],
        }),
        timeoutMs: 180_000,
      });
      results.polishOptional = {
        ok: Boolean(polish.posts?.twitter?.text),
        onlyKeys: Object.keys(polish.posts || {}),
      };
      console.log(results.polishOptional);
    } catch (e) {
      results.polishOptional = { skipped: true, error: e.message || String(e) };
      console.log('polish optional skipped:', results.polishOptional.error);
    }
  } else {
    results.polishOptional = { skipped: true, reason: 'ollama down or SMOKE_SKIP_POLISH=1' };
    console.log('=== OPTIONAL POLISH skipped ===');
  }

  const u = await fetch(`${base}${upload.url}`);
  results.getAssets = { upload: u.status };
  if (u.status !== 200) throw new Error('upload asset GET failed');

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
