/**
 * Unit tests for the Wave-3 persistence stores (features 101–105, 113, 115,
 * 130, 131, 133). All paths point at a temp dir via tests/setup.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  publishLogPath,
  appendPublishLog,
  readPublishHistory,
  recentTopics,
  findDuplicateTopic,
} from '../skills/publish_history.js';
import {
  schedulePath,
  addSchedule,
  listSchedules,
  runQueueOnce,
} from '../skills/schedule_store.js';
import { draftsPath, saveDraft, getDraft } from '../skills/drafts_store.js';
import { utmSettingsPath, loadUtmSettings, saveUtmSettings } from '../skills/utm_store.js';
import { slugify } from '../skills/compose_tools.js';

const futureIso = (ms = 60 * 60 * 1000) => new Date(Date.now() + ms).toISOString();

beforeEach(() => {
  for (const p of [publishLogPath, schedulePath, draftsPath, utmSettingsPath]) {
    fs.rmSync(p, { force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('publish history (101, 102, 133, 115)', () => {
  it('101: appendPublishLog writes exactly one parseable JSON line per append', () => {
    const record = appendPublishLog({
      topic: 'Remote internships',
      platforms: ['facebook'],
      dryRun: true,
      results: { facebook: { ok: true } },
    });
    expect(record).toBeTruthy();

    let lines = fs.readFileSync(publishLogPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.id).toBeTruthy();
    expect(parsed.ts).toBeTruthy();
    expect(parsed.topic).toBe('Remote internships');

    appendPublishLog({ topic: 'Second', platforms: ['twitter'], dryRun: true, results: {} });
    lines = fs.readFileSync(publishLogPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('102: readPublishHistory returns newest first and tolerates a missing file', () => {
    expect(readPublishHistory()).toEqual([]);
    appendPublishLog({ topic: 'A', platforms: [], dryRun: true, results: {} });
    appendPublishLog({ topic: 'B', platforms: [], dryRun: true, results: {} });
    appendPublishLog({ topic: 'C', platforms: [], dryRun: true, results: {} });
    const history = readPublishHistory();
    expect(history.map((e) => e.topic)).toEqual(['C', 'B', 'A']);
  });

  it('133: recentTopics dedupes case-insensitively and caps at 15', () => {
    appendPublishLog({ topic: 'Dream Internship', platforms: [], dryRun: true, results: {} });
    appendPublishLog({ topic: 'dream internship', platforms: [], dryRun: true, results: {} });
    for (let i = 0; i < 20; i++) {
      appendPublishLog({ topic: `Topic ${i}`, platforms: [], dryRun: true, results: {} });
    }
    const topics = recentTopics();
    expect(topics).toHaveLength(15);
    expect(topics[0]).toBe('Topic 19');
    const lower = topics.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('115: findDuplicateTopic fuzzy-matches recent topics only', () => {
    appendPublishLog({ topic: 'dream internship', platforms: [], dryRun: true, results: {} });
    const dup = findDuplicateTopic('Dream  internship!');
    expect(dup).toBeTruthy();
    expect(dup.topic).toBe('dream internship');
    expect(findDuplicateTopic('quarterly tax filing tips')).toBeNull();
  });

  it('115: entries older than 30 days are ignored', () => {
    const old = {
      id: 'old-entry',
      ts: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      topic: 'dream internship',
      platforms: [],
      dryRun: true,
      results: null,
    };
    fs.mkdirSync(path.dirname(publishLogPath), { recursive: true });
    fs.appendFileSync(publishLogPath, `${JSON.stringify(old)}\n`, 'utf8');
    expect(findDuplicateTopic('Dream  internship!')).toBeNull();
  });
});

describe('schedule store (104, 105)', () => {
  it('104: forces dryRun true when QUEUE_ARMED is unset, even with dryRun:false', () => {
    expect(process.env.QUEUE_ARMED).toBeUndefined();
    const entry = addSchedule({
      topic: 'Queued topic',
      platforms: ['facebook'],
      posts: { facebook: { text: 'body' } },
      fireAt: futureIso(),
      dryRun: false,
    });
    expect(entry.dryRun).toBe(true);
    expect(entry.status).toBe('pending');
    expect(listSchedules()).toHaveLength(1);
  });

  it('104: rejects a past fireAt', () => {
    expect(() =>
      addSchedule({
        topic: 'Too late',
        platforms: ['facebook'],
        posts: {},
        fireAt: new Date(Date.now() - 60 * 1000).toISOString(),
      })
    ).toThrow();
  });

  it('104: rejects empty platforms', () => {
    expect(() =>
      addSchedule({ topic: 'No platforms', platforms: [], posts: {}, fireAt: futureIso() })
    ).toThrow(/platforms/);
  });

  it('105: runQueueOnce processes only due entries as dry-run and never touches fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const due = addSchedule({
      topic: 'Due topic',
      platforms: ['facebook'],
      posts: { facebook: { text: 'due body' } },
      fireAt: futureIso(2 * 60 * 1000),
    });
    const notDue = addSchedule({
      topic: 'Future topic',
      platforms: ['twitter'],
      posts: { twitter: { text: 'later body' } },
      fireAt: futureIso(24 * 60 * 60 * 1000),
    });

    const publish = vi.fn().mockResolvedValue({ ok: true, simulated: true });
    const results = await runQueueOnce({
      publish,
      now: new Date(Date.now() + 5 * 60 * 1000),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: due.id, dryRun: true, ok: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true, topic: 'Due topic', platforms: ['facebook'] })
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    const byId = new Map(listSchedules().map((s) => [s.id, s]));
    expect(byId.get(due.id).status).toBe('done');
    expect(byId.get(notDue.id).status).toBe('pending');
  });
});

describe('drafts store (130, 131)', () => {
  const draft = {
    topic: 'Round trip',
    platforms: ['facebook', 'twitter'],
    posts: { facebook: { text: 'exact body — «unicode» ✓' } },
    nested: { deep: [1, 2, { three: true }] },
  };

  it('130: saveDraft/getDraft round-trips the draft byte-identically', () => {
    saveDraft('roundtrip', draft);
    const entry = getDraft('roundtrip');
    expect(entry).toBeTruthy();
    expect(entry.draft).toEqual(draft);
    expect(JSON.stringify(entry.draft)).toBe(JSON.stringify(draft));
  });

  it('131: duplicate name (different case) throws unless overwrite is passed', () => {
    saveDraft('MyDraft', draft);
    expect(() => saveDraft('mydraft', { changed: true })).toThrow(/already exists/);
    const entry = saveDraft('mydraft', { changed: true }, { overwrite: true });
    expect(entry.draft).toEqual({ changed: true });
    expect(getDraft('MYDRAFT').draft).toEqual({ changed: true });
  });
});

describe('utm store (113)', () => {
  it('loadUtmSettings returns defaults when no file exists', () => {
    expect(loadUtmSettings()).toEqual({ enabled: false, campaign: 'airepro' });
  });

  it('saveUtmSettings persists a slugified campaign', () => {
    const saved = saveUtmSettings({ enabled: true, campaign: 'Summer Drive 2026' });
    expect(saved.enabled).toBe(true);
    expect(saved.campaign).toBe(slugify('Summer Drive 2026'));
    expect(loadUtmSettings()).toEqual(saved);
  });
});
