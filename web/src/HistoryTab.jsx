import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './lib/api.js';

/** Day key (YYYY-MM-DD, local) for calendar grouping. */
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Feature 107: content calendar day view — a 14-day strip combining published
 * entries (publish-log.jsonl) and pending scheduled items (schedule.json);
 * same-day items stack inside their day cell.
 */
function CalendarStrip({ history, schedules }) {
  const days = useMemo(() => {
    const cells = [];
    const now = new Date();
    for (let offset = -10; offset <= 3; offset++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      const key = dayKey(d.toISOString());
      cells.push({
        key,
        label: d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
        isToday: offset === 0,
        items: [],
      });
    }
    const byKey = new Map(cells.map((c) => [c.key, c]));
    for (const h of history) {
      const cell = byKey.get(dayKey(h.ts));
      if (cell) {
        cell.items.push({
          kind: h.dryRun ? 'dry' : 'live',
          label: (h.topic || h.platforms?.join(',') || 'publish').slice(0, 32),
          time: shortTime(h.ts),
        });
      }
    }
    for (const s of schedules) {
      if (s.status !== 'pending') continue;
      const cell = byKey.get(dayKey(s.fireAt));
      if (cell) {
        cell.items.push({
          kind: 'scheduled',
          label: (s.topic || 'scheduled').slice(0, 32),
          time: shortTime(s.fireAt),
        });
      }
    }
    return cells;
  }, [history, schedules]);

  return (
    <div
      className="calendar-strip"
      role="list"
      aria-label="Content calendar, last 10 days plus 3 ahead"
    >
      {days.map((d) => (
        <div key={d.key} role="listitem" className={`calendar-day ${d.isToday ? 'today' : ''}`}>
          <span className="calendar-day-label">{d.label}</span>
          <div className="calendar-day-items">
            {d.items.length === 0 && (
              <span className="calendar-empty" aria-hidden="true">
                ·
              </span>
            )}
            {d.items.map((item, i) => (
              <span
                key={i}
                className={`calendar-item ${item.kind}`}
                title={`${item.time} ${item.label}`}
              >
                {item.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Feature 103: History tab — past publishes with platform chips and dry-run badges. */
export default function HistoryTab({ pushToast, onRecycle }) {
  const [history, setHistory] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [armed, setArmed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        api('/api/publish/history?limit=100'),
        api('/api/schedule').catch(() => ({ schedules: [], armed: false })),
      ]);
      setHistory(h.entries || []);
      setSchedules(s.schedules || []);
      setArmed(Boolean(s.armed));
      setLoaded(true);
    } catch (e) {
      setLoaded(true);
      pushToast(e.message || String(e), 'fail');
    }
  }, [pushToast]);

  useEffect(() => {
    load();
  }, [load]);

  async function cancelSchedule(id) {
    try {
      await api(`/api/schedule/${encodeURIComponent(id)}`, { method: 'DELETE' });
      pushToast('Scheduled item removed', 'ok');
      load();
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    }
  }

  const pending = schedules.filter((s) => s.status === 'pending');

  return (
    <section className="panel">
      <p className="stage-label">History</p>
      <h2>Publishes &amp; schedule</h2>
      <div className="status-row" style={{ marginBottom: '0.85rem' }}>
        <span className="pill">{history.length} logged</span>
        <span className={`pill ${armed ? 'warn' : 'ok'}`}>
          Queue · {armed ? 'ARMED (live possible)' : 'safe (dry-run only)'}
        </span>
        <button type="button" className="pill btn-pill" onClick={load}>
          Refresh
        </button>
      </div>

      <h3>Calendar</h3>
      <CalendarStrip history={history} schedules={schedules} />

      {pending.length > 0 && (
        <>
          <h3 style={{ marginTop: '1.1rem' }}>Scheduled queue</h3>
          <p className="empty-hint">
            Items run via <code>node scripts/queue-runner.js</code> — dry-run unless{' '}
            <code>QUEUE_ARMED=true</code>.
          </p>
          <div className="ar-log">
            {pending.map((s) => (
              <div key={s.id} className="ar-log-row">
                <span className="id">{new Date(s.fireAt).toLocaleString()}</span>
                <span className="plat">{(s.platforms || []).join(', ')}</span>
                <span className="id">{(s.topic || '').slice(0, 60)}</span>
                <button type="button" className="btn-copy" onClick={() => cancelSchedule(s.id)}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h3 style={{ marginTop: '1.1rem' }}>Recent publishes</h3>
      {loaded && history.length === 0 && (
        <p className="empty-hint">No publishes logged yet — dry-run one from the Compose tab.</p>
      )}
      <div className="history-list">
        {history.map((h) => (
          <article key={h.id || h.ts} className="history-row">
            <div className="history-head">
              <time className="id" dateTime={h.ts}>
                {new Date(h.ts).toLocaleString()}
              </time>
              <span className={`pill ${h.dryRun ? 'ok' : 'warn'}`}>
                {h.dryRun ? 'dry-run' : h.mixed ? 'mixed' : 'LIVE'}
              </span>
              {onRecycle && h.topic && (
                <button
                  type="button"
                  className="btn-copy"
                  onClick={() => onRecycle(h.topic)}
                  aria-label={`Reuse topic: ${h.topic}`}
                >
                  Reuse topic
                </button>
              )}
            </div>
            {h.topic && <p className="history-topic">{h.topic}</p>}
            <div className="history-chips">
              {(h.results || []).map((r) => (
                <span
                  key={r.platform}
                  className={`pill ${r.ok ? 'ok' : 'warn'}`}
                  title={r.error || r.id || ''}
                >
                  {r.platform} {r.ok ? '✓' : '✕'}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
