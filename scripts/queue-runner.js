/**
 * Queue runner (feature 105): process due schedule entries through the local
 * publish API — `node scripts/queue-runner.js`.
 *
 * Dry-run semantics: every entry publishes as dry-run UNLESS the entry was
 * queued with dryRun:false AND `QUEUE_ARMED=true` is set in the environment
 * at run time. That decision is made by runQueueOnce in the schedule store —
 * this script never forces dryRun:false itself.
 *
 * Exits 0 when everything processed cleanly (or nothing was due), 1 when any
 * entry errored.
 */
import { runQueueOnce, isQueueArmed } from '../skills/schedule_store.js';

const API_BASE = process.env.UI_API_BASE || 'http://127.0.0.1:8787';

/**
 * Publish one due entry through the existing /api/publish path.
 * @param {{ platforms: string[], posts: object, dryRun: boolean, topic: string }} args
 * @returns {Promise<object>} the publish API response body
 */
async function publish({ platforms, posts, dryRun, topic }) {
  const res = await fetch(`${API_BASE}/api/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platforms, posts, dryRun, topic }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `publish failed with HTTP ${res.status}`);
  }
  return body;
}

async function main() {
  console.log(`queue: armed=${isQueueArmed()} api=${API_BASE}`);
  const results = await runQueueOnce({ publish });
  if (!results.length) {
    console.log('queue: nothing due');
    return 0;
  }
  let errored = 0;
  for (const r of results) {
    if (!r.ok) errored++;
    console.log(
      `queue: id=${r.id} dryRun=${r.dryRun} ok=${r.ok}${r.error ? ` error=${r.error}` : ''}`
    );
  }
  return errored ? 1 : 0;
}

process.exitCode = await main();
