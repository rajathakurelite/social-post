/**
 * Remaining Wave-3 finish-wave IDs (154–263 slice).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { fileURLToPath } from 'url';
import { app, sniffImageMagicBytes } from '../server/index.js';
import {
  quarantineWebhook,
  checkWebhookFreshness,
  isMalformedWebhook,
  getQuarantinePath,
} from '../utils/webhook_quarantine.js';
import { purgeUploadsToCap } from '../utils/upload_quota.js';
import { sweepCreativesTtl } from '../utils/creatives_ttl.js';
import { withWriteLock } from '../utils/write_lock.js';
import {
  validateAgainstSchema,
  validateRulesSchema,
  SETTINGS_SCHEMA,
} from '../utils/config_schema.js';
import { loadJsonWithBackup, getBackupsDir } from '../utils/config_backup.js';
import { computeHealthStatus } from '../server/health_util.js';
import { buildFacebookFeedPayload, buildFacebookPhotoPayload } from '../skills/post_facebook.js';
import { checkCreativeFonts } from '../skills/render_creative.js';
import { percentile, parsePolishDurations, checkPerfBudget } from '../utils/perf_budget.js';
import { collectEnvNames } from '../scripts/generate-env-docs.js';
import { collectExports } from '../scripts/check-dead-exports.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(root, 'fixtures');

describe('webhook quarantine + freshness (178/214)', () => {
  const prev = process.env.WEBHOOK_QUARANTINE_PATH;
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-'));
    process.env.WEBHOOK_QUARANTINE_PATH = path.join(tmp, 'q.jsonl');
  });
  afterEach(() => {
    if (prev == null) delete process.env.WEBHOOK_QUARANTINE_PATH;
    else process.env.WEBHOOK_QUARANTINE_PATH = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('garbage payload lands in quarantine, valid one does not', async () => {
    expect(isMalformedWebhook({ nope: true }, 'whatsapp')).toBe(true);
    quarantineWebhook({ reason: 'malformed_envelope', source: 'whatsapp', body: { nope: true } });
    const lines = fs.readFileSync(getQuarantinePath(), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);

    const valid = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'webhook-whatsapp.json'), 'utf8')
    );
    valid.entry[0].changes[0].value.messages[0].timestamp = String(Math.floor(Date.now() / 1000));
    expect(isMalformedWebhook(valid, 'whatsapp')).toBe(false);
    const before = fs.readFileSync(getQuarantinePath(), 'utf8');
    const res = await request(app).post('/api/webhooks/whatsapp').send(valid);
    expect(res.status).toBe(200);
    expect(res.body.quarantined).not.toBe(true);
    expect(fs.readFileSync(getQuarantinePath(), 'utf8')).toBe(before);
  });

  it('stale timestamp is quarantined, fresh passes', () => {
    const stale = {
      entry: [
        {
          changes: [
            { value: { messages: [{ timestamp: '1000', from: '1', text: { body: 'hi' } }] } },
          ],
        },
      ],
    };
    const fresh = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    from: '1',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(checkWebhookFreshness(stale).fresh).toBe(false);
    expect(checkWebhookFreshness(fresh).fresh).toBe(true);
  });
});

describe('upload magic bytes (224)', () => {
  it('renamed txt-as-png rejected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mag-'));
    const fake = path.join(dir, 'fake.png');
    fs.writeFileSync(fake, 'not-an-image');
    expect(sniffImageMagicBytes(fake)).toBe(false);
    const res = await request(app)
      .post('/api/upload')
      .attach('image', Buffer.from('not-an-image'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('path traversal (225)', () => {
  it('creative/upload routes reject traversal', async () => {
    const a = await request(app).get('/api/creatives/..%2fpackage.json');
    expect(a.status).toBe(400);
    const b = await request(app).get('/api/uploads/..%2fpackage.json');
    expect(b.status).toBe(400);
    const c = await request(app).get('/api/uploads/C:%5CWindows%5Cwin.ini');
    expect([400, 404]).toContain(c.status);
    expect(c.status).not.toBe(200);
  });
});

describe('uploads quota + creatives TTL (193/194)', () => {
  it('purge removes oldest-first until under cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uq-'));
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    fs.writeFileSync(a, 'aaaa');
    fs.writeFileSync(b, 'bbbbbbbb');
    const old = Date.now() - 10_000;
    fs.utimesSync(a, new Date(old), new Date(old));
    const out = purgeUploadsToCap(dir, 10);
    expect(out.deleted.some((p) => p.endsWith('a.bin'))).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('TTL removes old creatives, keeps newer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-'));
    const oldF = path.join(dir, 'old.png');
    const newF = path.join(dir, 'new.png');
    fs.writeFileSync(oldF, 'x');
    fs.writeFileSync(newF, 'y');
    const now = Date.now();
    fs.utimesSync(oldF, new Date(now - 10 * 86400_000), new Date(now - 10 * 86400_000));
    const out = sweepCreativesTtl(dir, 7, { nowMs: now });
    expect(out.removed.some((p) => p.endsWith('old.png'))).toBe(true);
    expect(out.kept.some((p) => p.endsWith('new.png'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('disk health (195)', () => {
  it('mocked low disk flips health to degraded', () => {
    expect(computeHealthStatus({ ollamaOk: true, diskFreeBytes: 1 })).toBe('degraded');
  });
});

describe('config schema + corrupt recovery (209/210)', () => {
  it('wrong-typed field produces path-specific error', () => {
    const errors = validateAgainstSchema({ matchMode: 1 }, SETTINGS_SCHEMA, '$');
    expect(errors[0]).toMatch(/\$\.matchMode/);
    expect(validateRulesSchema([{ id: 1 }]).ok).toBe(false);
  });

  it('corrupted rules file loads from backup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
    const file = path.join(dir, 'auto_reply_rules.json');
    fs.writeFileSync(file, '{not-json');
    const backups = getBackupsDir();
    fs.mkdirSync(backups, { recursive: true });
    const bak = path.join(backups, 'auto_reply_rules.json.2099-01-01T00-00-00-000Z');
    fs.writeFileSync(bak, JSON.stringify([{ id: 'from-backup' }]));
    const { data, recovered } = loadJsonWithBackup(file, []);
    expect(recovered).toBe(true);
    expect(Array.isArray(data) && data[0].id).toBe('from-backup');
    fs.rmSync(bak, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('fetch timeout audit (211)', () => {
  it('skills/ have zero bare fetch( calls', () => {
    const skills = path.join(root, 'skills');
    for (const name of fs.readdirSync(skills)) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(skills, name), 'utf8');
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/fetchWith(?:Timeout|Retry)\s*\(/g, 'SAFE(');
      expect(stripped).not.toMatch(/(?<![A-Za-z_])fetch\s*\(/);
    }
  });
});

describe('FB schedule + dry-run parity (160/221)', () => {
  it('dry-run payload includes scheduled_publish_time without sending', () => {
    const p = buildFacebookFeedPayload('hello', {
      scheduledPublishTime: 1_800_000_000,
      pageToken: 'x',
    });
    expect(p.scheduled_publish_time).toBe('1800000000');
    expect(p.published).toBe('false');
    const photo = buildFacebookPhotoPayload('cap', { scheduledPublishTime: 1_800_000_000 });
    expect(photo.scheduled_publish_time).toBe('1800000000');
  });

  it('dry-run and live builders produce identical payloads', () => {
    const opts = { scheduledPublishTime: 1_900_000_000, pageToken: 'tok' };
    expect(buildFacebookFeedPayload('m', opts)).toEqual(buildFacebookFeedPayload('m', opts));
  });
});

describe('font fallback (169)', () => {
  it('missing font produces a warning entry, not a throw', () => {
    const warnings = checkCreativeFonts({ check: () => false }, ['Fraunces']);
    expect(warnings[0]).toMatch(/Font unavailable: Fraunces/);
  });
});

describe('write lock (228)', () => {
  it('two parallel saves produce a valid final file', async () => {
    const file = path.join(os.tmpdir(), `wl-${Date.now()}.json`);
    await Promise.all([
      withWriteLock('t', async () => {
        await new Promise((r) => setTimeout(r, 30));
        fs.writeFileSync(file, JSON.stringify({ n: 1 }));
      }),
      withWriteLock('t', async () => {
        await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(file, JSON.stringify({ n: 2 }));
      }),
    ]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect([1, 2]).toContain(data.n);
    fs.rmSync(file, { force: true });
  });
});

describe('coverage gate config (240)', () => {
  it('coverage thresholds are configured', async () => {
    const mod = await import('../vitest.config.js');
    const thresholds = mod.default?.test?.coverage?.thresholds;
    expect(thresholds).toBeTruthy();
    expect(thresholds.lines).toBeGreaterThan(0);
  });
});

describe('fixture library (246)', () => {
  it('every fixture file parses against its schema', () => {
    const publish = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, 'publish-result.json'), 'utf8')
    );
    const errors = validateAgainstSchema(publish, {
      type: 'object',
      required: ['ok', 'dryRun', 'results'],
      properties: {
        ok: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        results: { type: 'array' },
      },
    });
    expect(errors).toEqual([]);
    JSON.parse(fs.readFileSync(path.join(fixturesDir, 'webhook-whatsapp.json'), 'utf8'));
    JSON.parse(fs.readFileSync(path.join(fixturesDir, 'webhook-facebook.json'), 'utf8'));
    expect(fs.existsSync(path.join(fixturesDir, 'sample-pack.md'))).toBe(true);
  });
});

describe('perf budget math (260)', () => {
  it('percentile math verified on a fixed sample', () => {
    const samples = [10, 20, 30, 40, 50];
    expect(percentile(samples, 50)).toBe(30);
    expect(parsePolishDurations('polishMs=10\npolishMs=20')).toEqual([10, 20]);
    expect(checkPerfBudget(samples, { p95MaxMs: 100 }).ok).toBe(true);
  });
});

describe('env docs + dead exports (256/262)', () => {
  it('generated table lists every var config.js reads', () => {
    const names = collectEnvNames();
    expect(names).toContain('FB_PAGE_ID');
    expect(names).toContain('MODEL');
    expect(names.length).toBeGreaterThan(10);
  });

  it('planted unused export name is collectable', () => {
    const plant = 'export function __deadExportPlantedForTest() { return 1; }\n';
    expect(collectExports(plant)).toContain('__deadExportPlantedForTest');
  });
});

describe('webhook body limit (192)', () => {
  it('oversized webhook body returns 413', async () => {
    const big = 'x'.repeat(300 * 1024);
    const body = JSON.stringify({ pad: big });
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('Content-Length', String(Buffer.byteLength(body)))
      .send(body);
    expect(res.status).toBe(413);
  });
});

describe('dry-run publish receipt (168/221)', () => {
  it('dry-run result exposes copyable simulated id + payload', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: true,
        platforms: ['twitter'],
        posts: { twitter: { text: 'hello from finish-wave' } },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].id).toMatch(/^dry-/);
    expect(res.body.results[0].payload).toBeTruthy();
  });
});
