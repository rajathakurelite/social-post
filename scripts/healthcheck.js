/**
 * Feature 223: hit /api/health — exit 0 ok, 1 degraded, 2 down/unreachable.
 */
const base = process.env.UI_API_BASE || 'http://127.0.0.1:8787';

try {
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) {
    console.error('healthcheck: HTTP', res.status);
    process.exit(2);
  }
  const body = await res.json();
  const status = body.status || (body.ok ? 'ok' : 'down');
  console.log('healthcheck:', status);
  if (status === 'ok') process.exit(0);
  if (status === 'degraded') process.exit(1);
  process.exit(2);
} catch (e) {
  console.error('healthcheck: down —', e.message || e);
  process.exit(2);
}
