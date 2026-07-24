/**
 * Shared outbound HTTP: timeouts + bounded retries for transient failures.
 * Retries only on network/timeout errors and HTTP 429/5xx (not 401/403).
 */
import fetch from 'node-fetch';

const DEFAULT_TIMEOUT_MS = 30_000;
/** Extra attempts after the first (total attempts = retries + 1). */
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 500;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {number} attempt — 1-based failed attempt index
 * @returns {number}
 */
function backoffMs(attempt) {
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

/**
 * @param {string | null} header
 * @returns {number | null} delay in ms
 */
function parseRetryAfterMs(header) {
  if (!header) return null;
  const asSec = Number(header);
  if (Number.isFinite(asSec) && asSec >= 0) {
    return Math.min(asSec * 1000, 60_000);
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(0, asDate - Date.now()), 60_000);
  }
  return null;
}

/**
 * @param {number} status
 * @returns {boolean}
 */
export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * node-fetch with AbortController timeout.
 * @param {string} url
 * @param {import('node-fetch').RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<import('node-fetch').Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Request timed out after ${ms}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchWithTimeout + retries for transient failures.
 * @param {string} url
 * @param {import('node-fetch').RequestInit} [options]
 * @param {{ timeoutMs?: number, retries?: number }} [retryOpts]
 * @returns {Promise<import('node-fetch').Response>}
 */
export async function fetchWithRetry(url, options = {}, retryOpts = {}) {
  const timeoutMs = retryOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(retryOpts.retries) ? Math.max(0, retryOpts.retries) : DEFAULT_RETRIES;
  const maxAttempts = retries + 1;

  let lastNetworkError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, options, timeoutMs);
    } catch (e) {
      lastNetworkError = e;
      if (attempt >= maxAttempts) throw e;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!isRetryableStatus(res.status) || attempt >= maxAttempts) {
      return res;
    }

    // Drain body before retry so the socket can close cleanly.
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }

    const fromHeader = parseRetryAfterMs(res.headers.get('retry-after'));
    await sleep(fromHeader ?? backoffMs(attempt));
  }

  throw lastNetworkError || new Error(`Request failed after ${maxAttempts} attempts: ${url}`);
}
