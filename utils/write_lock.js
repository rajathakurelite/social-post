// @ts-nocheck
/**
 * Serialize async critical sections (feature 228: settings/rules write lock).
 */

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * Run `fn` after any prior locked work for `key` completes.
 * @template T
 * @param {string} key
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withWriteLock(key, fn) {
  const k = String(key || 'default');
  const prev = tails.get(k) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = prev.then(
    () => gate,
    () => gate
  );
  tails.set(k, next);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(k) === next) tails.delete(k);
  }
}
