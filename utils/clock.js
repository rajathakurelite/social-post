// @ts-nocheck
/**
 * Injectable clock (feature 227) for deterministic cooldown/schedule/rotation tests.
 */

let nowFn = () => Date.now();

/** @returns {number} */
export function now() {
  return nowFn();
}

/** @param {() => number} fn */
export function setClock(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

/** Restore system clock. */
export function resetClock() {
  nowFn = () => Date.now();
}

/**
 * Advance a fake clock (test helper). Call setClock first with a mutable source.
 * @param {{ t: number }} source
 * @param {number} ms
 */
export function advance(source, ms) {
  source.t += ms;
}
