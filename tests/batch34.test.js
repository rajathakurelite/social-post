/**
 * Batch 3–4 unit/API tests (features 151–270 slice).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  markdownToPack,
  packToMarkdown,
  wordDiff,
  insertSnippet,
  languageDirective,
  lengthPresetTargets,
  expandBroadcastList,
  buildTwitterMediaPayload,
  buildLinkedInDocumentPayload,
  platformDisabledReason,
  applyComposePreset,
} from '../skills/compose_tools.js';
import {
  reportParseFallbacks,
  brandContextBlock,
  isMockOllama,
  mockMultiPlatformPack,
} from '../skills/generate_post.js';
import { ApiError, isKnownErrorCode, mapTokenExpiry, ERROR_CODES } from '../utils/errors.js';
import { createCircuitBreaker } from '../utils/circuit_breaker.js';
import { withRetry, bumpRetryCount, getRetryCounts, _resetRetryCounts } from '../utils/retry.js';
import { appendJsonl, loadRotationSettings } from '../utils/jsonl.js';
import { setClock, resetClock, now, advance } from '../utils/clock.js';
import { redactTokens } from '../utils/logger.js';
import { parseWeeklyPlanAngles } from '../server/wave3.js';
import { aggregatePublishStats, csvEscape, publishHistoryToCsv } from '../server/ops.js';
import {
  computeHealthStatus,
  pushHealthSnapshot,
  getHealthHistory,
  _resetHealthRing,
} from '../server/health_util.js';
import { assertBindHost, formatListenError, API_VERSION } from '../server/middleware.js';
import { app } from '../server/index.js';
import { pauseOutbound, resumeOutbound, isPaused } from '../utils/ops_state.js';

describe('markdownToPack / packToMarkdown (151)', () => {
  it('round-trips losslessly for core platforms', () => {
    const md = packToMarkdown({
      topic: 'July Drive',
      platforms: ['twitter', 'linkedin', 'youtube'],
      posts: {
        twitter: { text: 'Hello X' },
        linkedin: { text: 'Hello LI' },
        youtube: { title: 'Title', description: 'Desc line' },
      },
    });
    const pack = markdownToPack(md);
    expect(pack.topic).toBe('July Drive');
    expect(pack.posts.twitter.text).toBe('Hello X');
    expect(pack.posts.linkedin.text).toBe('Hello LI');
    expect(pack.posts.youtube.title).toBe('Title');
    expect(pack.posts.youtube.description).toBe('Desc line');
  });
});

describe('insertSnippet (152)', () => {
  it('respects twitter cap', () => {
    const base = 'x'.repeat(270);
    const out = insertSnippet(base, ' #toolonghashtag', 270, 'twitter');
    expect(out.text.length).toBeLessThanOrEqual(280);
    expect(out.truncated).toBe(true);
  });
});

describe('wordDiff (156)', () => {
  it('marks insertions and deletions', () => {
    const parts = wordDiff('hello world', 'hello there');
    expect(parts.some((p) => p.type === 'delete' && p.value === 'world')).toBe(true);
    expect(parts.some((p) => p.type === 'insert' && p.value === 'there')).toBe(true);
  });
});

describe('language + length directives (163/164)', () => {
  it('prompt contains selected language directive', () => {
    const block = brandContextBlock('topic', { language: 'hinglish', length: 'short' });
    expect(block).toContain('Hinglish');
    expect(block).toContain(lengthPresetTargets('short').linkedin);
  });
  it('languageDirective hindi', () => {
    expect(languageDirective('hi')).toMatch(/Hindi/i);
  });
});

describe('reportParseFallbacks (158)', () => {
  it('marks facebook when FB_HEADLINE missing', () => {
    expect(reportParseFallbacks({}, { visual: true })).toContain('facebook');
  });
});

describe('broadcast expand (159)', () => {
  it('dry-run never needs fetch and reports count', () => {
    const out = expandBroadcastList(
      { recipients: ['1', '2', '3'], armed: false },
      { dryRun: true }
    );
    expect(out.wouldSendCount).toBe(3);
    expect(out.blocked).toBe(false);
  });
});

describe('payload stubs (161/162)', () => {
  it('twitter builder includes alt text', () => {
    expect(buildTwitterMediaPayload({ text: 'hi', altText: 'alt' }).media_alt_text).toBe('alt');
  });
  it('linkedin document payload shape', () => {
    const p = buildLinkedInDocumentPayload({ text: 'c', pdfName: 'deck.pdf' });
    expect(p.content.media.title).toBe('deck.pdf');
    expect(p.dryRun).toBe(true);
  });
});

describe('platformDisabledReason (167)', () => {
  it('differs for disabled vs unconfigured', () => {
    expect(platformDisabledReason({ enabled: false, configured: true })).toMatch(/Disabled/i);
    expect(platformDisabledReason({ enabled: true, configured: false })).toMatch(/credentials/i);
  });
});

describe('applyComposePreset (170)', () => {
  it('overwrites only bundled fields', () => {
    const next = applyComposePreset(
      { platforms: ['twitter'], tone: 'neutral', length: 'medium', extra: 1 },
      { platforms: ['linkedin'], tone: 'formal' }
    );
    expect(next.platforms).toEqual(['linkedin']);
    expect(next.tone).toBe('formal');
    expect(next.length).toBe('medium');
    expect(next.extra).toBe(1);
  });
});

describe('weekly plan parser (166)', () => {
  it('yields exactly 7 non-empty angles', () => {
    const angles = parseWeeklyPlanAngles('1. a\n2. b\n3. c');
    expect(angles).toHaveLength(7);
    expect(angles.every((a) => a.trim())).toBe(true);
  });
});

describe('ApiError taxonomy (212)', () => {
  it('every thrown ApiError carries a known code', () => {
    for (const code of ERROR_CODES) {
      const err = new ApiError('x', { code });
      expect(isKnownErrorCode(err.code)).toBe(true);
    }
  });
  it('maps FB 190 to FB_TOKEN_EXPIRED', () => {
    expect(mapTokenExpiry('facebook', { error: { code: 190 } })?.code).toBe('FB_TOKEN_EXPIRED');
  });
});

describe('circuit breaker (174)', () => {
  it('opens after threshold and half-opens after cooldown', () => {
    const source = { t: 1000 };
    const b = createCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => source.t,
    });
    b.recordFailure();
    b.recordFailure();
    expect(b.snapshot().state).toBe('open');
    expect(() => b.beforeCall()).toThrow(/Circuit open/);
    source.t += 150;
    b.beforeCall();
    expect(b.snapshot().state).toBe('half-open');
  });
});

describe('withRetry (176/177)', () => {
  afterEach(() => _resetRetryCounts());
  it('stops after max attempts and preserves last error', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new Error(`fail-${n}`);
        },
        { maxAttempts: 3, sleep: async () => {}, shouldRetry: () => true, platform: 'twitter' }
      )
    ).rejects.toThrow('fail-3');
    expect(getRetryCounts().twitter).toBe(2);
  });
  it('bump increments', () => {
    bumpRetryCount('twitter', 2);
    expect(getRetryCounts().twitter).toBe(2);
  });
});

describe('jsonl rotation (185/186/215)', () => {
  it('rotates oversize and keeps valid JSON lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-'));
    const file = path.join(dir, 'log.jsonl');
    for (let i = 0; i < 20; i++) appendJsonl(file, { i }, { maxBytes: 200, keep: 2 });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(loadRotationSettings()).toHaveProperty('maxBytes');
  });
});

describe('clock (227)', () => {
  afterEach(() => resetClock());
  it('advancing fake clock works', () => {
    const source = { t: 0 };
    setClock(() => source.t);
    expect(now()).toBe(0);
    advance(source, 50);
    expect(now()).toBe(50);
  });
});

describe('logger (189/219)', () => {
  it('redacts fake tokens', () => {
    const fake = ['EAAG', '1234567890abcdef'].join('');
    expect(redactTokens(fake)).toContain('****');
  });
});

describe('health helpers (183/184)', () => {
  afterEach(() => _resetHealthRing());
  it('ollama failure yields degraded', () => {
    expect(computeHealthStatus({ ollamaOk: false })).toBe('degraded');
  });
  it('ring caps at 20', () => {
    for (let i = 0; i < 25; i++) pushHealthSnapshot({ i });
    expect(getHealthHistory()).toHaveLength(20);
  });
});

describe('bind + port errors (197/199)', () => {
  it('0.0.0.0 without flag throws', () => {
    const prev = process.env.ALLOW_NONLOCAL;
    delete process.env.ALLOW_NONLOCAL;
    expect(() => assertBindHost('0.0.0.0')).toThrow(/ALLOW_NONLOCAL/);
    if (prev != null) process.env.ALLOW_NONLOCAL = prev;
  });
  it('EADDRINUSE maps to friendly text', () => {
    expect(formatListenError({ code: 'EADDRINUSE' }, 8787)).toMatch(/port 8787 busy/);
  });
});

describe('stats/csv (242/243)', () => {
  it('aggregates mixed dry-run/live', () => {
    const stats = aggregatePublishStats([
      {
        ts: '2026-07-01T00:00:00Z',
        dryRun: true,
        results: [{ platform: 'twitter', ok: true, dryRun: true }],
      },
      {
        ts: '2026-07-01T01:00:00Z',
        dryRun: false,
        results: [{ platform: 'twitter', ok: false, dryRun: false }],
      },
    ]);
    expect(stats.total).toBe(2);
    expect(stats.byPlatform.twitter.failed).toBe(1);
  });
  it('csv quotes commas/newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    const csv = publishHistoryToCsv([
      { id: '1', ts: 't', topic: 'hi,there', dryRun: true, platforms: ['x'], results: [] },
    ]);
    expect(csv).toContain('"hi,there"');
  });
});

describe('API reliability (171/172/200/205/267)', () => {
  beforeEach(() => {
    resumeOutbound();
    delete process.env.DEMO_MODE;
  });
  afterEach(() => {
    resumeOutbound();
    delete process.env.DEMO_MODE;
  });

  it('response header and body share requestId; version header matches', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-api-version']).toBe(API_VERSION);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
    expect(res.body.version).toBe(API_VERSION);
  });

  it('bad publish body returns envelope with stable code', async () => {
    const res = await request(app).post('/api/publish').send({ platforms: [], dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION');
    expect(res.body.requestId).toBeTruthy();
  });

  it('paused publish returns 503 PAUSED', async () => {
    pauseOutbound();
    expect(isPaused()).toBe(true);
    const res = await request(app)
      .post('/api/publish')
      .send({ platforms: ['twitter'], dryRun: true, posts: { twitter: { text: 'hi' } } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAUSED');
    resumeOutbound();
  });

  it('demo mode publish returns 403 DEMO', async () => {
    process.env.DEMO_MODE = 'true';
    const res = await request(app)
      .post('/api/publish')
      .send({ platforms: ['twitter'], dryRun: true, posts: { twitter: { text: 'hi' } } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEMO');
    delete process.env.DEMO_MODE;
  });

  it('pack-import round trip', async () => {
    const md = packToMarkdown({
      topic: 'T',
      platforms: ['twitter'],
      posts: { twitter: { text: 'hi' } },
    });
    const res = await request(app).post('/api/compose/pack-import').send({ markdown: md });
    expect(res.status).toBe(200);
    expect(res.body.posts.twitter.text).toBe('hi');
  });

  it('openapi lists routes', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/health']).toBeTruthy();
    expect(res.body.paths['/api/publish']).toBeTruthy();
  });
});

describe('MOCK_OLLAMA (249)', () => {
  it('returns canned pack without fetch when mocked', () => {
    const prev = process.env.MOCK_OLLAMA;
    process.env.MOCK_OLLAMA = 'true';
    expect(isMockOllama()).toBe(true);
    const pack = mockMultiPlatformPack('Demo');
    expect(pack.mocked).toBe(true);
    expect(pack.twitter).toBeTruthy();
    if (prev == null) delete process.env.MOCK_OLLAMA;
    else process.env.MOCK_OLLAMA = prev;
  });
});
