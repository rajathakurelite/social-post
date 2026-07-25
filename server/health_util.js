/**
 * Health helpers (features 183–184, 195, 201, 207–208, 217).
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const BOOT_AT = Date.now();
const BOOT_ISO = new Date(BOOT_AT).toISOString();
/** @type {object[]} */
const healthRing = [];
const RING_MAX = 20;
const RSS_WARN_BYTES = Number(process.env.RSS_WARN_BYTES) || 512 * 1024 * 1024;
const DISK_WARN_BYTES = Number(process.env.DISK_WARN_BYTES) || 200 * 1024 * 1024;

let envBootMtime = 0;
try {
  envBootMtime = fs.statSync(path.join(config.rootDir, '.env')).mtimeMs;
} catch {
  envBootMtime = 0;
}

/** @returns {number} */
export function bootTimestamp() {
  return BOOT_AT;
}

/** @returns {string} */
export function bootIso() {
  return BOOT_ISO;
}

/**
 * @param {object} snapshot
 */
export function pushHealthSnapshot(snapshot) {
  healthRing.push({ ...snapshot, at: Date.now() });
  while (healthRing.length > RING_MAX) healthRing.shift();
}

/** @returns {object[]} */
export function getHealthHistory() {
  return [...healthRing];
}

/**
 * @param {{ ollamaOk: boolean, paused?: boolean, diskFreeBytes?: number | null }} args
 * @returns {'ok' | 'degraded' | 'down'}
 */
export function computeHealthStatus({ ollamaOk, paused = false, diskFreeBytes = null }) {
  if (paused) return 'degraded';
  if (diskFreeBytes != null && diskFreeBytes < DISK_WARN_BYTES) return 'degraded';
  if (!ollamaOk) return 'degraded';
  return 'ok';
}

/**
 * Free bytes on the output drive (best-effort; null when unavailable).
 * @returns {number | null}
 */
export function freeDiskBytes() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(config.rootDir);
      return Number(st.bavail) * Number(st.bsize);
    }
  } catch {
    // ignore
  }
  return null;
}

/** @returns {number} */
export function rssBytes() {
  return process.memoryUsage().rss;
}

/** Warn once when RSS crosses threshold. */
let rssWarned = false;
export function checkRssWatchdog() {
  const rss = rssBytes();
  if (!rssWarned && rss >= RSS_WARN_BYTES) {
    rssWarned = true;
    logger.warn('Memory watchdog: RSS above threshold', { rss, threshold: RSS_WARN_BYTES });
  }
  return rss;
}

/**
 * @returns {boolean}
 */
export function staleEnvFlag() {
  try {
    const mt = fs.statSync(path.join(config.rootDir, '.env')).mtimeMs;
    return envBootMtime > 0 && mt > envBootMtime;
  } catch {
    return false;
  }
}

/** Test helper. */
export function _setEnvBootMtime(ms) {
  envBootMtime = ms;
}

export function _resetHealthRing() {
  healthRing.length = 0;
  rssWarned = false;
}
