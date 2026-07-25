import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app } from '../server/index.js';
import { resetEngineState, paths, saveRules, saveSettings } from '../skills/auto_reply.js';
import { config } from '../config/config.js';

const FAKE_SECRETS = [
  process.env.FB_PAGE_TOKEN,
  process.env.TWITTER_OAUTH2_ACCESS_TOKEN,
  process.env.LINKEDIN_ACCESS_TOKEN,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REFRESH_TOKEN,
  process.env.WHATSAPP_ACCESS_TOKEN,
];

const BASE_RULE = {
  id: 'api-rule',
  name: 'API rule',
  enabled: true,
  platform: 'whatsapp',
  pattern: 'hello\\s+(internship)',
  flags: 'i',
  reply: 'Hi about $1!',
  cooldownSec: 0,
  scope: 'any',
  priority: 1,
};

beforeEach(() => {
  resetEngineState();
  for (const p of [
    paths.RULES_PATH,
    paths.SETTINGS_PATH,
    paths.LOG_PATH,
    paths.DLQ_PATH,
    paths.APPROVALS_PATH,
  ]) {
    fs.rmSync(p, { force: true });
  }
  fs.rmSync(paths.HISTORY_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/health', () => {
  it('returns status without requiring a live Ollama', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ollama.ok).toBe(false); // unreachable in tests by design
    expect(res.body.platforms.facebook.configured).toBe(true);
    expect(res.body.autoReply).toBeTruthy();
  }, 20000);

  it('never leaks secret values in health or error payloads', async () => {
    const health = await request(app).get('/api/health');
    const healthText = JSON.stringify(health.body);
    const err = await request(app).post('/api/polish').send({});
    const errText = JSON.stringify(err.body);
    expect(err.status).toBe(400);
    for (const secret of FAKE_SECRETS) {
      expect(secret).toBeTruthy(); // sanity: fakes are set
      expect(healthText).not.toContain(secret);
      expect(errText).not.toContain(secret);
    }
  }, 20000);
});

describe('POST /api/publish (dry-run only)', () => {
  it('previews all selected platforms without sending', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: true,
        platforms: ['facebook', 'twitter', 'whatsapp'],
        posts: {
          facebook: { text: 'FB body' },
          twitter: { text: 'tweet body' },
          whatsapp: { text: 'wa body' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results.every((r) => String(r.id).startsWith('dry'))).toBe(true);
  });

  it('flags missing platform text in dry-run', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({ dryRun: true, platforms: ['twitter'], posts: { twitter: { text: '' } } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0].error).toMatch(/Missing Twitter text/);
  });

  it('rejects empty platform selection', async () => {
    const res = await request(app).post('/api/publish').send({ dryRun: true, platforms: [] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/upload validation', () => {
  it('rejects a missing file', async () => {
    const res = await request(app).post('/api/upload');
    expect(res.status).toBe(400);
  });

  it('rejects files whose bytes are not a real image (magic sniff)', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('image', Buffer.from('this is definitely not a png'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a valid PNG/i);
  });

  it('rejects disallowed mime types', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('image', Buffer.from('GIF89a'), { filename: 'x.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
  });

  it('accepts a real PNG header and serves it back', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 1),
    ]);
    const res = await request(app)
      .post('/api/upload')
      .attach('image', png, { filename: 'ok.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.uploadId).toMatch(/\.png$/);
    // cleanup the real uploads dir
    fs.rmSync(path.join(config.rootDir, 'output', 'uploads', res.body.uploadId), { force: true });
  });
});

describe('auto-reply rules CRUD + test endpoint', () => {
  it('GET returns rules and settings', async () => {
    const res = await request(app).get('/api/auto-reply/rules');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rules)).toBe(true);
    expect(res.body.settings.matchMode).toBeTruthy();
  });

  it('PUT saves valid rules and rejects invalid ones', async () => {
    const ok = await request(app)
      .put('/api/auto-reply/rules')
      .send({ rules: [BASE_RULE] });
    expect(ok.status).toBe(200);
    expect(ok.body.rules[0].id).toBe('api-rule');

    const bad = await request(app)
      .put('/api/auto-reply/rules')
      .send({ rules: [{ ...BASE_RULE, pattern: '(a+)+' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/catastrophic|nested/i);
  });

  it('POST /api/auto-reply/test dry-runs matches with no send', async () => {
    saveRules([BASE_RULE]);
    const res = await request(app)
      .post('/api/auto-reply/test')
      .send({ text: 'hello internship', platform: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].sent).toBe(false);
    expect(res.body.matches[0].reply).toMatch(/internship/i);
  });
});

describe('webhook signature (82) + verify handshake', () => {
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.sig1',
                  from: '15551234567',
                  type: 'text',
                  text: { body: 'hello internship' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it('GET verify echoes challenge for the right token', async () => {
    const ok = await request(app).get('/api/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': '12345',
    });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await request(app).get('/api/webhooks/whatsapp').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '12345',
    });
    expect(bad.status).toBe(403);
  });

  it('rejects bad X-Hub-Signature-256 with 401 when secret configured', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', 'test-app-secret');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(payload);
    expect(res.status).toBe(401);

    const missing = await request(app).post('/api/webhooks/whatsapp').send(payload);
    expect(missing.status).toBe(401);
  });

  it('accepts a valid signature and processes messages (dry-run)', async () => {
    vi.stubEnv('WHATSAPP_APP_SECRET', 'test-app-secret');
    saveRules([BASE_RULE]);
    const body = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', 'test-app-secret').update(body).digest('hex');
    const res = await request(app)
      .post('/api/webhooks/whatsapp')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', `sha256=${sig}`)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.processed).toHaveLength(1);
    expect(res.body.processed[0].sent).toBe(false); // not armed
  });

  it('skips verification with a warning when no secret configured', async () => {
    const res = await request(app).post('/api/webhooks/whatsapp').send({ entry: [] });
    expect(res.status).toBe(200);
  });
});

