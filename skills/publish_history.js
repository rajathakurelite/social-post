/**
 * Publish history JSONL store (features 101, 102, 115, 133).
 * Every /api/publish outcome is appended as one JSON line; readers tolerate
 * missing files and corrupt lines so history can never break publishing.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { topicsSimilar } from './compose_tools.js';

/** Resolved once at module load (tests point it at a temp file via env). */
export const publishLogPath =
  process.env.PUBLISH_LOG_PATH || path.join(config.rootDir, 'output', 'publish-log.jsonl');

/** How many trailing lines the derived readers (topics, duplicates) scan. */
const SCAN_WINDOW = 500;

/**
 * Feature 101: append one publish outcome as a single JSON line.
 * Never throws — publish must not fail because history is unwritable.
 * @param {{ topic?: string, platforms?: string[], dryRun?: boolean, results?: unknown }} entry
 * @returns {object | null} the stored record, or null when the write failed
 */
export function appendPublishLog(entry = {}) {
  const { topic = '', platforms = [], dryRun = true, results = null, ...rest } = entry || {};
  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    ts: new Date().toISOString(),
    topic,
    platforms,
    dryRun,
    results,
    ...rest,
  };
  try {
    fs.mkdirSync(path.dirname(publishLogPath), { recursive: true });
    fs.appendFileSync(publishLogPath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch (e) {
    logger.warn('publish history write failed', { error: e.message || String(e) });
    return null;
  }
}

/**
 * Feature 102: newest-first history entries.
 * @param {number} [limit]
 * @returns {object[]} [] when the file is missing; unparseable lines skipped
 */
export function readPublishHistory(limit = 50) {
  try {
    if (!fs.existsSync(publishLogPath)) return [];
    const lines = fs.readFileSync(publishLogPath, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Feature 133: recent topic strings for the compose datalist —
 * deduped case-insensitively, newest first, capped at `limit`.
 * @param {number} [limit]
 * @returns {string[]}
 */
export function recentTopics(limit = 15) {
  const topics = [];
  const seen = new Set();
  for (const entry of readPublishHistory(SCAN_WINDOW)) {
    const topic = typeof entry.topic === 'string' ? entry.topic.trim() : '';
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= limit) break;
  }
  return topics;
}

/**
 * Feature 115: most recent history entry whose topic fuzzy-matches `topic`
 * (per topicsSimilar) within the last `days` days, else null.
 * @param {string} topic
 * @param {{ days?: number }} [opts]
 * @returns {object | null}
 */
export function findDuplicateTopic(topic, { days = 30 } = {}) {
  const candidate = String(topic || '').trim();
  if (!candidate) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const entry of readPublishHistory(SCAN_WINDOW)) {
    if (typeof entry.topic !== 'string' || !entry.topic.trim()) continue;
    const ts = Date.parse(entry.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (topicsSimilar(candidate, entry.topic)) return entry;
  }
  return null;
}
