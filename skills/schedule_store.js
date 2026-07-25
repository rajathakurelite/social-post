// @ts-nocheck
/**
 * Scheduled local publish queue (features 104, 105).
 * Entries persist in a JSON file; nothing sends live unless QUEUE_ARMED=true
 * AND the entry explicitly asked for dryRun:false — dry-run wins everywhere else.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/config.js';
import { validateScheduleTime } from './compose_tools.js';

/**
 * @typedef {Object} ScheduleEntry
 * @property {string} id
 * @property {string} createdAt
 * @property {string} fireAt ISO datetime when the entry becomes due.
 * @property {string} topic
 * @property {string[]} platforms
 * @property {object} posts Per-platform post bodies.
 * @property {boolean} dryRun Forced true unless the queue was armed at add time.
 * @property {'pending' | 'done' | 'error'} status
 * @property {unknown} [result]
 * @property {string} [doneAt]
 */

export const schedulePath =
  process.env.SCHEDULE_PATH || path.join(config.rootDir, 'output', 'schedule.json');

/** @returns {{ schedules: ScheduleEntry[] }} */
function readStore() {
  try {
    if (!fs.existsSync(schedulePath)) return { schedules: [] };
    const raw = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.schedules)) return raw;
    return { schedules: [] };
  } catch {
    return { schedules: [] };
  }
}

/** @param {{ schedules: ScheduleEntry[] }} store */
function writeStore(store) {
  fs.mkdirSync(path.dirname(schedulePath), { recursive: true });
  fs.writeFileSync(schedulePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/**
 * Read at call time (not module load) so tests and the runner see live env.
 * @returns {boolean}
 */
export function isQueueArmed() {
  return process.env.QUEUE_ARMED === 'true';
}

/** @returns {ScheduleEntry[]} */
export function listSchedules() {
  return readStore().schedules;
}

/**
 * Feature 104: queue a draft for later publishing. dryRun is forced true
 * unless the queue is armed AND the caller explicitly passed dryRun:false.
 * @param {{ topic?: string, platforms?: string[], posts?: object, fireAt?: string, dryRun?: boolean }} input
 * @returns {ScheduleEntry}
 */
export function addSchedule({ topic, platforms, posts, fireAt, dryRun } = {}) {
  const timeCheck = validateScheduleTime(fireAt);
  if (!timeCheck.ok) throw new Error(timeCheck.error || 'invalid fireAt');
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('platforms must be a non-empty array');
  }
  /** @type {ScheduleEntry} */
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    createdAt: new Date().toISOString(),
    fireAt,
    topic: String(topic || ''),
    platforms,
    posts: posts && typeof posts === 'object' ? posts : {},
    dryRun: !(isQueueArmed() && dryRun === false),
    status: 'pending',
  };
  const store = readStore();
  store.schedules.push(entry);
  writeStore(store);
  return entry;
}

/**
 * @param {string} id
 * @returns {boolean} true when an entry was removed
 */
export function removeSchedule(id) {
  const store = readStore();
  const before = store.schedules.length;
  store.schedules = store.schedules.filter((s) => s.id !== id);
  if (store.schedules.length === before) return false;
  writeStore(store);
  return true;
}

/**
 * @param {Date} [now]
 * @returns {ScheduleEntry[]} pending entries whose fireAt has passed
 */
export function dueSchedules(now = new Date()) {
  return listSchedules().filter((s) => {
    if (s.status !== 'pending') return false;
    const fireAt = Date.parse(s.fireAt);
    return Number.isFinite(fireAt) && fireAt <= now.getTime();
  });
}

/**
 * @param {string} id
 * @param {unknown} result
 * @param {'done' | 'error'} [status]
 * @returns {ScheduleEntry | null} the updated entry
 */
export function markScheduleDone(id, result, status = 'done') {
  const store = readStore();
  const entry = store.schedules.find((s) => s.id === id);
  if (!entry) return null;
  entry.status = status;
  entry.result = result;
  entry.doneAt = new Date().toISOString();
  writeStore(store);
  return entry;
}

/**
 * Feature 105: process every due entry through the injected publish function.
 * An entry publishes live only when it asked for dryRun:false AND the queue
 * is armed at run time; everything else is forced dry-run.
 * @param {{ publish: (args: { platforms: string[], posts: object, dryRun: boolean, topic: string }) => Promise<unknown>, now?: Date }} deps
 * @returns {Promise<Array<{ id: string, dryRun: boolean, ok: boolean, result?: unknown, error?: string }>>}
 */
export async function runQueueOnce({ publish, now = new Date() }) {
  const results = [];
  for (const entry of dueSchedules(now)) {
    const effectiveDryRun = entry.dryRun !== false || !isQueueArmed();
    try {
      const result = await publish({
        platforms: entry.platforms,
        posts: entry.posts,
        dryRun: effectiveDryRun,
        topic: entry.topic,
      });
      markScheduleDone(entry.id, result, 'done');
      results.push({ id: entry.id, dryRun: effectiveDryRun, ok: true, result });
    } catch (e) {
      const error = e.message || String(e);
      markScheduleDone(entry.id, { error }, 'error');
      results.push({ id: entry.id, dryRun: effectiveDryRun, ok: false, error });
    }
  }
  return results;
}