describe('wave-2 endpoints', () => {
  it('GET /api/auto-reply/stats exposes counters and queue depths', async () => {
    const res = await request(app).get('/api/auto-reply/stats');
    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveProperty('inbound');
    expect(res.body.platformFlags.whatsapp).toBe(true);
  });

  it('POST /api/auto-reply/rules/bulk toggles rules (87)', async () => {
    saveRules([BASE_RULE, { ...BASE_RULE, id: 'second' }]);
    const res = await request(app)
      .post('/api/auto-reply/rules/bulk')
      .send({ ids: ['api-rule', 'second'], enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(2);
    expect(res.body.rules.every((r) => r.enabled === false)).toBe(true);
  });

  it('POST /api/auto-reply/rules/diff previews import changes (88)', async () => {
    saveRules([BASE_RULE]);
    const res = await request(app)
      .post('/api/auto-reply/rules/diff')
      .send({
        rules: [
          { ...BASE_RULE, reply: 'new reply' },
          { ...BASE_RULE, id: 'added' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('api-rule');
    expect(res.body.added).toContain('added');
  });

  it('POST /api/auto-reply/explain describes a pattern (89)', async () => {
    const ok = await request(app)
      .post('/api/auto-reply/explain')
      .send({ pattern: 'hi (?<name>\\w+)', flags: 'i', sampleText: 'hi Asha' });
    expect(ok.status).toBe(200);
    expect(ok.body.groupCount).toBe(1);
    expect(ok.body.sample.groups.name).toBe('Asha');
    const bad = await request(app).post('/api/auto-reply/explain').send({ pattern: '(a+)+' });
    expect(bad.status).toBe(400);
  });

  it('takeover endpoints set and clear a chat pause (76)', async () => {
    const on = await request(app)
      .post('/api/auto-reply/takeover')
      .send({ platform: 'whatsapp', from: '15551234567', active: true });
    expect(on.status).toBe(200);
    expect(on.body.takeovers['whatsapp:15551234567'].active).toBe(true);
    const off = await request(app)
      .post('/api/auto-reply/takeover')
      .send({ platform: 'whatsapp', from: '15551234567', active: false });
    expect(off.body.takeovers['whatsapp:15551234567']).toBeUndefined();
  });

  it('approvals endpoints list and reject queued replies (92)', async () => {
    vi.stubEnv('AUTO_REPLY_ENABLED', 'true');
    saveRules([BASE_RULE]);
    saveSettings({ approvalRequired: true });
    await request(app)
      .post('/api/auto-reply/test')
      .send({ text: 'hello internship', platform: 'whatsapp', dryRun: false, from: '15551230000' });
    const list = await request(app).get('/api/auto-reply/approvals');
    expect(list.body.approvals.length).toBeGreaterThanOrEqual(1);
    const id = list.body.approvals[0].id;
    const rejected = await request(app)
      .post(`/api/auto-reply/approvals/${id}`)
      .send({ action: 'reject' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.entry.status).toBe('rejected');
  });

  it('GET /api/auto-reply/log.csv returns CSV (94)', async () => {
    const res = await request(app).get('/api/auto-reply/log.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toContain('ts,platform,from');
  });

  it('POST /api/auto-reply/simulate replays an inbox dry-run (100)', async () => {
    saveRules([BASE_RULE]);
    const res = await request(app)
      .post('/api/auto-reply/simulate')
      .send({
        messages: [
          { from: 'a', text: 'hello internship' },
          { from: 'b', text: 'nope' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.matched).toBe(1);
    const empty = await request(app).post('/api/auto-reply/simulate').send({});
    expect(empty.status).toBe(400);
  });

  it('GET /api/auto-reply/history lists snapshots (95)', async () => {
    saveRules([BASE_RULE]);
    saveRules([{ ...BASE_RULE, reply: 'v2' }]);
    const res = await request(app).get('/api/auto-reply/history');
    expect(res.status).toBe(200);
    expect(res.body.snapshots.length).toBeGreaterThanOrEqual(1);
  });
});
