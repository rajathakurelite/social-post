import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './lib/api.js';

const emptyRule = () => ({
  id: `rule-${Date.now()}`,
  name: 'New rule',
  enabled: true,
  platform: 'whatsapp',
  pattern: '',
  flags: 'i',
  reply: '',
  cooldownSec: 60,
  scope: 'any',
  priority: 0,
  tags: [],
  canaryPercent: null,
  quietHours: null,
  requireMention: false,
  replyVariants: [],
});

function parseCommaList(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** One variant per line; optional "weight|text" prefix. */
function parseVariantLines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d+(?:\.\d+)?)\|(.+)$/.exec(line);
      return m ? { weight: Number(m[1]), text: m[2].trim() } : { weight: 1, text: line };
    });
}

function variantsToLines(variants) {
  return (variants || [])
    .map((v) => (v.weight !== 1 ? `${v.weight}|${v.text}` : v.text))
    .join('\n');
}

export default function AutoReplyPanel({ pushToast }) {
  const [rules, setRules] = useState([]);
  const [settings, setSettings] = useState({
    matchMode: 'first',
    maxRepliesPerHour: 60,
    stopWords: [],
    ignoreList: [],
    businessHours: { enabled: false, start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    escalationWords: [],
    mentionTokens: [],
    allowedLinkDomains: [],
    approvalRequired: false,
    templates: [],
  });
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [testText, setTestText] = useState('hello internship please');
  const [testResult, setTestResult] = useState(null);
  const [log, setLog] = useState([]);
  const [keywordHelp, setKeywordHelp] = useState('');
  const [busy, setBusy] = useState(null);
  const [stats, setStats] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [takeovers, setTakeovers] = useState({});
  const [takeoverFrom, setTakeoverFrom] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [explain, setExplain] = useState(null);
  const [importDiff, setImportDiff] = useState(null);
  const fileRef = useRef(null);

  const selected = rules.find((r) => r.id === selectedId) || null;
  const allTags = useMemo(() => {
    const set = new Set();
    for (const r of rules) for (const t of r.tags || []) set.add(t);
    return [...set].sort();
  }, [rules]);
  const visibleRules = useMemo(
    () => (tagFilter ? rules.filter((r) => (r.tags || []).includes(tagFilter)) : rules),
    [rules, tagFilter]
  );

  const load = useCallback(async () => {
    const data = await api('/api/auto-reply/rules');
    setRules(data.rules || []);
    setSettings((s) => ({ ...s, ...(data.settings || {}) }));
    setAutoEnabled(Boolean(data.autoReplyEnabled));
    if (!selectedId && data.rules?.[0]) setSelectedId(data.rules[0].id);
    const [logData, statsData, approvalsData, takeoverData] = await Promise.all([
      api('/api/auto-reply/log?limit=30'),
      api('/api/auto-reply/stats').catch(() => null),
      api('/api/auto-reply/approvals').catch(() => null),
      api('/api/auto-reply/takeover').catch(() => null),
    ]);
    setLog(logData.entries || []);
    if (statsData) setStats(statsData);
    if (approvalsData) setApprovals(approvalsData.approvals || []);
    if (takeoverData) setTakeovers(takeoverData.takeovers || {});
  }, [selectedId]);

  useEffect(() => {
    load().catch((e) => pushToast(e.message || String(e), 'fail'));
  }, []);

  function updateSelected(patch) {
    if (!selected) return;
    setRules((prev) => prev.map((r) => (r.id === selected.id ? { ...r, ...patch } : r)));
  }

  async function saveAll() {
    setBusy('save');
    try {
      const data = await api('/api/auto-reply/rules', {
        method: 'PUT',
        body: JSON.stringify({ rules, settings }),
      });
      setRules(data.rules || rules);
      setSettings(data.settings || settings);
      pushToast('Auto-reply rules saved', 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    setBusy('test');
    try {
      const data = await api('/api/auto-reply/test', {
        method: 'POST',
        body: JSON.stringify({ text: testText, dryRun: true, platform: 'whatsapp' }),
      });
      setTestResult(data);
      pushToast(
        data.matches?.length ? `${data.matches.length} rule(s) matched (dry)` : 'No rules matched',
        data.matches?.length ? 'ok' : 'info'
      );
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  function addRule() {
    const r = emptyRule();
    setRules((prev) => [...prev, r]);
    setSelectedId(r.id);
  }

  function deleteSelected() {
    if (!selected) return;
    setRules((prev) => prev.filter((r) => r.id !== selected.id));
    setSelectedId(null);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ rules, settings }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'auto_reply_rules_export.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || ''));
        const list = Array.isArray(parsed) ? parsed : parsed.rules;
        if (!Array.isArray(list)) throw new Error('Import must be an array or { rules }');
        // Feature 88: diff preview before committing the import.
        try {
          const diff = await api('/api/auto-reply/rules/diff', {
            method: 'POST',
            body: JSON.stringify({ rules: list }),
          });
          setImportDiff(diff);
        } catch {
          setImportDiff(null);
        }
        setRules(list);
        if (parsed.settings) setSettings((s) => ({ ...s, ...parsed.settings }));
        pushToast(`Imported ${list.length} rules — review diff, then Save to persist`, 'ok');
      } catch (e) {
        pushToast(e.message || String(e), 'fail');
      }
    };
    reader.readAsText(file);
  }

  /** Feature 87: bulk enable/disable the currently visible (tag-filtered) rules. */
  async function bulkToggle(enabled) {
    const ids = visibleRules.map((r) => r.id);
    if (!ids.length) {
      pushToast('No rules in the current filter', 'info');
      return;
    }
    setBusy('bulk');
    try {
      const data = await api('/api/auto-reply/rules/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids, enabled }),
      });
      setRules(data.rules || rules);
      pushToast(`${data.changed} rule(s) ${enabled ? 'enabled' : 'disabled'}`, 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  /** Feature 89: explain the selected rule's pattern against the simulator text. */
  async function runExplain() {
    if (!selected) {
      pushToast('Select a rule first', 'fail');
      return;
    }
    try {
      const data = await api('/api/auto-reply/explain', {
        method: 'POST',
        body: JSON.stringify({
          pattern: selected.pattern,
          flags: selected.flags,
          sampleText: testText,
        }),
      });
      setExplain(data);
    } catch (e) {
      setExplain(null);
      pushToast(e.message || String(e), 'fail');
    }
  }

  /** Feature 92: approve or reject a queued outbound reply. */
  async function actOnApproval(id, action) {
    setBusy('approval');
    try {
      await api(`/api/auto-reply/approvals/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      pushToast(`Reply ${action === 'approve' ? 'approved & sent' : 'rejected'}`, 'ok');
      const data = await api('/api/auto-reply/approvals');
      setApprovals(data.approvals || []);
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  /** Feature 76: pause/resume auto-reply for one chat. */
  async function toggleTakeover(from, active) {
    const target = String(from || '').trim();
    if (!target) {
      pushToast('Enter a sender id / phone first', 'fail');
      return;
    }
    try {
      const data = await api('/api/auto-reply/takeover', {
        method: 'POST',
        body: JSON.stringify({ platform: 'whatsapp', from: target, active }),
      });
      setTakeovers(data.takeovers || {});
      pushToast(active ? `Takeover ON for ${target}` : `Takeover cleared for ${target}`, 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    }
  }

  async function applyKeywordHelper() {
    try {
      const data = await api('/api/auto-reply/keyword-to-regex', {
        method: 'POST',
        body: JSON.stringify({ keywords: keywordHelp }),
      });
      if (!selected) {
        pushToast('Select a rule first', 'fail');
        return;
      }
      updateSelected({ pattern: data.pattern, flags: data.flags });
      pushToast('Pattern filled from keywords', 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    }
  }

  return (
    <section className="panel auto-reply-panel">
      <p className="stage-label">Automation</p>
      <h2>Auto-reply rules</h2>
      <p className="empty-hint">
        Regex rules for inbound WhatsApp (and Facebook log-only). Live send only when{' '}
        <code>AUTO_REPLY_ENABLED=true</code> in <code>.env</code> and the rule is enabled. Test is
        always dry-run.
      </p>

      <div className="status-row" style={{ marginBottom: '0.85rem' }}>
        <span className={`pill ${autoEnabled ? 'warn' : 'ok'}`}>
          AUTO_REPLY_ENABLED · {autoEnabled ? 'ON (live possible)' : 'off (safe)'}
        </span>
        <span className="pill">{rules.length} rules</span>
        {stats?.stats && (
          <>
            <span className="pill" title="Inbound messages seen since API start">
              in {stats.stats.inbound} · match {stats.stats.matches} · sent {stats.stats.sent}
            </span>
            {stats.stats.dlq > 0 && <span className="pill warn">DLQ {stats.stats.dlq}</span>}
            {stats.approvalsPending > 0 && (
              <span className="pill warn">{stats.approvalsPending} awaiting approval</span>
            )}
          </>
        )}
        <a className="pill btn-pill" href="/api/auto-reply/log.csv" download>
          Export log CSV
        </a>
        <button type="button" className="pill btn-pill" onClick={() => load().catch(() => {})}>
          Refresh
        </button>
      </div>

      {/* Feature 247: webhook simulator — posts fixture envelopes to local webhook routes. */}
      <div className="ar-keyword" style={{ marginBottom: '1rem' }}>
        <h3 style={{ margin: 0 }}>Webhook simulator</h3>
        <p className="empty-hint" style={{ margin: 0 }}>
          Dev-only: POST a fixture envelope to <code>/api/webhooks/*</code> and refresh the match
          log.
        </p>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy === 'sim-webhook'}
          onClick={async () => {
            setBusy('sim-webhook');
            try {
              const fixture = {
                object: 'whatsapp_business_account',
                entry: [
                  {
                    id: 'WABA',
                    changes: [
                      {
                        field: 'messages',
                        value: {
                          messages: [
                            {
                              from: '15550001111',
                              id: `wamid.sim-${Date.now()}`,
                              timestamp: String(Math.floor(Date.now() / 1000)),
                              type: 'text',
                              text: { body: 'hello internship' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              };
              const res = await fetch('/api/webhooks/whatsapp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fixture),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || `webhook ${res.status}`);
              pushToast(
                data.quarantined
                  ? `Quarantined: ${data.reason}`
                  : `Simulator processed ${data.processed?.length ?? 0} message(s)`,
                data.quarantined ? 'info' : 'ok'
              );
              await load();
            } catch (e) {
              pushToast(e.message || String(e), 'fail');
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === 'sim-webhook' ? 'Posting…' : 'Post WhatsApp fixture'}
        </button>
      </div>

      <div className="ar-layout">
        <div className="ar-list">
          <div className="ar-list-actions">
            <button type="button" className="btn btn-secondary" onClick={addRule}>
              Add rule
            </button>
            <button type="button" className="btn btn-ghost" onClick={exportJson}>
              Export
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => fileRef.current?.click()}
            >
              Import
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                importJson(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          {importDiff && (
            <p className="empty-hint" role="status">
              Import preview: +{(importDiff.added || []).length} added · −
              {(importDiff.removed || []).length} removed · {(importDiff.changed || []).length}{' '}
              changed — Save to apply.
            </p>
          )}
          {allTags.length > 0 && (
            <div className="ar-row" style={{ marginBottom: '0.5rem' }}>
              <label className="field inline">
                <span>Tag filter</span>
                <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                  <option value="">all tags</option>
                  {allTags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy === 'bulk'}
                onClick={() => bulkToggle(true)}
              >
                Enable shown
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy === 'bulk'}
                onClick={() => bulkToggle(false)}
              >
                Disable shown
              </button>
            </div>
          )}
          <ul className="ar-rules">
            {visibleRules.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`ar-rule ${r.id === selectedId ? 'active' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span className="name">{r.name || r.id}</span>
                  <span className="hint">
                    {r.enabled ? 'on' : 'off'} · {r.platform} · p{r.priority ?? 0}
                    {(r.tags || []).length ? ` · ${r.tags.join(',')}` : ''}
                    {r.canaryPercent != null && r.canaryPercent < 100
                      ? ` · ${r.canaryPercent}%`
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="ar-editor">
          {selected ? (
            <>
              <label className="field">
                <span>Name</span>
                <input
                  value={selected.name || ''}
                  onChange={(e) => updateSelected({ name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Id</span>
                <input
                  value={selected.id || ''}
                  onChange={(e) => updateSelected({ id: e.target.value })}
                />
              </label>
              <div className="ar-row">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(selected.enabled)}
                    onChange={(e) => updateSelected({ enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <label className="field inline">
                  <span>Platform</span>
                  <select
                    value={selected.platform || 'whatsapp'}
                    onChange={(e) => updateSelected({ platform: e.target.value })}
                  >
                    <option value="whatsapp">whatsapp</option>
                    <option value="facebook">facebook</option>
                  </select>
                </label>
                <label className="field inline">
                  <span>Scope</span>
                  <select
                    value={selected.scope || 'any'}
                    onChange={(e) => updateSelected({ scope: e.target.value })}
                  >
                    <option value="any">any</option>
                    <option value="dm">dm</option>
                    <option value="group">group</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Pattern (regex)</span>
                <input
                  value={selected.pattern || ''}
                  onChange={(e) => updateSelected({ pattern: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <div className="ar-row">
                <label className="field inline">
                  <span>Flags</span>
                  <input
                    value={selected.flags || ''}
                    onChange={(e) => updateSelected({ flags: e.target.value })}
                    placeholder="i"
                    spellCheck={false}
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={String(selected.flags || '').includes('i')}
                    onChange={(e) => {
                      let f = String(selected.flags || '').replace(/i/g, '');
                      if (e.target.checked) f += 'i';
                      updateSelected({ flags: f });
                    }}
                  />
                  Case-insensitive (i)
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={String(selected.flags || '').includes('m')}
                    onChange={(e) => {
                      let f = String(selected.flags || '').replace(/m/g, '');
                      if (e.target.checked) f += 'm';
                      updateSelected({ flags: f });
                    }}
                  />
                  Multiline (m)
                </label>
              </div>
              <label className="field">
                <span>Reply (use $1, $2 for captures)</span>
                <textarea
                  rows={3}
                  value={selected.reply || ''}
                  onChange={(e) => updateSelected({ reply: e.target.value })}
                />
              </label>
              <div className="ar-row">
                <label className="field inline">
                  <span>Cooldown (sec)</span>
                  <input
                    type="number"
                    min={0}
                    value={selected.cooldownSec ?? 0}
                    onChange={(e) => updateSelected({ cooldownSec: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="field inline">
                  <span>Priority</span>
                  <input
                    type="number"
                    value={selected.priority ?? 0}
                    onChange={(e) => updateSelected({ priority: Number(e.target.value) || 0 })}
                  />
                </label>
                <label className="field inline">
                  <span>Canary % (send to X% of chats)</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="100"
                    value={selected.canaryPercent ?? ''}
                    onChange={(e) =>
                      updateSelected({
                        canaryPercent: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="ar-row">
                <label className="field inline">
                  <span>Tags (comma-separated)</span>
                  <input
                    value={(selected.tags || []).join(', ')}
                    placeholder="internship, faq"
                    onChange={(e) => updateSelected({ tags: parseCommaList(e.target.value) })}
                  />
                </label>
                <label className="field inline">
                  <span>Language gate (blank = any)</span>
                  <input
                    value={selected.lang || ''}
                    placeholder="en"
                    onChange={(e) => updateSelected({ lang: e.target.value.trim() || null })}
                  />
                </label>
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(selected.requireMention)}
                    onChange={(e) => updateSelected({ requireMention: e.target.checked })}
                  />
                  Require @mention in groups
                </label>
              </div>
              <div className="ar-row">
                <label className="field inline">
                  <span>Quiet hours start (HH:MM, blank = off)</span>
                  <input
                    value={selected.quietHours?.start || ''}
                    placeholder="22:00"
                    onChange={(e) => {
                      const start = e.target.value.trim();
                      updateSelected({
                        quietHours: start
                          ? { start, end: selected.quietHours?.end || '07:00' }
                          : null,
                      });
                    }}
                  />
                </label>
                <label className="field inline">
                  <span>Quiet hours end</span>
                  <input
                    value={selected.quietHours?.end || ''}
                    placeholder="07:00"
                    disabled={!selected.quietHours?.start}
                    onChange={(e) =>
                      updateSelected({
                        quietHours: {
                          start: selected.quietHours?.start || '22:00',
                          end: e.target.value.trim() || '07:00',
                        },
                      })
                    }
                  />
                </label>
              </div>
              <label className="field">
                <span>
                  A/B reply variants (one per line, optional "weight|text"; blank = use Reply)
                </span>
                <textarea
                  rows={2}
                  value={variantsToLines(selected.replyVariants)}
                  placeholder={'2|Hey $1, apply today!\nHi $1 — details at {{tpl:cta}}'}
                  onChange={(e) =>
                    updateSelected({ replyVariants: parseVariantLines(e.target.value) })
                  }
                />
              </label>
              <div className="ar-list-actions">
                <button type="button" className="btn btn-ghost" onClick={runExplain}>
                  Explain pattern
                </button>
              </div>
              {explain && (
                <div className="ar-test-result" role="status">
                  <div className="result ok">
                    <span className="plat">regex</span>
                    <span className="id">
                      {explain.groupCount} capture group(s)
                      {(explain.namedGroups || []).length
                        ? ` · named: ${explain.namedGroups.join(', ')}`
                        : ''}
                      {explain.sample
                        ? explain.sample.matched
                          ? ` · sample matched: [${explain.sample.captures.slice(1).join(' | ')}]`
                          : ' · sample did NOT match'
                        : ''}
                    </span>
                  </div>
                </div>
              )}
              <div className="ar-keyword">
                <label className="field">
                  <span>Keyword → regex helper</span>
                  <input
                    value={keywordHelp}
                    onChange={(e) => setKeywordHelp(e.target.value)}
                    placeholder="internship, apply, join"
                  />
                </label>
                <button type="button" className="btn btn-ghost" onClick={applyKeywordHelper}>
                  Fill pattern
                </button>
              </div>
              <div className="ar-list-actions">
                <button type="button" className="btn btn-danger" onClick={deleteSelected}>
                  Delete rule
                </button>
              </div>
            </>
          ) : (
            <p className="empty-hint">Select or add a rule to edit.</p>
          )}

          <h3 style={{ marginTop: '1rem' }}>Settings</h3>
          <div className="ar-row">
            <label className="field inline">
              <span>Match mode</span>
              <select
                value={settings.matchMode || 'first'}
                onChange={(e) => setSettings((s) => ({ ...s, matchMode: e.target.value }))}
              >
                <option value="first">first match</option>
                <option value="all">all matches</option>
              </select>
            </label>
            <label className="field inline">
              <span>Max replies / hour</span>
              <input
                type="number"
                min={0}
                value={settings.maxRepliesPerHour ?? 60}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, maxRepliesPerHour: Number(e.target.value) || 0 }))
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Stop-words (comma-separated; skip all replies if present)</span>
            <input
              value={(settings.stopWords || []).join(', ')}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  stopWords: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                }))
              }
            />
          </label>
          <label className="field">
            <span>Ignore sender ids (comma-separated)</span>
            <input
              value={(settings.ignoreList || []).join(', ')}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  ignoreList: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                }))
              }
            />
          </label>
          <div className="ar-row">
            <label className="toggle">
              <input
                type="checkbox"
                checked={Boolean(settings.businessHours?.enabled)}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    businessHours: {
                      ...(s.businessHours || {
                        start: '09:00',
                        end: '18:00',
                        days: [1, 2, 3, 4, 5],
                      }),
                      enabled: e.target.checked,
                    },
                  }))
                }
              />
              Business hours only
            </label>
            <label className="field inline">
              <span>From</span>
              <input
                value={settings.businessHours?.start || '09:00'}
                disabled={!settings.businessHours?.enabled}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    businessHours: { ...(s.businessHours || {}), start: e.target.value },
                  }))
                }
              />
            </label>
            <label className="field inline">
              <span>To</span>
              <input
                value={settings.businessHours?.end || '18:00'}
                disabled={!settings.businessHours?.enabled}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    businessHours: { ...(s.businessHours || {}), end: e.target.value },
                  }))
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={Boolean(settings.approvalRequired)}
                onChange={(e) => setSettings((s) => ({ ...s, approvalRequired: e.target.checked }))}
              />
              Require operator approval before send
            </label>
          </div>
          <label className="field">
            <span>Escalation keywords (skip auto-reply; comma-separated)</span>
            <input
              value={(settings.escalationWords || []).join(', ')}
              placeholder="angry, refund, lawyer"
              onChange={(e) =>
                setSettings((s) => ({ ...s, escalationWords: parseCommaList(e.target.value) }))
              }
            />
          </label>
          <div className="ar-row">
            <label className="field inline">
              <span>Group mention tokens</span>
              <input
                value={(settings.mentionTokens || []).join(', ')}
                placeholder="@airepro"
                onChange={(e) =>
                  setSettings((s) => ({ ...s, mentionTokens: parseCommaList(e.target.value) }))
                }
              />
            </label>
            <label className="field inline">
              <span>Allowed link domains (blank = allow all)</span>
              <input
                value={(settings.allowedLinkDomains || []).join(', ')}
                placeholder="airepro.in"
                onChange={(e) =>
                  setSettings((s) => ({ ...s, allowedLinkDomains: parseCommaList(e.target.value) }))
                }
              />
            </label>
          </div>
          <label className="field">
            <span>Reply templates (one per line: id|text — reference with {'{{tpl:id}}'})</span>
            <textarea
              rows={2}
              value={(settings.templates || []).map((t) => `${t.id}|${t.text}`).join('\n')}
              placeholder="cta|Apply at https://airepro.in/view/internships"
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  templates: e.target.value
                    .split('\n')
                    .map((line) => {
                      const idx = line.indexOf('|');
                      if (idx < 1) return null;
                      return { id: line.slice(0, idx).trim(), text: line.slice(idx + 1).trim() };
                    })
                    .filter((t) => t && t.id && t.text),
                }))
              }
            />
          </label>

          <button
            type="button"
            className="btn btn-primary"
            disabled={busy === 'save'}
            onClick={saveAll}
          >
            {busy === 'save' ? 'Saving…' : 'Save rules'}
          </button>

          <h3 style={{ marginTop: '1.25rem' }}>Dry-run simulator</h3>
          <label className="field">
            <span>Inbound text</span>
            <textarea rows={2} value={testText} onChange={(e) => setTestText(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy === 'test'}
            onClick={runTest}
          >
            {busy === 'test' ? 'Testing…' : 'Test (dry-run)'}
          </button>
          {testResult && (
            <div className="ar-test-result">
              {(testResult.matches || []).length === 0 && <p className="empty-hint">No matches.</p>}
              {(testResult.matches || []).map((m) => (
                <div key={m.ruleId} className="result ok">
                  <span className="plat">{m.name || m.ruleId}</span>
                  <span className="id">{m.reply}</span>
                </div>
              ))}
            </div>
          )}

          <h3 style={{ marginTop: '1.25rem' }}>Approval queue</h3>
          <p className="empty-hint">
            When “Require operator approval” is on, matched replies wait here instead of sending.
          </p>
          <div className="ar-log">
            {approvals.filter((a) => a.status === 'pending').length === 0 && (
              <p className="empty-hint">No replies waiting for approval.</p>
            )}
            {approvals
              .filter((a) => a.status === 'pending')
              .slice(0, 10)
              .map((a) => (
                <div key={a.id} className="ar-log-row">
                  <span className="plat">{a.platform}</span>
                  <span className="id">to {a.to}</span>
                  <span className="id">{(a.reply || '').slice(0, 70)}</span>
                  <span>
                    <button
                      type="button"
                      className="btn-copy"
                      disabled={busy === 'approval'}
                      onClick={() => actOnApproval(a.id, 'approve')}
                    >
                      Approve
                    </button>{' '}
                    <button
                      type="button"
                      className="btn-copy"
                      disabled={busy === 'approval'}
                      onClick={() => actOnApproval(a.id, 'reject')}
                    >
                      Reject
                    </button>
                  </span>
                </div>
              ))}
          </div>

          <h3 style={{ marginTop: '1.25rem' }}>Human takeover</h3>
          <div className="ar-keyword">
            <label className="field">
              <span>Sender id / phone (pause auto-reply for this chat)</span>
              <input
                value={takeoverFrom}
                placeholder="15551234567"
                onChange={(e) => setTakeoverFrom(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => toggleTakeover(takeoverFrom, true)}
            >
              Pause chat
            </button>
          </div>
          <div className="ar-log">
            {Object.keys(takeovers).length === 0 && (
              <p className="empty-hint">No chats under takeover.</p>
            )}
            {Object.entries(takeovers).map(([chatKey, t]) => (
              <div key={chatKey} className="ar-log-row">
                <span className="plat">paused</span>
                <span className="id">{chatKey}</span>
                <span className="id">{t.ts}</span>
                <button
                  type="button"
                  className="btn-copy"
                  onClick={() => toggleTakeover(chatKey.split(':').slice(1).join(':'), false)}
                >
                  Resume
                </button>
              </div>
            ))}
          </div>

          <h3 style={{ marginTop: '1.25rem' }}>Recent match log</h3>
          <div className="ar-log">
            {log.length === 0 && <p className="empty-hint">No log entries yet.</p>}
            {log.slice(0, 12).map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className="ar-log-row">
                <span className="id">{entry.ts}</span>
                <span className="plat">{entry.platform}</span>
                <span className="id">{(entry.text || '').slice(0, 80)}</span>
                <span className="id">
                  {(entry.matches || []).map((m) => m.ruleId).join(', ') || '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
