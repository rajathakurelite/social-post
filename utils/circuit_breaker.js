// @ts-nocheck
/**
 * Simple consecutive-failure circuit breaker (feature 174) — used for Ollama.
 */

/**
 * @typedef {'closed' | 'open' | 'half-open'} BreakerState
 */

/**
 * @param {{
 *   failureThreshold?: number,
 *   cooldownMs?: number,
 *   now?: () => number,
 * }} [opts]
 */
export function createCircuitBreaker(opts = {}) {
  const failureThreshold = opts.failureThreshold ?? 3;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now || (() => Date.now());

  let failures = 0;
  /** @type {BreakerState} */
  let state = 'closed';
  let openedAt = 0;

  function snapshot() {
    return {
      state,
      failures,
      failureThreshold,
      cooldownMs,
      openedAt: state === 'open' ? openedAt : null,
      retryAfterMs: state === 'open' ? Math.max(0, openedAt + cooldownMs - now()) : 0,
    };
  }

  function beforeCall() {
    if (state === 'open') {
      const remaining = openedAt + cooldownMs - now();
      if (remaining > 0) {
        const err = new Error(`Circuit open — retry after ${Math.ceil(remaining / 1000)}s`);
        err.code = 'OLLAMA_CIRCUIT_OPEN';
        err.retryAfterMs = remaining;
        throw err;
      }
      state = 'half-open';
    }
  }

  function recordSuccess() {
    failures = 0;
    state = 'closed';
    openedAt = 0;
  }

  function recordFailure() {
    failures += 1;
    if (state === 'half-open' || failures >= failureThreshold) {
      state = 'open';
      openedAt = now();
    }
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function exec(fn) {
    beforeCall();
    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (e) {
      recordFailure();
      throw e;
    }
  }

  /** Test helper: force state. */
  function _reset() {
    failures = 0;
    state = 'closed';
    openedAt = 0;
  }

  return { exec, beforeCall, recordSuccess, recordFailure, snapshot, _reset };
}
