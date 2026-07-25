// @ts-nocheck
/**
 * Webhook quarantine + freshness (features 178, 214).
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import { appendJsonl } from './jsonl.js';
import { logger } from './logger.js';
import { now } from './clock.js';

const quarantinePath = () =>
  process.env.WEBHOOK_QUARANTINE_PATH ||
  path.join(config.rootDir, 'output', 'webhook-quarantine.jsonl');

/** Default: reject events older than 15 minutes. */
export const WEBHOOK_MAX_AGE_MS = () =>
  Math.max(60_000, Number(process.env.WEBHOOK_MAX_AGE_MS) || 15 * 60_000);

/**
 * @param {{ reason: string, source?: string, body?: unknown, meta?: object }} entry
 */
export function quarantineWebhook(entry) {
  const record = {
    ts: new Date(now()).toISOString(),
    reason: String(entry.reason || 'malformed'),
    source: entry.source || 'unknown',
    meta: entry.meta || undefined,
    body: entry.body,
  };
  appendJsonl(quarantinePath(), record);
  logger.warn('webhook quarantined', { reason: record.reason, source: record.source });
  return record;
}

/**
 * Extract a candidate event timestamp (ms) from Meta-style webhook bodies.
 * @param {unknown} body
 * @returns {number | null}
 */
export function extractWebhookTimestampMs(body) {
  if (!body || typeof body !== 'object') return null;
  const b = /** @type {Record<string, unknown>} */ (body);

  // WhatsApp Cloud: messages[].timestamp (unix seconds)
  for (const entry of Array.isArray(b.entry) ? b.entry : []) {
    const e = /** @type {Record<string, unknown>} */ (entry);
    for (const change of Array.isArray(e.changes) ? e.changes : []) {
      const value = /** @type {Record<string, unknown>} */ (change)?.value || {};
      const messages = /** @type {unknown[]} */ (
        /** @type {Record<string, unknown>} */ (value).messages || []
      );
      for (const msg of messages) {
        const ts = Number(/** @type {Record<string, unknown>} */ (msg)?.timestamp);
        if (Number.isFinite(ts) && ts > 0) return ts < 1e12 ? ts * 1000 : ts;
      }
    }
    // Messenger: messaging[].timestamp (ms)
    for (const event of Array.isArray(e.messaging) ? e.messaging : []) {
      const ts = Number(/** @type {Record<string, unknown>} */ (event)?.timestamp);
      if (Number.isFinite(ts) && ts > 0) return ts < 1e12 ? ts * 1000 : ts;
    }
  }
  return null;
}

/**
 * @param {unknown} body
 * @param {{ maxAgeMs?: number, nowMs?: number }} [opts]
 * @returns {{ fresh: boolean, ageMs: number | null, timestampMs: number | null }}
 */
export function checkWebhookFreshness(body, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? WEBHOOK_MAX_AGE_MS();
  const nowMs = opts.nowMs ?? now();
  const timestampMs = extractWebhookTimestampMs(body);
  if (timestampMs == null) {
    // No timestamp → treat as fresh (status callbacks, etc.)
    return { fresh: true, ageMs: null, timestampMs: null };
  }
  const ageMs = nowMs - timestampMs;
  return { fresh: ageMs <= maxAgeMs, ageMs, timestampMs };
}

/**
 * True when the payload is not a recognizable Meta webhook envelope.
 * @param {unknown} body
 * @param {'whatsapp' | 'facebook'} source
 */
export function isMalformedWebhook(body, source) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return true;
  const b = /** @type {Record<string, unknown>} */ (body);
  if (!Array.isArray(b.entry)) return true;
  if (source === 'whatsapp') {
    // Accept object=whatsapp_business_account or missing object with entry.changes
    return false;
  }
  // facebook: object=page is ideal; still accept entry with messaging
  return false;
}

export function getQuarantinePath() {
  return quarantinePath();
}

/** @returns {object[]} */
export function readQuarantine(limit = 50) {
  const p = quarantinePath();
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines
    .slice(-Math.max(1, limit))
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
}
