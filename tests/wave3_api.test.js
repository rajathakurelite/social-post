/**
 * API tests for the Wave-3 router (features 102, 104, 110, 113, 115, 130–135)
 * mounted on a bare Express app — no main server, no network, no Ollama.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import { createWave3Router } from '../server/wave3.js';
import { publishLogPath, appendPublishLog } from '../skills/publish_history.js';
import { schedulePath } from '../skills/schedule_store.js';
import { draftsPath } from '../skills/drafts_store.js';
import { utmSettingsPath } from '../skills/utm_store.js';
import { slugify } from '../skills/compose_tools.js';

const PLATFORMS = ['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp'];

const app = express();
app.use(express.json());
app.use(createWave3Router());

beforeEach(() => {
  for (const p of [publishLogPath, schedulePath, draftsPath, utmSettingsPath]) {
    fs.rmSync(p, { force: true });
  }
});

describe('GET /api/publish/history (102)', () => {
  it('returns ok with an empty history file', async () => {
    const res = await request(app).get('/api/publish/history');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toEqual([]);
  });

  it('rejects a non-numeric limit with 400', async () => {
    const res = await request(app).get('/api/publish/history?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('limit must be a positive integer');
  });
});

describe('POST /api/schedule (104)', () => {
  it('saves a future schedule with dryRun forced true', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .send({
        topic: 'Scheduled topic',
        platforms: ['facebook'],
        posts: { facebook: { text: 'body' } },
        fireAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        dryRun: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.schedule.dryRun).toBe(true);
  });

  it('rejects a past fireAt with 400', async () => {
    const res = await request(app)
      .post('/api/schedule')
      .send({
        topic: 'Too late',
        platforms: ['facebook'],
        posts: {},
        fireAt: new Date(Date.now() - 60 * 1000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('GET /api/compose/best-times (135)', () => {
  it('has a hint entry for all five platforms', async () => {
    const res = await request(app).get('/api/compose/best-times');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const hints = res.body.hints;
    const keys = Array.isArray(hints)
      ? hints.map((h) => h.platform || h.id)
      : Object.keys(hints || {});
    for (const platform of PLATFORMS) {
      expect(keys).toContain(platform);
    }
  });
});

describe('GET /api/compose/hashtag-packs (110)', () => {
  it('returns a packs array with ids', async () => {
    const res = await request(app).get('/api/compose/hashtag-packs');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.packs)).toBe(true);
    expect(res.body.packs.length).toBeGreaterThan(0);
    for (const pack of res.body.packs) {
      expect(pack.id).toBeTruthy();
    }
  });
});

describe('UTM settings (113)', () => {
  it('PUT then GET round-trips settings with a slugified campaign', async () => {
    const put = await request(app)
      .put('/api/compose/utm')
      .send({ enabled: true, campaign: 'Summer Drive 2026' });
    expect(put.status).toBe(200);
    expect(put.body.settings.enabled).toBe(true);
    expect(put.body.settings.campaign).toBe(slugify('Summer Drive 2026'));

    const get = await request(app).get('/api/compose/utm');
    expect(get.status).toBe(200);
    expect(get.body.settings).toEqual(put.body.settings);
  });
});

describe('POST /api/compose/duplicate-check (115)', () => {
  it('rejects a missing topic with 400', async () => {
    const res = await request(app).post('/api/compose/duplicate-check').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('finds a logged duplicate topic', async () => {
    appendPublishLog({
      topic: 'dream internship',
      platforms: ['facebook'],
      dryRun: true,
      results: {},
    });
    const res = await request(app)
      .post('/api/compose/duplicate-check')
      .send({ topic: 'Dream  internship!' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.duplicate).toBeTruthy();
    expect(res.body.duplicate.topic).toBe('dream internship');
  });
});

describe('drafts API (130, 131)', () => {
  const draft = { topic: 'Saved draft', posts: { facebook: { text: 'body' } } };

  it('saves, lists, fetches, and 409s on duplicate names', async () => {
    const created = await request(app).post('/api/drafts').send({ name: 'launch-week', draft });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(created.body.entry.name).toBe('launch-week');

    const dup = await request(app).post('/api/drafts').send({ name: 'Launch-Week', draft });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already exists/);

    const list = await request(app).get('/api/drafts');
    expect(list.status).toBe(200);
    expect(list.body.drafts).toHaveLength(1);
    expect(list.body.drafts[0].draft).toBeUndefined();

    const get = await request(app).get('/api/drafts/launch-week');
    expect(get.status).toBe(200);
    expect(get.body.entry.draft).toEqual(draft);

    const missing = await request(app).get('/api/drafts/nope');
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/compose/topic-chips (132)', () => {
  it('returns chips derived from the brand brief without Ollama', async () => {
    const res = await request(app).get('/api/compose/topic-chips');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.chips)).toBe(true);
    // The real airepro brand brief has qualifying headings/bullets.
    expect(res.body.chips.length).toBeGreaterThan(0);
    for (const chip of res.body.chips) {
      expect(chip.length).toBeGreaterThanOrEqual(15);
      expect(chip.length).toBeLessThanOrEqual(80);
    }
  });
});
