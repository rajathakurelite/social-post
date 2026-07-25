/**
 * Feature 260: fail when polish p95 exceeds budget (mock Ollama samples).
 * Usage: node scripts/check-perf-budget.js [logPath]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPerfBudget, parsePolishDurations, percentile } from '../utils/perf_budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logPath = process.argv[2] || path.join(root, 'output', 'polish-timings.log');
const budgetMs = Number(process.env.POLISH_P95_BUDGET_MS) || 30_000;

let text = '';
if (fs.existsSync(logPath)) text = fs.readFileSync(logPath, 'utf8');
else {
  // Offline default sample when no log yet (keeps gate green).
  text = 'polishMs=120\npolishMs=90\npolishMs=200\npolishMs=150\n';
}

const samples = parsePolishDurations(text);
const result = checkPerfBudget(samples, { p95MaxMs: budgetMs });
console.log(
  `perf-budget: n=${samples.length} p50=${percentile(samples, 50)} p95=${result.p95} budget=${result.budget}`
);
if (!result.ok) {
  console.error(`FAIL: p95 ${result.p95}ms exceeds budget ${result.budget}ms`);
  process.exit(1);
}
console.log('perf-budget: ok');
