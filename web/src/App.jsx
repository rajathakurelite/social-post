import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PLATFORM_KEYS = ['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp'];
const TWITTER_MAX = 280;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const emptySelection = () =>
  Object.fromEntries(PLATFORM_KEYS.map((p) => [p, p === 'facebook']));

async function api(path, options = {}) {
  const { signal, headers, body, ...rest } = options;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(path, {
    headers: isForm ? { ...(headers || {}) } : { 'Content-Type': 'application/json', ...(headers || {}) },
    body,
    signal,
    ...rest,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageDropzone({ upload, previewUrl, busy, onFile, onClear }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function validateAndSend(file) {
    if (!file) return;
    if (!ALLOWED_TYPES.has(file.type)) {
      onFile(null, new Error('Use JPEG, PNG, or WebP only'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onFile(null, new Error('Image must be 5 MB or smaller'));
      return;
    }
    onFile(file, null);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = e.dataTransfer?.files?.[0];
    validateAndSend(file);
  }

  if (upload && previewUrl) {
    return (
      <div className="dropzone has-file" role="group" aria-label="Uploaded image">
        <div className="dropzone-preview">
          <img src={previewUrl} alt="Upload preview" />
          <div className="dropzone-meta">
            <strong>{upload.name || upload.uploadId}</strong>
            <span className="dropzone-hint">
              {upload.size != null ? formatBytes(upload.size) : 'Ready'} · replaces auto creative for Facebook
            </span>
            <button type="button" className="btn-clear" disabled={busy} onClick={onClear}>
              Remove image
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`dropzone ${dragOver ? 'dragover' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={() => !busy && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-label="Upload optional image"
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={busy}
        onChange={(e) => {
          validateAndSend(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <span className="dropzone-title">Drop an image, or click to browse</span>
      <span className="dropzone-hint">
        Optional · JPEG / PNG / WebP · max 5 MB · any aspect (no crop). Leave empty to auto-generate
        Airepro creative.
      </span>
    </div>
  );
}

function PlatformCard({ platform, entry, onChange }) {
  const text = entry?.text || '';
  const isTwitter = platform === 'twitter';
  const count = isTwitter ? text.length : text.length;
  const over = isTwitter && count > TWITTER_MAX;
  const imageUrl = entry?.imageUrl || entry?.creativeUrl;

  return (
    <article className="post-card">
      <header>
        <h3>{platform}</h3>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {platform === 'facebook' && entry?.mode && <span className="pill">{entry.mode}</span>}
          {platform !== 'youtube' && (
            <span className={`char-count ${over ? 'over' : ''}`}>
              {isTwitter ? `${count} / ${TWITTER_MAX}` : `${count} chars`}
            </span>
          )}
        </div>
      </header>

      {platform === 'facebook' && imageUrl && (
        <>
          <div className="image-source">
            {entry.imageSource === 'upload' ? 'Operator upload' : 'Auto-generated Airepro creative'}
          </div>
          <div className="image-preview">
            <img src={imageUrl} alt="Facebook image preview" />
          </div>
        </>
      )}

      {platform === 'youtube' ? (
        <div className="yt-fields">
          <label className="field">
            <span>
              Title{' '}
              <span className="char-count">{(entry.title || '').length} chars</span>
            </span>
            <input
              type="text"
              value={entry.title || ''}
              onChange={(e) => onChange('title', e.target.value)}
            />
          </label>
          <label className="field">
            <span>
              Description{' '}
              <span className="char-count">{(entry.description || '').length} chars</span>
            </span>
            <textarea
              rows={5}
              value={entry.description || ''}
              onChange={(e) => onChange('description', e.target.value)}
            />
          </label>
        </div>
      ) : (
        <label className="field">
          <span>Text</span>
          <textarea
            rows={isTwitter ? 4 : 7}
            value={text}
            onChange={(e) => onChange('text', e.target.value)}
          />
        </label>
      )}
    </article>
  );
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind || 'info'}`}
          role="status"
          onClick={() => onDismiss(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [topic, setTopic] = useState('');
  const [notes, setNotes] = useState('');
  const [selected, setSelected] = useState(emptySelection);
  const [dryRun, setDryRun] = useState(true);
  const [posts, setPosts] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [publishResults, setPublishResults] = useState(null);
  const [upload, setUpload] = useState(null);
  const [localPreview, setLocalPreview] = useState(null);
  const [toasts, setToasts] = useState([]);
  const polishAbortRef = useRef(null);
  const toastTimers = useRef(new Map());

  const pushToast = useCallback((message, kind = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimers.current.delete(id);
    }, 4500);
    toastTimers.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id) => {
    const timer = toastTimers.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current.values()) clearTimeout(timer);
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  const loadHealth = useCallback(async () => {
    try {
      const data = await api('/api/health');
      setHealth(data);
      setHealthError(null);
      setSelected(() => {
        const next = emptySelection();
        for (const key of PLATFORM_KEYS) {
          const meta = data.platforms?.[key];
          if (meta?.enabled === false) next[key] = false;
        }
        // Default: Facebook on (if enabled); others off
        if (data.platforms?.facebook?.enabled === false) {
          next.facebook = false;
          const fallback = PLATFORM_KEYS.find((k) => data.platforms?.[k]?.enabled !== false);
          if (fallback) next[fallback] = true;
        } else {
          next.facebook = true;
        }
        return next;
      });
      setDryRun(true);
    } catch (e) {
      setHealthError(e.message || String(e));
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const selectedList = useMemo(
    () => PLATFORM_KEYS.filter((p) => selected[p]),
    [selected]
  );

  function togglePlatform(key) {
    const meta = health?.platforms?.[key];
    if (meta && meta.enabled === false) return;
    setSelected((s) => ({ ...s, [key]: !s[key] }));
  }

  async function handleFile(file, err) {
    if (err) {
      setError(err.message);
      pushToast(err.message, 'fail');
      return;
    }
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      if (localPreview) URL.revokeObjectURL(localPreview);
      const objectUrl = URL.createObjectURL(file);
      setLocalPreview(objectUrl);

      const form = new FormData();
      form.append('image', file);
      const data = await api('/api/upload', { method: 'POST', body: form });
      setUpload({
        uploadId: data.uploadId,
        url: data.url,
        name: file.name,
        size: data.size ?? file.size,
        mime: data.mime,
      });
      pushToast('Image uploaded', 'ok');
    } catch (e) {
      setUpload(null);
      if (localPreview) URL.revokeObjectURL(localPreview);
      setLocalPreview(null);
      setError(e.message || String(e));
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  function clearUpload() {
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(null);
    setUpload(null);
  }

  async function onPolish() {
    setError(null);
    setPublishResults(null);
    setBusy('polish');
    polishAbortRef.current?.abort();
    const controller = new AbortController();
    polishAbortRef.current = controller;
    try {
      const data = await api('/api/polish', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          topic,
          notes,
          platforms: selectedList,
          uploadId: upload?.uploadId || undefined,
        }),
      });
      setPosts(data.posts || {});
      pushToast('Copy polished — review before publish', 'ok');
    } catch (e) {
      if (e.name === 'AbortError') {
        pushToast('Polish cancelled', 'info');
      } else {
        setError(e.message || String(e));
        pushToast(e.message || String(e), 'fail');
      }
    } finally {
      if (polishAbortRef.current === controller) polishAbortRef.current = null;
      setBusy(null);
    }
  }

  function onCancelPolish() {
    polishAbortRef.current?.abort();
  }

  function updatePostField(platform, field, value) {
    setPosts((prev) => {
      const cur = { ...(prev || {}) };
      const entry = { ...(cur[platform] || {}) };
      entry[field] = value;
      if (platform === 'youtube' && (field === 'title' || field === 'description')) {
        entry.text = [entry.title || '', entry.description || ''].filter(Boolean).join('\n\n');
      }
      if (platform !== 'youtube' && field === 'text') {
        entry.text = value;
      }
      cur[platform] = entry;
      return cur;
    });
  }

  async function onPublish() {
    setError(null);
    setBusy('publish');
    try {
      const data = await api('/api/publish', {
        method: 'POST',
        body: JSON.stringify({
          dryRun,
          platforms: selectedList,
          uploadId: upload?.uploadId || posts?.facebook?.uploadId || undefined,
          posts,
        }),
      });
      setPublishResults(data);
      const allOk = data.ok;
      pushToast(
        data.dryRun
          ? allOk
            ? 'Dry-run OK — no live posts sent'
            : 'Dry-run finished with errors'
          : allOk
            ? 'Published successfully'
            : 'Publish finished with errors',
        allOk ? 'ok' : 'fail'
      );
    } catch (e) {
      setError(e.message || String(e));
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  const canPolish = topic.trim() && selectedList.length > 0 && !busy;
  const canPublish = posts && selectedList.length > 0 && !busy;
  const previewUrl = upload?.url || localPreview;

  return (
    <div className="app">
      <header className="brand">
        <p className="stage-label">Local operator</p>
        <h1 className="brand-mark">Airepro</h1>
        <p className="brand-tagline">
          Draft an angle, polish with Ollama, edit per platform, then dry-run or publish — localhost
          only.
        </p>
        <div className="status-row">
          {healthError && <span className="pill warn">API: {healthError}</span>}
          {health && (
            <>
              <span className={`pill ${health.ollama?.ok ? 'ok' : 'warn'}`}>
                Ollama {health.ollama?.ok ? 'ready' : 'down'}
                {health.ollama?.model ? ` · ${health.ollama.model}` : ''}
              </span>
              <span className="pill">Brand · {health.brand}</span>
              <span className="pill">FB · {health.facebookPostMode}</span>
            </>
          )}
        </div>
      </header>

      <section className="panel">
        <p className="stage-label">Compose</p>
        <h2>Draft &amp; polish</h2>

        <label className="field">
          <span>Topic / angle</span>
          <textarea
            rows={3}
            placeholder="e.g. Dream internship for students this summer"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Notes (optional)</span>
          <textarea
            rows={2}
            placeholder="Tone, must-include phrases, audience…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <span className="field-label" style={{ display: 'block', marginBottom: '0.4rem' }}>
          Image (Facebook only)
        </span>
        <ImageDropzone
          upload={upload}
          previewUrl={previewUrl}
          busy={Boolean(busy)}
          onFile={handleFile}
          onClear={clearUpload}
        />

        <h2 style={{ marginTop: '0.35rem' }}>Platforms</h2>
        <div className="platforms">
          {PLATFORM_KEYS.map((key) => {
            const meta = health?.platforms?.[key];
            const disabled = meta?.enabled === false;
            const configured = meta?.configured;
            return (
              <label
                key={key}
                className={`platform ${selected[key] ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={Boolean(selected[key])}
                  disabled={disabled}
                  onChange={() => togglePlatform(key)}
                />
                <span className="name">{key}</span>
                <span className="hint">
                  {disabled ? 'off' : configured ? 'ready' : 'creds?'}
                </span>
              </label>
            );
          })}
        </div>

        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={!canPolish} onClick={onPolish}>
            {busy === 'polish' ? 'Polishing…' : 'Polish'}
          </button>
          {busy === 'polish' && (
            <button type="button" className="btn btn-ghost" onClick={onCancelPolish}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canPublish}
            onClick={onPublish}
          >
            {busy === 'publish' ? 'Publishing…' : dryRun ? 'Dry-run publish' : 'Publish'}
          </button>
          <label className="toggle">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            Dry-run (skip live APIs)
          </label>
        </div>

        {error && <div className="error-banner">{error}</div>}
      </section>

      {busy === 'polish' && (
        <section className="panel" aria-busy="true" aria-live="polite">
          <div className="polish-status">
            <span className="spinner" aria-hidden="true" />
            Polishing with Ollama… this can take a minute.
          </div>
          <div className="skeleton-grid">
            {selectedList.map((p) => (
              <div key={p} className="skeleton-card">
                <span className="skel skel-title" />
                {p === 'facebook' && <span className="skel skel-media" />}
                <span className="skel skel-line" />
                <span className="skel skel-line" />
                <span className="skel skel-line short" />
              </div>
            ))}
          </div>
        </section>
      )}

      {posts && busy !== 'polish' && (
        <section className="panel">
          <p className="stage-label">Review</p>
          <h2>Editable platform cards</h2>
          <div className="cards-grid">
            {PLATFORM_KEYS.filter((p) => posts[p]).map((platform) => (
              <PlatformCard
                key={platform}
                platform={platform}
                entry={posts[platform]}
                onChange={(field, value) => updatePostField(platform, field, value)}
              />
            ))}
          </div>
        </section>
      )}

      {publishResults && (
        <section className="panel">
          <p className="stage-label">Results</p>
          <h2>{publishResults.dryRun ? 'Dry-run results' : 'Publish results'}</h2>
          <div className="result-list">
            {(publishResults.results || []).map((r) => (
              <div key={r.platform} className={`result ${r.ok ? 'ok' : 'fail'}`}>
                <span className="plat">{r.platform}</span>
                <span>{r.ok ? 'OK' : 'Failed'}</span>
                {r.id && <span className="id">id: {r.id}</span>}
                {r.imageSource && <span className="id">image: {r.imageSource}</span>}
                {r.error && <span className="id">{r.error}</span>}
                {r.preview && <span className="id">{r.preview}</span>}
                {r.imagePath && <span className="id">path: {r.imagePath}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
