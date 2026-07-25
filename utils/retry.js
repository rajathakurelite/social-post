// @ts-nocheck
/**
 * Shared retry with exponential backoff + jitter (feature 176).
 * Publishers and fetch helpers should prefer this over ad-hoc loops.
 */

/**
 * @typedef {{
 *   attempts: number,
 *   retries: number,
 *   lastError: Error | null,
 * }} RetryResultMeta
 */

/** In-process retry counters per platform (feature 177). */
const retryCounters = Object.create(null);

/**
 * @param {string} platform
 * @param {number} [n]
 */
export function bumpRetryCount(platform, n = 1) {
  const key = String(platform || 'unknown');
  retryCounters[key] = (retryCounters[key] || 0) + n;
}

/** @returns {Record<string, number>} */
export function getRetryCounts() {
  return { ...retryCounters };
}

/** Test helper. */
export function _resetRetryCounts() {
  for (const k of Object.keys(retryCounters)) delete retryCounters[k];
}

/**
 * @param {number} attempt 1-based failed attempt
 * @param {number} baseMs
 * @returns {number}
 */
export function backoffWithJitter(attempt, baseMs = 500) {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{
 *   maxAttempts?: number,
 *   baseDelayMs?: number,
 *   platform?: string,
 *   shouldRetry?: (err: unknown, attempt: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const shouldRetry =
    opts.shouldRetry ||
    ((err) => {
      const msg = String(err?.message || err || '');
      return /timeout|ECONNRESET|ECONNREFUSED|429|5\d\d|temporar/i.test(msg);
    });

  /** @type {Error | null} */
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const retriesLeft = attempt < maxAttempts;
      if (!retriesLeft || !shouldRetry(e, attempt)) {
        throw lastError;
      }
      if (opts.platform) bumpRetryCount(opts.platform, 1);
      await sleep(backoffWithJitter(attempt, baseDelayMs));
    }
  }
  throw lastError || new Error('retry exhausted');
}
