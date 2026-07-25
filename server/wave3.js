// @ts-nocheck
/**
 * Wave-3 API router (features 102, 104, 106, 110, 113, 115, 132, 133, 134, 135).
 * Persistence/read endpoints for publish history, the schedule queue, disk
 * drafts, UTM settings, and compose config (hashtag packs, best times, lint
 * config, link slugs, topic chips). Mounted onto the main app in server/index.js.
 */
import express from 'express';
import { config } from '../config/config.js';
import { readPublishHistory, recentTopics, findDuplicateTopic } from '../skills/publish_history.js';
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  isQueueArmed,
} from '../skills/schedule_store.js';
import { listDrafts, saveDraft, getDraft, deleteDraft } from '../skills/drafts_store.js';
import { loadUtmSettings, saveUtmSettings } from '../skills/utm_store.js';
import {
  loadHashtagPacks,
  loadBestTimes,
  loadContentLintConfig,
  loadLinkSlugs,
  loadSnippets,
  loadBroadcastLists,
  loadComposePresets,
} from '../skills/compose_config.js';
import {
  markdownToPack,
  expandBroadcastList,
  applyComposePreset,
} from '../skills/compose_tools.js';
import { isMockOllama, mockMultiPlatformPack } from '../skills/generate_post.js';
import { isFeatureEnabled } from '../utils/feature_flags.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __wave3Dir = path.dirname(fileURLToPath(import.meta.url));
const contentPlanPath = path.join(__wave3Dir, '..', 'output', 'content-plan.json');

const MAX_HISTORY_LIMIT = 500;
const MAX_TOPIC_CHIPS = 12;
const CHIP_MIN_LEN = 15;
const CHIP_MAX_LEN = 80;

/**
 * Feature 132: extract short topic-angle chips from the brand brief markdown —
 * `##` headings and `-` bullet items, cleaned of markdown syntax.
 * @param {string} markdown
 * @returns {string[]}
 */
