/**
 * Feature 245: seed sample drafts + publish history for demo/dev.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendPublishLog } from '../skills/publish_history.js';
import { saveDraft } from '../skills/drafts_store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'output'), { recursive: true });

saveDraft(
  'seed-demo',
  {
    topic: 'Remote summer internships',
    notes: 'Seeded draft',
    selected: { facebook: true, twitter: true, linkedin: true, youtube: false, whatsapp: false },
    dryRun: true,
  },
  { overwrite: true }
);

appendPublishLog({
  topic: 'Remote summer internships',
  platforms: ['facebook', 'twitter'],
  dryRun: true,
  results: [
    { platform: 'facebook', ok: true, dryRun: true, id: 'dry-fb-1' },
    { platform: 'twitter', ok: true, dryRun: true, id: 'dry-tw-1' },
  ],
});

appendPublishLog({
  topic: 'Freelance starter kit',
  platforms: ['linkedin'],
  dryRun: true,
  results: [{ platform: 'linkedin', ok: true, dryRun: true, id: 'dry-li-1' }],
});

console.log('seed: wrote sample drafts + publish history');
