/**
 * Feature 100: chaos/webhook simulator — replay a sample inbox JSON through
 * the auto-reply engine, always dry-run, no network.
 *
 * Usage: node scripts/simulate-inbox.js [path/to/inbox.json]
 * Default inbox: config/sample_inbox.json
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { simulateInbox, getStats } from '../skills/auto_reply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inboxPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'config', 'sample_inbox.json');

try {
  if (!fs.existsSync(inboxPath)) {
    console.error(`Inbox file not found: ${inboxPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
  const messages = Array.isArray(raw) ? raw : raw.messages;
  if (!Array.isArray(messages) || !messages.length) {
    console.error('Inbox JSON must be an array of messages (or { messages: [...] })');
    process.exit(1);
  }

  console.log(
    `Replaying ${messages.length} inbound message(s) from ${path.basename(inboxPath)} (dry-run)\n`
  );
  const out = await simulateInbox(messages);

  for (const r of out.results) {
    const hit = (r.matches || [])[0];
    const label = r.skipped ? `skipped:${r.skipped}` : hit ? `matched ${hit.ruleId}` : 'no match';
    console.log(`- [${label}] ${r.from}: ${r.text}`);
    if (hit) console.log(`    reply: ${String(hit.reply).split('\n')[0].slice(0, 100)}`);
  }

  const stats = getStats();
  console.log(
    `\nSummary: ${out.matched}/${out.total} matched · inbound=${stats.inbound} matches=${stats.matches} sent=${stats.sent} (dry-run never sends)`
  );
  console.log('simulate-inbox PASSED');
  process.exit(0);
} catch (e) {
  console.error('simulate-inbox FAILED:', e.message || e);
  process.exit(1);
}