function extractTopicChips(markdown) {
  const chips = [];
  const seen = new Set();
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.trim();
    let text = null;
    if (/^#{2,}\s+/.test(line)) text = line.replace(/^#{2,}\s+/, '');
    else if (/^-\s+/.test(line)) text = line.replace(/^-\s+/, '');
    if (text == null) continue;
    const cleaned = text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links → label
      .replace(/[*_`>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < CHIP_MIN_LEN || cleaned.length > CHIP_MAX_LEN) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chips.push(cleaned);
    if (chips.length >= MAX_TOPIC_CHIPS) break;
  }
  return chips;
}

/**
 * @returns {import('express').Router}
 */
export function createWave3Router() {
  const router = express.Router();

  // Feature 102: newest-first publish history.
  router.get('/api/publish/history', (req, res) => {
    const raw = req.query.limit;
    let limit = 50;
    if (raw !== undefined) {
      if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Number(raw);
    }
    res.json({ ok: true, entries: readPublishHistory(Math.min(MAX_HISTORY_LIMIT, limit)) });
  });

  // Feature 133: recent topics for the compose datalist.
  router.get('/api/publish/topics', (_req, res) => {
    res.json({ ok: true, topics: recentTopics(15) });
  });

  // Feature 115: duplicate-topic warning before polish.
  router.post('/api/compose/duplicate-check', (req, res) => {
    const topic = String(req.body?.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    res.json({ ok: true, duplicate: findDuplicateTopic(topic) });
  });

  // Feature 104: scheduled local queue.
  router.get('/api/schedule', (_req, res) => {
    res.json({ ok: true, schedules: listSchedules(), armed: isQueueArmed() });
  });

  router.post('/api/schedule', (req, res) => {
    const { topic, platforms, posts, fireAt, dryRun } = req.body || {};
    try {
      const schedule = addSchedule({ topic, platforms, posts, fireAt, dryRun });
      res.json({ ok: true, schedule });
    } catch (e) {
      res.status(400).json({ error: e.message || String(e) });
    }
  });

  router.delete('/api/schedule/:id', (req, res) => {
    const removed = removeSchedule(req.params.id);
    if (!removed) return res.status(404).json({ error: 'schedule not found' });
    res.json({ ok: true, removed });
  });

  // Feature 110: named hashtag packs.
  router.get('/api/compose/hashtag-packs', (_req, res) => {
    try {
      res.json({ ok: true, packs: loadHashtagPacks() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Feature 135: static per-platform posting-time hints.
  router.get('/api/compose/best-times', (_req, res) => {
    try {
      res.json({ ok: true, hints: loadBestTimes() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Features 141/142 support: banned words + handle allowlist config.
  router.get('/api/compose/lint-config', (_req, res) => {
    try {
      res.json({ ok: true, ...loadContentLintConfig() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Feature 134: local link slugs (airepro.in/go/…).
  router.get('/api/compose/link-slugs', (_req, res) => {
    try {
      res.json({ ok: true, slugs: loadLinkSlugs() });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Feature 113: UTM settings.
  router.get('/api/compose/utm', (_req, res) => {
    res.json({ ok: true, settings: loadUtmSettings() });
  });

  router.put('/api/compose/utm', (req, res) => {
    res.json({ ok: true, settings: saveUtmSettings(req.body || {}) });
  });

  // Feature 132: topic chips from the brand brief — never 500, works offline.
  router.get('/api/compose/topic-chips', (_req, res) => {
    let chips = [];
    try {
      chips = extractTopicChips(fs.readFileSync(config.brand.profilePath, 'utf8'));
    } catch {
      chips = [];
    }
    res.json({ ok: true, chips });
  });

  // Features 130/131: named disk drafts.
  router.get('/api/drafts', (_req, res) => {
    res.json({ ok: true, drafts: listDrafts() });
  });

  router.post('/api/drafts', (req, res) => {
    const { name, draft, overwrite } = req.body || {};
    try {
      const entry = saveDraft(name, draft, { overwrite: overwrite === true });
      res.json({ ok: true, entry });
    } catch (e) {
      const message = e.message || String(e);
      res.status(/already exists/i.test(message) ? 409 : 400).json({ error: message });
    }
  });

  router.get('/api/drafts/:name', (req, res) => {
    const entry = getDraft(req.params.name);
    if (!entry) return res.status(404).json({ error: 'draft not found' });
    res.json({ ok: true, entry });
  });

  router.delete('/api/drafts/:name', (req, res) => {
    if (!deleteDraft(req.params.name)) {
      return res.status(404).json({ error: 'draft not found' });
    }
    res.json({ ok: true });
  });

  // Feature 152: snippet library.
  router.get('/api/compose/snippets', (_req, res) => {
    res.json({ ok: true, snippets: loadSnippets() });
  });

  // Feature 170: compose presets.
  router.get('/api/compose/presets', (_req, res) => {
    res.json({ ok: true, presets: loadComposePresets() });
  });

  router.post('/api/compose/presets/apply', (req, res) => {
    const id = String(req.body?.id || '').trim();
    const preset = loadComposePresets().find((p) => p.id === id);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    const state = req.body?.state && typeof req.body.state === 'object' ? req.body.state : {};
    res.json({ ok: true, state: applyComposePreset(state, preset), preset });
  });

  // Feature 159: broadcast lists (dry-run expansion only).
  router.get('/api/compose/broadcast-lists', (_req, res) => {
    const lists = loadBroadcastLists().map((list) => ({
      ...list,
      expansion: expandBroadcastList(list, { dryRun: true }),
    }));
    res.json({ ok: true, lists });
  });

  // Feature 151: import a previously exported markdown pack (no Ollama).
  router.post('/api/compose/pack-import', (req, res) => {
    const markdown = String(req.body?.markdown || '');
    if (!markdown.trim()) return res.status(400).json({ error: 'markdown is required' });
    const pack = markdownToPack(markdown);
    res.json({ ok: true, ...pack });
  });

  /**
   * Feature 166: weekly plan — offline/mockable; never auto-publishes.
   * When MOCK_OLLAMA or weeklyPlan uses canned angles from the theme.
   */
  router.post('/api/compose/weekly-plan', (req, res) => {
    if (!isFeatureEnabled('weeklyPlan', true)) {
      return res.status(404).json({ error: 'weeklyPlan disabled' });
    }
    const theme = String(req.body?.theme || '').trim();
    if (!theme) return res.status(400).json({ error: 'theme is required' });
    const angles = parseWeeklyPlanAngles(
      isMockOllama()
        ? Array.from({ length: 7 }, (_, i) => `${i + 1}. ${theme} — angle ${i + 1}`).join('\n')
        : cannedWeeklyPlanText(theme)
    );
    const plan = { theme, angles, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(contentPlanPath), { recursive: true });
    fs.writeFileSync(contentPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    res.json({ ok: true, plan });
  });

  // Keep mock pack helper available for offline polish tests via wave3.
  router.post('/api/compose/mock-pack', (req, res) => {
    const topic = String(req.body?.topic || 'Demo').trim();
    res.json({ ok: true, posts: mockMultiPlatformPack(topic) });
  });

  return router;
}

/**
 * Feature 166: parse numbered / bulleted lines into exactly 7 non-empty angles.
 * @param {string} text
 * @returns {string[]}
 */
export function parseWeeklyPlanAngles(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]\s*|[-*]\s+)/, '').trim())
    .filter(Boolean);
  const angles = lines.slice(0, 7);
  while (angles.length < 7) angles.push(`Angle ${angles.length + 1}`);
  return angles.map((a) => a.slice(0, 200));
}

/** Offline canned weekly plan (no Ollama HTTP). */
function cannedWeeklyPlanText(theme) {
  return Array.from({ length: 7 }, (_, i) => `${i + 1}. ${theme} — angle ${i + 1}`).join('\n');
}
