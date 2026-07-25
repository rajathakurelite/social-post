// @ts-nocheck
/**
 * Creatives TTL sweep (feature 194).
 */
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Delete files in `dir` older than `ttlDays`.
 * @param {string} dir
 * @param {number} ttlDays
 * @param {{ nowMs?: number, dryRun?: boolean }} [opts]
 * @returns {{ removed: string[], kept: string[] }}
 */
export function sweepCreativesTtl(dir, ttlDays, opts = {}) {
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days <= 0) return { removed: [], kept: [] };
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - days * 86400_000;
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const kept = [];
  if (!fs.existsSync(dir)) return { removed, kept };

  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) {
        if (!opts.dryRun) fs.rmSync(p, { force: true });
        removed.push(p);
      } else {
        kept.push(p);
      }
    } catch {
      // skip
    }
  }
  if (removed.length) {
    logger.info('creatives TTL sweep', { removed: removed.length, ttlDays: days });
  }
  return { removed, kept };
}

/**
 * Schedule daily creatives TTL (feature 194). Returns clear handle.
 * @param {string} dir
 * @param {number} ttlDays
 * @returns {NodeJS.Timeout | null}
 */
export function startCreativesTtlInterval(dir, ttlDays) {
  const days = Number(ttlDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  sweepCreativesTtl(dir, days);
  return setInterval(
    () => {
      try {
        sweepCreativesTtl(dir, days);
      } catch (e) {
        logger.warn('creatives TTL interval failed', { error: e.message || String(e) });
      }
    },
    24 * 60 * 60 * 1000
  );
}
