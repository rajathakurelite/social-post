/**
 * Batch 2 (features 101–150) server integration tests.
 * Ollama and all platform publishers are mocked — no network, ever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

// The global test setup pins DRY_RUN=true; this file needs config.dryRun=false so
// the per-platform dry-run matrix (feature 148) can exercise a mocked live path.
vi.mock('../config/config.js', async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, config: { ...mod.config, dryRun: false } };
});

vi.mock('../skills/generate_post.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    generateMultiPlatformPack: vi.fn(async () => ({
      facebook: 'FB copy — visit https://airepro.in/view/internships',
      twitter: 'Tweet copy https://airepro.in/',
      linkedin: 'LinkedIn copy https://airepro.in/',
      linkedinComment: 'Suggested first comment https://airepro.in/view/internships',
      youtubeTitle: 'Mock title',
      youtubeDescription: 'Mock description https://airepro.in/',
      whatsapp: 'WA copy https://airepro.in/',
      facebookCreative: null,
    })),
    generatePost: vi.fn(async (topic, { platform } = {}) =>
      platform === 'youtube'
        ? 'TITLE: Mock yt title\nDESCRIPTION: Mock yt description https://airepro.in/'
        : `Regenerated ${platform} copy https://airepro.in/`
    ),
  };
});
vi.mock('../skills/post_twitter.js', () => ({ postToTwitter: vi.fn(async () => 'tw-live-1') }));
vi.mock('../skills/post_linkedin.js', () => ({ postToLinkedIn: vi.fn(async () => 'li-live-1') }));
vi.mock('../skills/post_whatsapp.js', () => ({
  postToWhatsApp: vi.fn(async () => 'wamid.live-1'),
}));
vi.mock('../skills/post_youtube.js', () => ({ postToYouTube: vi.fn(async () => 'yt-live-1') }));
vi.mock('../skills/post_facebook.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    postToFacebook: vi.fn(async () => 'fb-live-1'),
    postPhotoToFacebook: vi.fn(async () => 'fb-photo-1'),
    sendMessengerReply: vi.fn(async () => 'mid.1'),
  };
});

import { app } from '../server/index.js';
import { config } from '../config/config.js';
import {
  buildMultiPlatformPrompt,
  parseMultiPlatformOutput,
  toneDirective,
} from '../skills/generate_post.js';
import {
  CREATIVE_THEMES,
  CREATIVE_TEMPLATES,
  resolveCreativeStyle,
} from '../skills/render_creative.js';
import { publishLogPath, readPublishHistory } from '../skills/publish_history.js';
import { utmSettingsPath, saveUtmSettings } from '../skills/utm_store.js';

const REAL_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

beforeEach(() => {
  fs.rmSync(publishLogPath, { force: true });
  fs.rmSync(utmSettingsPath, { force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('feature 101 — publish history JSONL', () => {
  it('appends one valid JSON line per publish (topic, platforms, dryRun, results)', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: true,
        topic: 'History test topic',
        platforms: ['twitter'],
        posts: { twitter: { text: 'tweet body' } },
      });
    expect(res.status).toBe(200);
    const lines = fs.readFileSync(publishLogPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.topic).toBe('History test topic');
    expect(entry.platforms).toEqual(['twitter']);
    expect(entry.dryRun).toBe(true);
    expect(entry.results[0].platform).toBe('twitter');
    expect(readPublishHistory(5)).toHaveLength(1);
  });
});

describe('feature 108 — regenerate one platform', () => {
  it('returns only the requested platform key', async () => {
    const res = await request(app)
      .post('/api/polish')
      .send({ topic: 'single regen', only: 'twitter' });
    expect(res.status).toBe(200);
    expect(res.body.only).toBe('twitter');
    expect(Object.keys(res.body.posts)).toEqual(['twitter']);
    expect(res.body.posts.twitter.text).toMatch(/Regenerated twitter/);
  });

  it('parses youtube title/description on single regen', async () => {
    const res = await request(app)
      .post('/api/polish')
      .send({ topic: 'single regen', only: 'youtube' });
    expect(res.status).toBe(200);
    expect(res.body.posts.youtube.title).toBe('Mock yt title');
    expect(res.body.posts.youtube.description).toMatch(/Mock yt description/);
    // Feature 124: polish emits an editable tag list capped at 500 chars.
    expect(typeof res.body.posts.youtube.tags).toBe('string');
    expect(res.body.posts.youtube.tags.length).toBeGreaterThan(0);
    expect(res.body.posts.youtube.tags.length).toBeLessThanOrEqual(500);
  });

  it('rejects unknown platforms', async () => {
    const res = await request(app).post('/api/polish').send({ topic: 'x', only: 'myspace' });
    expect(res.status).toBe(400);
  });
});

describe('features 112/113 — UTM helper applied at polish', () => {
  it('polish output contains utm params when enabled', async () => {
    saveUtmSettings({ enabled: true, campaign: 'Summer Drive' });
    const res = await request(app)
      .post('/api/polish')
      .send({ topic: 'utm test', platforms: ['twitter', 'linkedin'] });
    expect(res.status).toBe(200);
    expect(res.body.posts.twitter.text).toContain('utm_source=twitter');
    expect(res.body.posts.twitter.text).toContain('utm_campaign=summer-drive');
    expect(res.body.posts.linkedin.text).toContain('utm_source=linkedin');
  });

  it('leaves links untouched when disabled', async () => {
    const res = await request(app)
      .post('/api/polish')
      .send({ topic: 'utm off', platforms: ['twitter'] });
    expect(res.status).toBe(200);
    expect(res.body.posts.twitter.text).not.toContain('utm_source');
  });
});

describe('feature 114 — brand voice tone directive', () => {
  it('prompt contains the selected tone directive', () => {
    expect(buildMultiPlatformPrompt('topic', { tone: 'formal' })).toContain(
      toneDirective('formal')
    );
    expect(buildMultiPlatformPrompt('topic', { tone: 'playful' })).toContain(
      toneDirective('playful')
    );
    expect(toneDirective('formal')).toMatch(/formal/i);
    expect(buildMultiPlatformPrompt('topic', {})).not.toContain('Tone directive');
  });
});

describe('feature 116 — pin dry-run', () => {
  it('publish with dryRun:false returns 403 when pinned', async () => {
    vi.stubEnv('UI_FORCE_DRY_RUN', 'true');
    const res = await request(app)
      .post('/api/publish')
      .send({ dryRun: false, platforms: ['twitter'], posts: { twitter: { text: 'x' } } });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/pinned/i);
  });

  it('health exposes the forceDryRun flag', async () => {
    vi.stubEnv('UI_FORCE_DRY_RUN', 'true');
    const res = await request(app).get('/api/health');
    expect(res.body.forceDryRun).toBe(true);
  }, 20000);
});

describe('features 117/118 — creative templates and themes', () => {
  it('exposes 3 templates and resolves unknown styles to defaults', () => {
    expect(CREATIVE_TEMPLATES).toEqual(['classic', 'poster', 'minimal']);
    expect(resolveCreativeStyle({ template: 'bogus', theme: 'nope' })).toEqual({
      template: 'classic',
      theme: 'magenta',
    });
    expect(resolveCreativeStyle({ template: 'POSTER', theme: 'Dark' })).toEqual({
      template: 'poster',
      theme: 'dark',
    });
  });

  it('every theme token resolves with no undefined colors', () => {
    for (const [name, vars] of Object.entries(CREATIVE_THEMES)) {
      for (const [token, value] of Object.entries(vars)) {
        expect(typeof value, `${name}.${token}`).toBe('string');
        expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('feature 119 — LinkedIn first-comment stub', () => {
  it('pack parser extracts the comment section when present', () => {
    const raw = [
      '===LINKEDIN===',
      'Main post body',
      '===LINKEDIN_COMMENT===',
      'Here is the suggested first comment with https://airepro.in/',
      '===TWITTER===',
      'tweet',
    ].join('\n');
    const sections = parseMultiPlatformOutput(raw);
    expect(sections.linkedin_comment).toMatch(/suggested first comment/);
  });

  it('prompt requests the first-comment section and polish returns it copy-only', async () => {
    expect(buildMultiPlatformPrompt('t')).toContain('===LINKEDIN_COMMENT===');
    const res = await request(app)
      .post('/api/polish')
      .send({ topic: 'comment test', platforms: ['linkedin'] });
    expect(res.status).toBe(200);
    expect(res.body.posts.linkedin.firstComment).toMatch(/first comment/i);
  });
});

describe('feature 120 — WhatsApp template flag', () => {
  it('template publish without templateName returns 400', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: true,
        platforms: ['whatsapp'],
        posts: { whatsapp: { text: 'hello', messageType: 'template' } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/templateName/);
  });

  it('template publish with a name passes and echoes it in the dry-run result', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: true,
        platforms: ['whatsapp'],
        posts: {
          whatsapp: { text: 'hello', messageType: 'template', templateName: 'welcome_v1' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].templateName).toBe('welcome_v1');
    expect(res.body.results[0].messageType).toBe('template');
  });
});

describe('feature 125 — chosen creative variant lands in the publish payload', () => {
  it('dry-run publish echoes the chosen variant creativePath', async () => {
    const creativesDir = path.join(config.rootDir, 'output', 'creatives');
    fs.mkdirSync(creativesDir, { recursive: true });
    const chosen = path.join(creativesDir, 'variant-b-test.png');
    fs.writeFileSync(chosen, REAL_PNG);
    try {
      const res = await request(app)
        .post('/api/publish')
        .send({
          dryRun: true,
          platforms: ['facebook'],
          posts: { facebook: { text: 'fb', creativePath: chosen } },
        });
      expect(res.status).toBe(200);
      expect(res.body.results[0].creativePath).toContain('variant-b-test.png');
      expect(res.body.results[0].imageSource).toBe('creative');
    } finally {
      fs.rmSync(chosen, { force: true });
    }
  });
});

describe('features 126/136 — alt text metadata + multi-image upload', () => {
  it('upload metadata round-trips the alt text', async () => {
    const up = await request(app)
      .post('/api/upload')
      .field('altText', 'Students exploring internships')
      .attach('image', REAL_PNG, { filename: 'alt.png', contentType: 'image/png' });
    expect(up.status).toBe(200);
    expect(up.body.altText).toBe('Students exploring internships');

    const meta = await request(app).get(`/api/uploads/${up.body.uploadId}/meta`);
    expect(meta.status).toBe(200);
    expect(meta.body.meta.altText).toBe('Students exploring internships');

    const put = await request(app)
      .put(`/api/uploads/${up.body.uploadId}/meta`)
      .send({ altText: 'Edited alt' });
    expect(put.body.meta.altText).toBe('Edited alt');

    const uploadsDir = path.join(config.rootDir, 'output', 'uploads');
    fs.rmSync(path.join(uploadsDir, up.body.uploadId), { force: true });
    fs.rmSync(path.join(uploadsDir, `${up.body.uploadId}.meta.json`), { force: true });
  });

  it('accepts up to 4 images and rejects a 5th', async () => {
    let req4 = request(app).post('/api/upload');
    for (let i = 0; i < 4; i++) {
      req4 = req4.attach('image', REAL_PNG, { filename: `m${i}.png`, contentType: 'image/png' });
    }
    const ok = await req4;
    expect(ok.status).toBe(200);
    expect(ok.body.uploads).toHaveLength(4);

    let req5 = request(app).post('/api/upload');
    for (let i = 0; i < 5; i++) {
      req5 = req5.attach('image', REAL_PNG, { filename: `n${i}.png`, contentType: 'image/png' });
    }
    const bad = await req5;
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Up to 4 images/);

    const uploadsDir = path.join(config.rootDir, 'output', 'uploads');
    for (const u of ok.body.uploads) {
      fs.rmSync(path.join(uploadsDir, u.uploadId), { force: true });
      fs.rmSync(path.join(uploadsDir, `${u.uploadId}.meta.json`), { force: true });
    }
  });
});

describe('feature 148 — per-platform dry-run', () => {
  it('mixed request returns per-platform dryRun flags in results', async () => {
    const res = await request(app)
      .post('/api/publish')
      .send({
        dryRun: false,
        platforms: ['twitter', 'whatsapp'],
        dryRunByPlatform: { twitter: true },
        posts: { twitter: { text: 'tweet' }, whatsapp: { text: 'wa msg' } },
      });
    expect(res.status).toBe(200);
    expect(res.body.mixed).toBe(true);
    const tw = res.body.results.find((r) => r.platform === 'twitter');
    const wa = res.body.results.find((r) => r.platform === 'whatsapp');
    expect(tw.dryRun).toBe(true);
    expect(tw.id).toMatch(/^dry-/);
    expect(wa.dryRun).toBe(false);
    expect(wa.id).toBe('wamid.live-1');
  });
});
