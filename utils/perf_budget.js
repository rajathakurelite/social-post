// @ts-nocheck
/**
 * Polish duration percentiles + budget check (feature 260).
 */

/**
 * @param {number[]} samples
 * @param {number} p percentile 0–100
 * @returns {number}
 */
export function percentile(samples, p) {
  const arr = samples
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  const rank = Math.min(1, Math.max(0, Number(p) / 100));
  const idx = (arr.length - 1) * rank;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}

/**
 * Parse polish duration ms from log-like lines containing `polishMs=` or `"polishMs":N`.
 * @param {string} text
 * @returns {number[]}
 */
export function parsePolishDurations(text) {
  /** @type {number[]} */
  const out = [];
  const re = /polishMs[=:](\d+(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push(Number(m[1]));
  }
  const reJson = /"polishMs"\s*:\s*(\d+(?:\.\d+)?)/g;
  while ((m = reJson.exec(String(text || ''))) !== null) {
    out.push(Number(m[1]));
  }
  return out;
}

/**
 * @param {number[]} samples
 * @param {{ p95MaxMs: number }} budget
 * @returns {{ ok: boolean, p95: number, budget: number }}
 */
export function checkPerfBudget(samples, budget) {
  const p95 = percentile(samples, 95);
  const limit = Number(budget?.p95MaxMs) || 30_000;
  return { ok: p95 <= limit, p95, budget: limit };
}
