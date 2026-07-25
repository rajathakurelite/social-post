import { useEffect, useState } from 'react';
import { api } from './lib/api.js';

/**
 * Feature 241: client-side publish stats from /api/stats/publish.
 */
export default function StatsTab() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/api/stats/publish')
      .then(setStats)
      .catch((e) => setError(e.message || String(e)));
  }, []);

  if (error) {
    return (
      <section className="panel" aria-label="Publish stats">
        <p className="error">{error}</p>
      </section>
    );
  }
  if (!stats) {
    return (
      <section className="panel" aria-label="Publish stats">
        <p>Loading stats…</p>
      </section>
    );
  }

  const days = Object.entries(stats.byDay || {}).sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...days.map(([, n]) => n));

  return (
    <section className="panel stats-panel" aria-label="Publish stats">
      <h2>Publish stats</h2>
      <p>
        {stats.total} publishes · dry-run ratio {(stats.dryRunRatio * 100).toFixed(0)}% · failure
        rate {(stats.failureRate * 100).toFixed(0)}%
      </p>
      <div className="stats-bars" role="img" aria-label="Publishes per day">
        {days.length === 0 && (
          <p className="muted">No history yet — polish and dry-run publish to populate.</p>
        )}
        {days.map(([day, n]) => (
          <div key={day} className="stats-bar-row">
            <span className="stats-day">{day}</span>
            <div className="stats-bar-track">
              <div className="stats-bar-fill" style={{ width: `${(n / max) * 100}%` }} />
            </div>
            <span className="stats-n">{n}</span>
          </div>
        ))}
      </div>
      <ul className="stats-platforms">
        {Object.entries(stats.byPlatform || {}).map(([p, row]) => (
          <li key={p}>
            {p}: {row.ok || 0} ok / {row.failed || 0} failed / {row.dryRun || 0} dry-run
          </li>
        ))}
      </ul>
      <p>
        <a href="/api/publish/history.csv">Download CSV</a>
      </p>
    </section>
  );
}
