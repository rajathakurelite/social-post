import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatBytes, formatCheckedAgo, downloadFile, cropImageFile } from './lib/api.js';
import {
  charStatus,
  splitThread,
  appendHashtags,
  suggestAltText,
  generateChapterHints,
  capYoutubeTags,
  packToMarkdown,
  markdownToPack,
  safePackFilename,
  failedPlatforms,
  validateScheduleTime,
  cropRect,
  wordDiff,
} from '../../skills/compose_tools.js';
import { EMOJI_PALETTE } from './lib/emojiPalette.js';
import {
  lintCaption,
  lintLineLength,
  lintBannedWords,
  lintHandles,
  lintUrls,
  hookScore,
  readingLevel,
  brandPresence,
} from '../../skills/content_lint.js';

const AutoReplyPanel = lazy(() => import('./AutoReplyPanel.jsx'));
const HistoryTab = lazy(() => import('./HistoryTab.jsx'));
const StatsTab = lazy(() => import('./StatsTab.jsx'));

const PLATFORM_KEYS = ['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp'];
const TWITTER_MAX = 280;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = 4;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DRAFT_KEY = 'airepro-compose-draft-v1';
const STAGES = ['compose', 'polish', 'review', 'publish'];
const TONES = ['formal', 'neutral', 'playful'];
const CROP_PRESETS = ['original', '1:1', '4:5', '1.91:1'];

const emptySelection = () => Object.fromEntries(PLATFORM_KEYS.map((p) => [p, p === 'facebook']));

function loadDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveDraft(payload) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

function copyTextForPlatform(platform, entry) {
  if (!entry) return '';
  if (platform === 'youtube') {
    return [entry.title || '', entry.description || ''].filter(Boolean).join('\n\n');
  }
  return entry.text || '';
}

function countCaptionLines(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\n/).filter((l) => l.trim()).length;
}

/** Feature 128/139/141–146: aggregate lint + score data for one review card. */
function computeCardLint(platform, entry, lintConfig) {
  const text = copyTextForPlatform(platform, entry);
  if (!text) {
    return { warnings: [], bannedHits: [], hook: null, reading: null, brandMissing: false };
  }
  const warnings = [];
  for (const w of lintCaption(text).warnings) warnings.push(w.message);
  if (platform === 'facebook') {
    const { longLines } = lintLineLength(text, 90);
    if (longLines.length) {
      warnings.push(
        `Line ${longLines[0].index + 1} is ${longLines[0].length} chars — keep caption lines under ~90 so the 3-line creative stays scannable`
      );
    }
  }
  const { unknown } = lintHandles(text, lintConfig.handleAllowlist || []);
  for (const h of unknown)
    warnings.push(`Unknown handle ${h} — typo? (allowlist: config/content_lint.json)`);
  const { invalid } = lintUrls(text);
  for (const u of invalid) warnings.push(`URL problem: ${u.url} (${u.reason})`);
  const bannedHits = lintBannedWords(text, lintConfig.bannedWords || []).hits;
  const brand = brandPresence(text);
  const hook = hookScore(text);
  const reading = platform === 'linkedin' ? readingLevel(text) : null;
  return { warnings, bannedHits, hook, reading, brandMissing: !brand.present };
}

function ImageDropzone({
  uploads,
  localPreviews,
  busy,
  cropPreset,
  onCropPreset,
  altText,
  onAltText,
  onSuggestAlt,
  onFiles,
  onClearOne,
  onClearAll,
  onPreview,
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function validateAndSend(fileList) {
    const files = Array.from(fileList || []).slice(0, MAX_UPLOAD_FILES);
    if (!files.length) return;
    if (uploads.length + files.length > MAX_UPLOAD_FILES) {
      onFiles(null, new Error(`Up to ${MAX_UPLOAD_FILES} images per draft`));
      return;
    }
    for (const file of files) {
      if (!ALLOWED_TYPES.has(file.type)) {
        onFiles(null, new Error('Use JPEG, PNG, or WebP only'));
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        onFiles(null, new Error('Each image must be 5 MB or smaller'));
        return;
      }
    }
    onFiles(files, null);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    validateAndSend(e.dataTransfer?.files);
  }

  return (
    <div className="dropzone-wrap">
      {uploads.length > 0 && (
        <div className="dropzone has-file" role="group" aria-label="Uploaded images (ordered)">
          <ol className="upload-list">
            {uploads.map((u, i) => (
              <li key={u.uploadId} className="upload-item">
                <button
                  type="button"
                  className="img-open"
                  onClick={() => onPreview?.(u.url)}
                  aria-label={`Open image ${i + 1} lightbox`}
                >
                  <img src={u.url} alt={altText || `Upload ${i + 1} preview`} />
                </button>
                <div className="dropzone-meta">
                  <strong>
                    {i === 0 ? '1st (primary) · ' : `${i + 1} · `}
                    {u.name || u.uploadId}
                  </strong>
                  <span className="dropzone-hint">
                    {u.size != null ? formatBytes(u.size) : 'Ready'}
                  </span>
                  <button
                    type="button"
                    className="btn-clear"
                    disabled={Boolean(busy)}
                    onClick={() => onClearOne(u.uploadId)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <div className="dropzone-meta" style={{ marginTop: '0.4rem' }}>
            <span className="dropzone-hint">
              First image replaces the auto creative for Facebook.
            </span>
            <button
              type="button"
              className="btn-clear"
              disabled={Boolean(busy)}
              onClick={onClearAll}
            >
              Remove all images
            </button>
          </div>
        </div>
      )}

      {uploads.length < MAX_UPLOAD_FILES && (
        <div
          className={`dropzone ${dragOver ? 'dragover' : ''} ${busy === 'upload' ? 'busy' : ''}`}
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
          aria-label="Upload optional images (up to 4)"
          aria-busy={busy === 'upload'}
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={Boolean(busy)}
            onChange={(e) => {
              validateAndSend(e.target.files);
              e.target.value = '';
            }}
          />
          {busy === 'upload' ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="dropzone-title">Uploading…</span>
              <span className="dropzone-hint">Sending image(s) to local API</span>
            </>
          ) : (
            <>
              <span className="dropzone-title">
                {localPreviews.length ? 'Add another image' : 'Drop images, or click to browse'}
              </span>
              <span className="dropzone-hint">
                Optional · JPEG / PNG / WebP · max 5 MB each · up to {MAX_UPLOAD_FILES} for
                Facebook. Leave empty to auto-generate an Airepro creative.
              </span>
            </>
          )}
        </div>
      )}

      <div className="upload-tools">
        <fieldset className="crop-presets">
          <legend>Crop preset (applied on upload)</legend>
          {CROP_PRESETS.map((r) => (
            <label key={r} className="toggle">
              <input
                type="radio"
                name="crop-preset"
                value={r}
                checked={cropPreset === r}
                onChange={() => onCropPreset(r)}
              />
              {r === 'original' ? 'Original' : r}
            </label>
          ))}
        </fieldset>
        <label className="field alt-field">
          <span>Alt text (Facebook image accessibility)</span>
          <div className="alt-row">
            <input
              type="text"
              value={altText}
              maxLength={500}
              placeholder="Describe the image for screen readers"
              onChange={(e) => onAltText(e.target.value)}
            />
            <button type="button" className="btn btn-ghost" onClick={onSuggestAlt}>
              Suggest from caption
            </button>
          </div>
        </label>
      </div>
    </div>
  );
}

/** Feature 122: numbered thread bubbles for over-limit X drafts. */
function ThreadPreview({ text }) {
  const parts = useMemo(() => splitThread(text, TWITTER_MAX), [text]);
  if (parts.length < 2) return null;
  return (
    <div
      className="thread-preview"
      role="group"
      aria-label={`Thread preview, ${parts.length} parts`}
    >
      <p className="line-hint">
        Over {TWITTER_MAX} chars — would post as a {parts.length}-part thread:
      </p>
      {parts.map((p, i) => (
        <div key={i} className="thread-bubble">
          <span className="thread-text">{p}</span>
          <span className="char-count">
            {p.length} / {TWITTER_MAX}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Feature 140: lightweight in-review platform preview mocks. */
function PreviewMock({ platform, entry, imageUrl }) {
  const text = copyTextForPlatform(platform, entry);
  if (platform === 'twitter') {
    return (
      <div className="mock mock-x">
        <div className="mock-head">
          <span className="mock-avatar" aria-hidden="true">
            A
          </span>
          <span>
            <strong>Airepro</strong> <span className="mock-dim">@airepro · now</span>
          </span>
        </div>
        <p className="mock-body">{text}</p>
      </div>
    );
  }
  if (platform === 'linkedin') {
    return (
      <div className="mock mock-li">
        <div className="mock-head">
          <span className="mock-avatar li" aria-hidden="true">
            A
          </span>
          <span>
            <strong>Airepro</strong>
            <br />
            <span className="mock-dim">Internships &amp; freelance · now</span>
          </span>
        </div>
        <p className="mock-body">{text}</p>
      </div>
    );
  }
  if (platform === 'whatsapp') {
    return (
      <div className="mock mock-wa">
        <div className="mock-wa-bubble">
          <p className="mock-body">{text}</p>
          <span className="mock-dim">12:00 ✓✓</span>
        </div>
      </div>
    );
  }
  if (platform === 'youtube') {
    return (
      <div className="mock mock-yt">
        <div className="mock-yt-thumb" aria-hidden="true">
          ▶
        </div>
        <div>
          <strong className="mock-body">{entry.title || 'Title'}</strong>
          <p className="mock-dim">{(entry.description || '').slice(0, 120)}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mock mock-fb">
      <div className="mock-head">
        <span className="mock-avatar fb" aria-hidden="true">
          A
        </span>
        <span>
          <strong>Airepro</strong>
          <br />
          <span className="mock-dim">Sponsored · just now</span>
        </span>
      </div>
      <p className="mock-body">{text}</p>
      {imageUrl && <img className="mock-img" src={imageUrl} alt="Creative preview" />}
    </div>
  );
}

function PlatformCard({
  platform,
  entry,
  edited,
  originalEntry,
  regenBusy,
  hashtagPacks,
  lint,
  onChange,
  onPreview,
  onRegenerate,
  onPickVariant,
  pushToast,
}) {
  const text = entry?.text || '';
  const isTwitter = platform === 'twitter';
  const imageUrl = entry?.imageUrl || entry?.creativeUrl;
  const [copied, setCopied] = useState(false);
  const [showMock, setShowMock] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [packId, setPackId] = useState('');
  const textAreaRef = useRef(null);
  const lines = platform === 'facebook' ? countCaptionLines(text) : 0;

  // Feature 129: per-platform character budgets beyond the Twitter gate.
  const status = charStatus(platform, text);
  const over = Boolean(status.limit && status.over);

  const origText =
    platform === 'youtube'
      ? `${originalEntry?.title || ''}\n${originalEntry?.description || ''}`
      : originalEntry?.text || '';
  const currText =
    platform === 'youtube' ? `${entry?.title || ''}\n${entry?.description || ''}` : text;
  const diffParts = useMemo(
    () => (showDiff && originalEntry ? wordDiff(origText, currText) : []),
    [showDiff, originalEntry, origText, currText]
  );

  async function onCopy() {
    const payload = copyTextForPlatform(platform, entry);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  /** Feature 154: insert curated emoji at cursor. */
  function insertEmoji(emoji) {
    const el = textAreaRef.current;
    if (platform === 'youtube') {
      const desc = entry.description || '';
      const next = `${desc}${emoji}`;
      onChange('description', next);
      return;
    }
    if (!el) {
      onChange('text', `${text}${emoji}`);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    onChange('text', next);
    requestAnimationFrame(() => {
      try {
        el.focus();
        const pos = start + emoji.length;
        el.setSelectionRange(pos, pos);
      } catch {
        /* ignore */
      }
    });
  }

  /** Feature 111: append a hashtag pack without breaking the platform cap. */
  function addPack() {
    const pack = hashtagPacks.find((p) => p.id === packId);
    if (!pack) return;
    const max = pack.perPlatformMax?.[platform];
    const tags = max ? pack.tags.slice(0, max) : pack.tags;
    const next = appendHashtags(text, tags, platform);
    if (next === text) {
      pushToast('No room for more hashtags within the character limit', 'info');
      return;
    }
    onChange('text', next);
  }

  /** Feature 123: append 00:00-style chapter hints to the YouTube description. */
  function insertChapters() {
    const desc = entry.description || '';
    if (/^\d{2}:\d{2}\s/m.test(desc)) {
      pushToast('Description already has chapter timestamps', 'info');
      return;
    }
    const chapters = generateChapterHints(desc);
    if (!chapters.length) {
      pushToast('Write a description first — chapters derive from it', 'info');
      return;
    }
    onChange('description', `${desc.trim()}\n\nChapters:\n${chapters.join('\n')}`);
  }

  return (
    <article className={`post-card ${edited ? 'edited' : ''}`}>
      <header>
        <h3>
          {platform}
          {edited && <span className="edited-badge">Edited</span>}
        </h3>
        <div className="card-meta">
          {platform === 'facebook' && entry?.mode && <span className="pill">{entry.mode}</span>}
          {platform === 'facebook' && (
            <span className={`char-count ${lines === 3 ? 'ok-lines' : lines > 3 ? 'over' : ''}`}>
              {lines} / 3 lines
            </span>
          )}
          {platform !== 'youtube' && (
            <span className={`char-count ${over ? 'over' : ''}`}>
              {status.limit ? `${status.count} / ${status.limit}` : `${status.count} chars`}
            </span>
          )}
          {lint?.hook && (
            <span
              className="pill hook-badge"
              title={`Hook score (first line): ${lint.hook.factors.join(', ') || 'weak hook'}`}
            >
              hook {lint.hook.score}
            </span>
          )}
          {lint?.reading && (
            <span className="pill" title={`Flesch reading ease ${Math.round(lint.reading.score)}`}>
              read · {lint.reading.band}
            </span>
          )}
          <button
            type="button"
            className="btn-copy"
            onClick={onCopy}
            aria-label={`Copy ${platform} copy`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="btn-copy"
            onClick={() => setShowMock((v) => !v)}
            aria-expanded={showMock}
            aria-label={`Toggle ${platform} preview mock`}
          >
            {showMock ? 'Hide preview' : 'Preview'}
          </button>
          <button
            type="button"
            className="btn-copy"
            disabled={Boolean(regenBusy)}
            onClick={() => onRegenerate(platform)}
            aria-label={`Regenerate ${platform} copy only`}
          >
            {regenBusy === platform ? (
              <>
                <span className="spinner spinner-sm" aria-hidden="true" /> Regenerating…
              </>
            ) : (
              'Regenerate'
            )}
          </button>
          {originalEntry && (
            <button
              type="button"
              className="btn-copy"
              onClick={() => setShowDiff((v) => !v)}
              aria-pressed={showDiff}
            >
              {showDiff ? 'Hide diff' : 'Diff'}
            </button>
          )}
        </div>
      </header>

      {/* Feature 154: curated emoji palette */}
      <div className="emoji-palette" role="group" aria-label="Brand-safe emoji">
        {EMOJI_PALETTE.map((em) => (
          <button
            key={em}
            type="button"
            className="emoji-btn"
            onClick={() => insertEmoji(em)}
            aria-label={`Insert ${em}`}
          >
            {em}
          </button>
        ))}
      </div>

      {/* Feature 156: word-level edit diff */}
      {showDiff && (
        <pre className="edit-diff" aria-live="polite">
          {diffParts.map((p, i) => (
            <span key={i} className={`diff-${p.type}`}>
              {p.value}
            </span>
          ))}
        </pre>
      )}

      {isTwitter && over && (
        <p className="inline-warn" role="alert">
          Over {TWITTER_MAX} characters — shorten before publish, or publish as a thread manually.
        </p>
      )}
      {!isTwitter && over && (
        <p className="inline-warn" role="alert">
          Over the {platform} limit of {status.limit} characters.
        </p>
      )}

      {/* Feature 128/139/142/143/146: caption lint + brand presence warnings. */}
      {lint && (lint.warnings.length > 0 || lint.brandMissing || lint.bannedHits.length > 0) && (
        <ul className="lint-list">
          {lint.bannedHits.map((w) => (
            <li key={`banned-${w}`} className="lint-item lint-blocked" role="alert">
              Banned/claim word: “{w}” — publish is blocked until acknowledged
            </li>
          ))}
          {lint.brandMissing && (
            <li className="lint-item">Card never names Airepro or links airepro.in</li>
          )}
          {lint.warnings.map((w, i) => (
            <li key={i} className="lint-item">
              {w}
            </li>
          ))}
        </ul>
      )}

      {platform === 'facebook' && (
        <p className="line-hint">
          Brand brief targets a short ~3-line visual caption.{' '}
          {lines < 3
            ? 'Add a line if needed.'
            : lines > 3
              ? 'Consider tightening to 3 lines.'
              : 'Nice — on target.'}
        </p>
      )}

      {platform === 'facebook' && imageUrl && (
        <>
          <div className="image-source">
            {entry.imageSource === 'upload' ? 'Operator upload' : 'Auto-generated Airepro creative'}
          </div>
          <button
            type="button"
            className="image-preview img-open"
            onClick={() => onPreview?.(imageUrl)}
          >
            <img src={imageUrl} alt="Facebook image preview — click to enlarge" />
          </button>
        </>
      )}

      {/* Feature 125: creative variant A/B picker. */}
      {platform === 'facebook' && (entry?.creativeVariants || []).length > 1 && (
        <fieldset className="variant-picker">
          <legend>Creative variant (used for Facebook publish)</legend>
          <div className="variant-row">
            {entry.creativeVariants.map((v) => {
              const active = entry.creativePath === v.path;
              return (
                <label key={v.path} className={`variant-option ${active ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="creative-variant"
                    checked={active}
                    onChange={() => onPickVariant(v)}
                  />
                  <img src={v.url} alt={`Variant — ${v.theme} theme`} />
                  <span>{v.theme}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {platform === 'youtube' ? (
        <div className="yt-fields">
          <label className="field">
            <span>
              Title{' '}
              <span
                className={`char-count ${charStatus('youtubeTitle', entry.title || '').over ? 'over' : ''}`}
              >
                {(entry.title || '').length} / 100
              </span>
            </span>
            <input
              type="text"
              data-first-field={platform}
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
          <div className="card-actions">
            <button type="button" className="btn btn-ghost" onClick={insertChapters}>
              Insert chapter hints
            </button>
          </div>
          <label className="field">
            <span>
              Tags (comma-separated, ≤ 500 chars total){' '}
              <span className="char-count">{(entry.tags || '').length} / 500</span>
            </span>
            <input
              type="text"
              value={entry.tags || ''}
              placeholder="internships, careers, airepro"
              onChange={(e) => onChange('tags', e.target.value)}
              onBlur={(e) => onChange('tags', capYoutubeTags(e.target.value))}
            />
          </label>
        </div>
      ) : (
        <label className="field">
          <span>Text</span>
          <textarea
            rows={isTwitter ? 4 : 7}
            data-first-field={platform}
            ref={textAreaRef}
            value={text}
            onChange={(e) => onChange('text', e.target.value)}
          />
        </label>
      )}

      {/* Feature 119: LinkedIn suggested first comment — copy-only. */}
      {platform === 'linkedin' && entry?.firstComment != null && entry.firstComment !== '' && (
        <label className="field">
          <span>
            Suggested first comment (copy-only, never auto-posted){' '}
            <button
              type="button"
              className="btn-copy"
              onClick={() => navigator.clipboard.writeText(entry.firstComment).catch(() => {})}
            >
              Copy comment
            </button>
          </span>
          <textarea
            rows={2}
            value={entry.firstComment}
            onChange={(e) => onChange('firstComment', e.target.value)}
          />
        </label>
      )}

      {/* Feature 120: WhatsApp template vs freeform flag. */}
      {platform === 'whatsapp' && (
        <div className="ar-row">
          <label className="field inline">
            <span>Message type</span>
            <select
              value={entry.messageType || 'freeform'}
              onChange={(e) => onChange('messageType', e.target.value)}
            >
              <option value="freeform">freeform (24h window)</option>
              <option value="template">template (outside window)</option>
            </select>
          </label>
          {(entry.messageType || 'freeform') === 'template' && (
            <label className="field inline">
              <span>Template name (required)</span>
              <input
                type="text"
                value={entry.templateName || ''}
                placeholder="welcome_v1"
                onChange={(e) => onChange('templateName', e.target.value)}
              />
            </label>
          )}
        </div>
      )}

      {isTwitter && <ThreadPreview text={text} />}

      {platform !== 'youtube' && hashtagPacks.length > 0 && (
        <div className="pack-row">
          <label className="field inline">
            <span>Hashtag pack</span>
            <select value={packId} onChange={(e) => setPackId(e.target.value)}>
              <option value="">choose…</option>
              {hashtagPacks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-ghost" disabled={!packId} onClick={addPack}>
            Add tags
          </button>
        </div>
      )}

      {showMock && <PreviewMock platform={platform} entry={entry} imageUrl={imageUrl} />}
    </article>
  );
}

function ToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind || 'info'}`} role="status">
          <span>{t.message}</span>
          <button
            type="button"
            className="toast-dismiss"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function ConfirmModal({ open, title, body, confirmLabel, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);
  const previousFocus = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocus.current = document.activeElement;
    confirmRef.current?.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusable).filter((el) => !el.disabled);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      const prev = previousFocus.current;
      if (prev && typeof prev.focus === 'function') prev.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Lightbox({ src, onClose }) {
  useEffect(() => {
    if (!src) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  if (!src) return null;
  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        aria-label="Close lightbox"
        onClick={onClose}
      >
        ×
      </button>
      <img src={src} alt="Fullscreen preview" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

function WorkflowStepper({ stage }) {
  const idx = STAGES.indexOf(stage);
  return (
    <nav className="stepper" aria-label="Workflow stages">
      {STAGES.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'current' : 'upcoming';
        return (
          <div
            key={s}
            className={`step ${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="step-index" aria-hidden="true">
              {i + 1}
            </span>
            <span className="step-label">{s}</span>
          </div>
        );
      })}
    </nav>
  );
}

function ResultRow({ r }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  async function copyError() {
    try {
      await navigator.clipboard.writeText(r.error || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  /** Feature 168: copy post id / permalink from successful result. */
  async function copyReceipt() {
    const text = [r.id, r.permalink].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text || '');
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className={`result ${r.ok ? 'ok' : 'fail'}`}>
      <button
        type="button"
        className="result-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="plat">{r.platform}</span>
        <span>
          {r.ok ? 'OK' : 'Failed'}
          {r.dryRun === false ? ' · LIVE' : ''}
        </span>
        <span className="id">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <div className="result-details">
          {r.id && (
            <div className="result-error-row">
              <div className="id">id: {r.id}</div>
              <button type="button" className="btn-copy" onClick={copyReceipt}>
                {copiedId ? 'Copied' : 'Copy id'}
              </button>
            </div>
          )}
          {r.permalink && <div className="id">permalink: {r.permalink}</div>}
          {r.imageSource && <div className="id">imageSource: {r.imageSource}</div>}
          {r.altText && <div className="id">altText: {r.altText}</div>}
          {r.templateName && <div className="id">template: {r.templateName}</div>}
          {r.preview && <div className="id">preview: {r.preview}</div>}
          {r.payload && (
            <pre className="id" style={{ whiteSpace: 'pre-wrap' }}>
              payload: {JSON.stringify(r.payload, null, 0).slice(0, 400)}
            </pre>
          )}
          {r.imagePath && <div className="id">path: {r.imagePath}</div>}
          {r.error && (
            <div className="result-error-row">
              <span className="id">{r.error}</span>
              <button type="button" className="btn-copy" onClick={copyError}>
                {copied ? 'Copied' : 'Copy error'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const draft = useMemo(() => loadDraft(), []);
  const [mainTab, setMainTab] = useState('compose');
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState(null);
  const [healthTick, setHealthTick] = useState(0);
  const [topic, setTopic] = useState(draft?.topic || '');
  const [notes, setNotes] = useState(draft?.notes || '');
  const [selected, setSelected] = useState(() => draft?.selected || emptySelection());
  const [dryRun, setDryRun] = useState(draft?.dryRun !== undefined ? Boolean(draft.dryRun) : true);
  const [tone, setTone] = useState(draft?.tone || 'neutral');
  const [language, setLanguage] = useState(draft?.language || 'en');
  const [lengthPreset, setLengthPreset] = useState(draft?.length || 'medium');
  const [showKeys, setShowKeys] = useState(false);
  const [packImportText, setPackImportText] = useState('');
  const [originalPosts, setOriginalPosts] = useState(null);
  const [creativeTemplate, setCreativeTemplate] = useState(draft?.creativeTemplate || 'classic');
  const [creativeTheme, setCreativeTheme] = useState(draft?.creativeTheme || 'magenta');
  const [posts, setPosts] = useState(null);
  const [editedPlatforms, setEditedPlatforms] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  /** Feature 157: polish progress stages. */
  const [polishStage, setPolishStage] = useState(null);
  const [regenBusy, setRegenBusy] = useState(null);
  const [error, setError] = useState(null);
  const [publishResults, setPublishResults] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [localPreviews, setLocalPreviews] = useState([]);
  const [altText, setAltText] = useState('');
  const [cropPreset, setCropPreset] = useState('original');
  const [toasts, setToasts] = useState([]);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmRemoveImage, setConfirmRemoveImage] = useState(false);
  const [duplicateWarn, setDuplicateWarn] = useState(null);
  const [showTopicHint, setShowTopicHint] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [lintConfig, setLintConfig] = useState({ bannedWords: [], handleAllowlist: [] });
  const [hashtagPacks, setHashtagPacks] = useState([]);
  const [bestTimes, setBestTimes] = useState({});
  const [topicChips, setTopicChips] = useState([]);
  const [topicHistory, setTopicHistory] = useState([]);
  const [utm, setUtm] = useState({ enabled: false, campaign: 'airepro' });
  const [diskDrafts, setDiskDrafts] = useState([]);
  const [draftName, setDraftName] = useState('');
  const [scheduleAt, setScheduleAt] = useState('');
  const [showAdvancedDry, setShowAdvancedDry] = useState(false);
  const [dryRunByPlatform, setDryRunByPlatform] = useState({});
  const [ackBanned, setAckBanned] = useState(false);
  const polishAbortRef = useRef(null);
  const toastTimers = useRef(new Map());
  const reviewRef = useRef(null);
  const topicRef = useRef(null);
  const healthBootstrapped = useRef(false);
  const dirtyEdited = useRef(false);

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

  const dismissNewestToast = useCallback(() => {
    setToasts((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      const timer = toastTimers.current.get(last.id);
      if (timer) clearTimeout(timer);
      toastTimers.current.delete(last.id);
      return prev.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of toastTimers.current.values()) clearTimeout(timer);
      for (const url of localPreviews) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    saveDraft({ topic, notes, selected, dryRun, tone, creativeTemplate, creativeTheme });
  }, [topic, notes, selected, dryRun, tone, creativeTemplate, creativeTheme]);

  useEffect(() => {
    dirtyEdited.current = editedPlatforms.size > 0 && !publishResults;
  }, [editedPlatforms, publishResults]);

  useEffect(() => {
    function onBeforeUnload(e) {
      if (!dirtyEdited.current) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setHealthTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);

  const loadHealth = useCallback(
    async ({ preserveSelection = false } = {}) => {
      try {
        const data = await api('/api/health');
        setHealth(data);
        setHealthError(null);
        setHealthCheckedAt(Date.now());
        if (data.utm) setUtm(data.utm);
        // Feature 116: pinned dry-run — the live toggle is removed, dryRun always true.
        if (data.forceDryRun) setDryRun(true);
        if (!preserveSelection && !healthBootstrapped.current) {
          healthBootstrapped.current = true;
          if (!draft?.selected) {
            setSelected(() => {
              const next = emptySelection();
              for (const key of PLATFORM_KEYS) {
                const meta = data.platforms?.[key];
                if (meta?.enabled === false) next[key] = false;
              }
              if (data.platforms?.facebook?.enabled === false) {
                next.facebook = false;
                const fallback = PLATFORM_KEYS.find((k) => data.platforms?.[k]?.enabled !== false);
                if (fallback) next[fallback] = true;
              } else {
                next.facebook = true;
              }
              return next;
            });
          }
          if (draft?.dryRun === undefined) {
            setDryRun(true);
          }
        }
      } catch (e) {
        setHealthError(e.message || String(e));
        setHealthCheckedAt(Date.now());
      }
    },
    [draft?.selected, draft?.dryRun]
  );

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  // One-shot compose metadata: lint config, hashtag packs, best times, chips, topics, drafts.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const [lintCfg, packs, times, chips, topics, drafts] = await Promise.allSettled([
        api('/api/compose/lint-config'),
        api('/api/compose/hashtag-packs'),
        api('/api/compose/best-times'),
        api('/api/compose/topic-chips'),
        api('/api/publish/topics'),
        api('/api/drafts'),
      ]);
      if (!mounted) return;
      if (lintCfg.status === 'fulfilled') {
        setLintConfig({
          bannedWords: lintCfg.value.bannedWords || [],
          handleAllowlist: lintCfg.value.handleAllowlist || [],
        });
      }
      if (packs.status === 'fulfilled') setHashtagPacks(packs.value.packs || []);
      if (times.status === 'fulfilled') setBestTimes(times.value.hints || {});
      if (chips.status === 'fulfilled') setTopicChips((chips.value.chips || []).slice(0, 8));
      if (topics.status === 'fulfilled') setTopicHistory(topics.value.topics || []);
      if (drafts.status === 'fulfilled') setDiskDrafts(drafts.value.drafts || []);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const selectedList = useMemo(() => PLATFORM_KEYS.filter((p) => selected[p]), [selected]);

  const twitterOverLimit = useMemo(() => {
    if (!selected.twitter || !posts?.twitter) return false;
    return (posts.twitter.text || '').length > TWITTER_MAX;
  }, [selected.twitter, posts]);

  // Feature 128/141–146: card lint results (recomputed on edit).
  const cardLints = useMemo(() => {
    if (!posts) return {};
    const out = {};
    for (const p of PLATFORM_KEYS) {
      if (posts[p]) out[p] = computeCardLint(p, posts[p], lintConfig);
    }
    return out;
  }, [posts, lintConfig]);

  // Feature 141: banned words block publish until acknowledged.
  const bannedBlocked = useMemo(
    () => selectedList.some((p) => (cardLints[p]?.bannedHits || []).length > 0),
    [selectedList, cardLints]
  );

  useEffect(() => {
    setAckBanned(false);
  }, [posts]);

  const stage = useMemo(() => {
    if (busy === 'publish') return 'publish';
    if (busy === 'polish') return 'polish';
    if (publishResults) return 'publish';
    if (posts) return 'review';
    return 'compose';
  }, [busy, posts, publishResults]);

  const busyLiveMessage = useMemo(() => {
    if (busy === 'polish') return 'Polishing with Ollama';
    if (busy === 'upload') return 'Uploading image';
    if (busy === 'publish') return dryRun ? 'Dry-run publishing' : 'Publishing live';
    if (regenBusy) return `Regenerating ${regenBusy}`;
    return '';
  }, [busy, dryRun, regenBusy]);

  function togglePlatform(key) {
    const meta = health?.platforms?.[key];
    if (meta && meta.enabled === false) return;
    setSelected((s) => ({ ...s, [key]: !s[key] }));
  }

  function selectAllPlatforms() {
    setSelected(() => {
      const next = {};
      for (const key of PLATFORM_KEYS) {
        const meta = health?.platforms?.[key];
        next[key] = !(meta && meta.enabled === false);
      }
      return next;
    });
  }

  function clearPlatforms() {
    setSelected(Object.fromEntries(PLATFORM_KEYS.map((p) => [p, false])));
  }

  function resetDraft() {
    setTopic('');
    setNotes('');
    setPosts(null);
    setEditedPlatforms(new Set());
    setPublishResults(null);
    setError(null);
    setShowTopicHint(false);
    for (const url of localPreviews) URL.revokeObjectURL(url);
    setLocalPreviews([]);
    setUploads([]);
    setAltText('');
    setDryRun(true);
    setTone('neutral');
    setScheduleAt('');
    setDryRunByPlatform({});
    setSelected(emptySelection());
    setConfirmLive(false);
    pushToast('Draft reset', 'info');
  }

  async function handleFiles(files, err) {
    if (err) {
      setError(err.message);
      pushToast(err.message, 'fail');
      return;
    }
    if (!files || !files.length) return;
    setError(null);
    setBusy('upload');
    try {
      const form = new FormData();
      const newPreviews = [];
      for (const file of files) {
        // Feature 137: apply the selected crop preset client-side before upload.
        const cropped = await cropImageFile(file, cropPreset, cropRect);
        form.append('image', cropped, cropped.name);
        newPreviews.push(URL.createObjectURL(cropped));
      }
      if (altText) form.append('altText', altText);
      const data = await api('/api/upload', { method: 'POST', body: form });
      const added = (data.uploads || []).map((u, i) => ({
        ...u,
        name: files[i]?.name || u.uploadId,
      }));
      setUploads((prev) => [...prev, ...added].slice(0, MAX_UPLOAD_FILES));
      setLocalPreviews((prev) => [...prev, ...newPreviews]);
      pushToast(`${added.length} image${added.length > 1 ? 's' : ''} uploaded`, 'ok');
    } catch (e) {
      setError(e.message || String(e));
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  function requestClearUpload() {
    const wired = Boolean(
      posts?.facebook && (posts.facebook.uploadId || posts.facebook.imageSource === 'upload')
    );
    if (wired || uploads.length) {
      setConfirmRemoveImage(true);
      return;
    }
    clearUploads();
  }

  function clearUploads() {
    for (const url of localPreviews) URL.revokeObjectURL(url);
    setLocalPreviews([]);
    setUploads([]);
    setConfirmRemoveImage(false);
  }

  function clearOneUpload(uploadId) {
    setUploads((prev) => prev.filter((u) => u.uploadId !== uploadId));
  }

  /** Feature 127: prefill alt text from the Facebook caption / topic. */
  async function suggestAlt() {
    const source = posts?.facebook?.text || topic;
    const suggestion = suggestAltText(source);
    if (!suggestion) {
      pushToast('Nothing to suggest from yet — write a topic or polish first', 'info');
      return;
    }
    setAltText(suggestion);
    if (uploads[0]) {
      try {
        await api(`/api/uploads/${encodeURIComponent(uploads[0].uploadId)}/meta`, {
          method: 'PUT',
          body: JSON.stringify({ altText: suggestion }),
        });
      } catch {
        /* metadata sync is best-effort */
      }
    }
  }

  function focusFirstReviewField(nextPosts) {
    requestAnimationFrame(() => {
      reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const firstPlatform = PLATFORM_KEYS.find((p) => nextPosts?.[p]);
      if (!firstPlatform) return;
      const el = reviewRef.current?.querySelector(`[data-first-field="${firstPlatform}"]`);
      el?.focus?.();
    });
  }

  async function onPolish({ skipDuplicateCheck = false } = {}) {
    if (!topic.trim()) {
      setShowTopicHint(true);
      topicRef.current?.focus();
      pushToast('Topic is required', 'fail');
      return;
    }
    setShowTopicHint(false);

    // Feature 115: warn when the topic fuzzy-matches something published recently.
    if (!skipDuplicateCheck) {
      try {
        const dup = await api('/api/compose/duplicate-check', {
          method: 'POST',
          body: JSON.stringify({ topic }),
        });
        if (dup.duplicate) {
          setDuplicateWarn(dup.duplicate);
          return;
        }
      } catch {
        /* duplicate check is advisory only */
      }
    }
    setDuplicateWarn(null);

    setError(null);
    setPublishResults(null);
    setBusy('polish');
    setPolishStage('generate');
    polishAbortRef.current?.abort();
    const controller = new AbortController();
    polishAbortRef.current = controller;
    const stageTimers = [
      setTimeout(() => setPolishStage('parse'), 400),
      setTimeout(() => setPolishStage('creative'), 900),
    ];
    try {
      const data = await api('/api/polish', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          topic,
          notes,
          platforms: selectedList,
          uploadId: uploads[0]?.uploadId || undefined,
          tone: tone === 'neutral' ? undefined : tone,
          language,
          length: lengthPreset,
          creativeTemplate,
          creativeTheme,
        }),
      });
      setPolishStage('done');
      const nextPosts = data.posts || {};
      setPosts(nextPosts);
      setOriginalPosts(JSON.parse(JSON.stringify(nextPosts)));
      setEditedPlatforms(new Set());
      pushToast('Copy polished — review before publish', 'ok');
      focusFirstReviewField(nextPosts);
    } catch (e) {
      if (e.name === 'AbortError') {
        pushToast('Polish cancelled', 'info');
      } else {
        setError(e.message || String(e));
        pushToast(e.message || String(e), 'fail');
      }
    } finally {
      stageTimers.forEach(clearTimeout);
      if (polishAbortRef.current === controller) polishAbortRef.current = null;
      setBusy(null);
      setPolishStage(null);
    }
  }

  function onCancelPolish() {
    polishAbortRef.current?.abort();
  }

  /** Feature 108/109: regenerate a single platform card, leaving other edits intact. */
  async function regenerateCard(platform) {
    setRegenBusy(platform);
    try {
      const data = await api('/api/polish', {
        method: 'POST',
        body: JSON.stringify({
          topic,
          notes,
          only: platform,
          uploadId: platform === 'facebook' ? uploads[0]?.uploadId || undefined : undefined,
          tone: tone === 'neutral' ? undefined : tone,
          creativeTemplate,
          creativeTheme,
        }),
      });
      const fresh = data.posts?.[platform];
      if (!fresh) throw new Error('Regenerate returned no content');
      setPosts((prev) => ({ ...(prev || {}), [platform]: fresh }));
      setEditedPlatforms((prev) => {
        const next = new Set(prev);
        next.delete(platform);
        return next;
      });
      pushToast(`${platform} regenerated`, 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setRegenBusy(null);
    }
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
    setEditedPlatforms((prev) => new Set(prev).add(platform));
  }

  /** Feature 125: point the Facebook publish at the chosen creative variant. */
  function pickVariant(variant) {
    setPosts((prev) => {
      const cur = { ...(prev || {}) };
      const fb = { ...(cur.facebook || {}) };
      fb.creativePath = variant.path;
      fb.imagePath = variant.path;
      fb.creativeUrl = variant.url;
      fb.imageUrl = variant.url;
      fb.imageSource = 'creative';
      cur.facebook = fb;
      return cur;
    });
  }

  /** Build the posts payload with alt text, ordered uploads, and template flags. */
  function enrichedPosts() {
    const out = { ...(posts || {}) };
    if (out.facebook) {
      out.facebook = {
        ...out.facebook,
        altText: altText || undefined,
        uploadIds: uploads.length ? uploads.map((u) => u.uploadId) : undefined,
      };
    }
    return out;
  }

  async function doPublish(platformsOverride = null) {
    setConfirmLive(false);
    setError(null);
    setBusy('publish');
    try {
      const data = await api('/api/publish', {
        method: 'POST',
        body: JSON.stringify({
          dryRun,
          topic,
          platforms: platformsOverride || selectedList,
          uploadId: uploads[0]?.uploadId || posts?.facebook?.uploadId || undefined,
          dryRunByPlatform: !dryRun && showAdvancedDry ? dryRunByPlatform : undefined,
          posts: enrichedPosts(),
        }),
      });
      setPublishResults(data);
      setEditedPlatforms(new Set());
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

  /** Feature 104/106: queue instead of publishing when a future time is set. */
  async function queueSchedule() {
    const iso = new Date(scheduleAt).toISOString();
    const check = validateScheduleTime(iso);
    if (!check.ok) {
      pushToast(check.error || 'Pick a future date/time', 'fail');
      return;
    }
    setBusy('publish');
    try {
      const data = await api('/api/schedule', {
        method: 'POST',
        body: JSON.stringify({
          topic,
          platforms: selectedList,
          posts: enrichedPosts(),
          fireAt: iso,
          dryRun,
        }),
      });
      pushToast(
        `Queued for ${new Date(data.schedule.fireAt).toLocaleString()} (${data.schedule.dryRun ? 'dry-run' : 'LIVE when armed'})`,
        'ok'
      );
      setScheduleAt('');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    } finally {
      setBusy(null);
    }
  }

  function onPublish() {
    if (twitterOverLimit) {
      pushToast('Fix Twitter character limit before publish', 'fail');
      return;
    }
    if (bannedBlocked && !ackBanned) {
      pushToast('Flagged words found — acknowledge the lint warnings first', 'fail');
      return;
    }
    if (scheduleAt) {
      queueSchedule();
      return;
    }
    if (!dryRun) {
      setConfirmLive(true);
      return;
    }
    doPublish();
  }

  /** Feature 147: re-invoke publish for just the failed platforms. */
  function retryFailed() {
    const failed = failedPlatforms(publishResults?.results || []);
    if (!failed.length) return;
    doPublish(failed);
  }

  /** Feature 149: copy the whole polished pack as a labeled markdown block. */
  async function copyAllPack() {
    const md = packToMarkdown({ topic, posts, platforms: selectedList });
    try {
      await navigator.clipboard.writeText(md);
      pushToast('Pack copied as markdown', 'ok');
    } catch {
      pushToast('Clipboard unavailable', 'fail');
    }
  }

  /** Feature 150: download the pack as topic-slug + date .md. */
  function exportPack() {
    const md = packToMarkdown({ topic, posts, platforms: selectedList });
    downloadFile(safePackFilename(topic), md);
    pushToast('Pack exported', 'ok');
  }

  /** Feature 113: persist UTM settings. */
  async function saveUtm(patch) {
    const next = { ...utm, ...patch };
    setUtm(next);
    try {
      const data = await api('/api/compose/utm', { method: 'PUT', body: JSON.stringify(next) });
      setUtm(data.settings);
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    }
  }

  /** Features 130/131: disk drafts with named save/load. */
  async function saveDiskDraft(overwrite = false) {
    const name = draftName.trim();
    if (!name) {
      pushToast('Give the draft a name first', 'fail');
      return;
    }
    try {
      await api('/api/drafts', {
        method: 'POST',
        body: JSON.stringify({
          name,
          overwrite,
          draft: { topic, notes, selected, tone, creativeTemplate, creativeTheme, posts },
        }),
      });
      const list = await api('/api/drafts');
      setDiskDrafts(list.drafts || []);
      pushToast(`Draft “${name}” saved to disk`, 'ok');
    } catch (e) {
      if (/already exists/i.test(e.message || '')) {
        if (window.confirm(`Draft “${name}” exists — overwrite it?`)) {
          saveDiskDraft(true);
          return;
        }
      }
      pushToast(e.message || String(e), 'fail');
    }
  }

  async function loadDiskDraft(name) {
    if (!name) return;
    try {
      const data = await api(`/api/drafts/${encodeURIComponent(name)}`);
      const d = data.entry?.draft || {};
      setTopic(d.topic || '');
      setNotes(d.notes || '');
      if (d.selected) setSelected(d.selected);
      if (d.tone) setTone(d.tone);
      if (d.creativeTemplate) setCreativeTemplate(d.creativeTemplate);
      if (d.creativeTheme) setCreativeTheme(d.creativeTheme);
      if (d.posts) setPosts(d.posts);
      setDraftName(name);
      pushToast(`Draft “${name}” loaded`, 'ok');
    } catch (e) {
      pushToast(e.message || String(e), 'fail');
    }
  }

  const forceDryRun = Boolean(health?.forceDryRun);
  const canPolish = selectedList.length > 0 && !busy;
  const canPublish =
    posts && selectedList.length > 0 && !busy && !twitterOverLimit && (!bannedBlocked || ackBanned);
  const checkedLabel = useMemo(
    () => formatCheckedAgo(healthCheckedAt),
    [healthCheckedAt, healthTick]
  );

  const scheduleValid = useMemo(() => {
    if (!scheduleAt) return null;
    const d = new Date(scheduleAt);
    if (Number.isNaN(d.getTime())) return { ok: false, error: 'Invalid date' };
    return validateScheduleTime(d.toISOString());
  }, [scheduleAt]);

  const onPolishRef = useRef(onPolish);
  const onPublishRef = useRef(onPublish);
  onPolishRef.current = onPolish;
  onPublishRef.current = onPublish;

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing =
        tag === 'textarea' || tag === 'input' || tag === 'select' || e.target?.isContentEditable;

      if (e.key === 'Escape') {
        if (lightboxSrc) {
          e.preventDefault();
          setLightboxSrc(null);
          return;
        }
        if (toasts.length) {
          e.preventDefault();
          dismissNewestToast();
          return;
        }
        if (busy === 'polish') {
          e.preventDefault();
          polishAbortRef.current?.abort();
          return;
        }
      }

      if (!typing && e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowKeys(true);
        return;
      }
      if (e.key === 'Escape' && showKeys) {
        setShowKeys(false);
        return;
      }

      if (!typing && /^[1-5]$/.test(e.key) && mainTab === 'compose') {
        const idx = Number(e.key) - 1;
        const key = PLATFORM_KEYS[idx];
        if (key) {
          e.preventDefault();
          togglePlatform(key);
        }
        return;
      }

      const mod = e.metaKey || e.ctrlKey;
      if (!(mod && e.key === 'Enter')) return;

      if (e.shiftKey) {
        if (canPublish && mainTab === 'compose') {
          e.preventDefault();
          onPublishRef.current();
        }
        return;
      }

      if ((!typing || tag === 'textarea') && canPolish && topic.trim() && mainTab === 'compose') {
        e.preventDefault();
        onPolishRef.current();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    busy,
    canPublish,
    canPolish,
    topic,
    lightboxSrc,
    toasts.length,
    dismissNewestToast,
    mainTab,
    health,
    selected,
    showKeys,
  ]);

  const facebookVisual = health?.facebookPostMode === 'visual';

  return (
    <div className="app">
      <a className="skip-link" href="#compose-main">
        Skip to compose
      </a>

      {!dryRun && !forceDryRun && (
        <div className="danger-banner" role="alert">
          Live mode — platform APIs will be called on Publish. Prefer Dry-run until copy is final.
        </div>
      )}

      <header className="brand">
        <p className="stage-label">Local operator</p>
        <h1 className="brand-mark">Airepro</h1>
        <p className="brand-tagline">
          Draft an angle, polish with Ollama, edit per platform, then dry-run or publish — localhost
          only.
        </p>

        <div className="main-tabs" role="tablist" aria-label="Operator sections">
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'compose'}
            className={`tab ${mainTab === 'compose' ? 'active' : ''}`}
            onClick={() => setMainTab('compose')}
          >
            Compose
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'history'}
            className={`tab ${mainTab === 'history' ? 'active' : ''}`}
            onClick={() => setMainTab('history')}
          >
            History
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'stats'}
            className={`tab ${mainTab === 'stats' ? 'active' : ''}`}
            onClick={() => setMainTab('stats')}
          >
            Stats
            {health?.featureFlags?.statsApi === false ? null : (
              <span className="pill experimental" title="Wave-3">
                {' '}
                ·
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainTab === 'auto-reply'}
            className={`tab ${mainTab === 'auto-reply' ? 'active' : ''}`}
            onClick={() => setMainTab('auto-reply')}
          >
            Auto-reply
          </button>
        </div>

        {mainTab === 'compose' && <WorkflowStepper stage={stage} />}
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
              {forceDryRun && (
                <span className="pill ok" title="UI_FORCE_DRY_RUN=true — live publishing disabled">
                  Dry-run pinned
                </span>
              )}
              {health.autoReply && (
                <span className={`pill ${health.autoReply.enabled ? 'warn' : ''}`}>
                  Auto-reply · {health.autoReply.enabled ? 'live armed' : 'safe'}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            className="pill btn-pill"
            onClick={() => loadHealth({ preserveSelection: true })}
            aria-label="Refresh health status"
          >
            Refresh{checkedLabel ? ` · ${checkedLabel}` : ''}
          </button>
        </div>
        <p className="shortcut-hint">
          Shortcuts: Ctrl/Cmd+Enter polish · Esc cancel/dismiss · Ctrl/Cmd+Shift+Enter publish · 1–5
          toggle platforms
        </p>
      </header>

      <div className="sr-live" aria-live="polite" aria-atomic="true">
        {busyLiveMessage}
      </div>

      <main id="compose-main">
        {mainTab === 'auto-reply' && (
          <Suspense
            fallback={
              <section className="panel">
                <p className="empty-hint">Loading auto-reply…</p>
              </section>
            }
          >
            <AutoReplyPanel pushToast={pushToast} />
          </Suspense>
        )}
        {mainTab === 'history' && (
          <Suspense
            fallback={
              <section className="panel">
                <p className="empty-hint">Loading history…</p>
              </section>
            }
          >
            <HistoryTab
              pushToast={pushToast}
              onRecycle={(t) => {
                setTopic(t);
                setNotes((n) => (n ? n : 'Fresh angle: regenerate with a new hook'));
                setMainTab('compose');
                pushToast('Topic loaded from history — add a fresh angle in Notes', 'info');
                requestAnimationFrame(() => topicRef.current?.focus());
              }}
            />
          </Suspense>
        )}
        {mainTab === 'stats' && (
          <Suspense
            fallback={
              <section className="panel">
                <p className="empty-hint">Loading stats…</p>
              </section>
            }
          >
            <StatsTab />
          </Suspense>
        )}
        {mainTab === 'compose' && (
          <>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <p className="stage-label">Compose</p>
                  <h2>Draft &amp; polish</h2>
                </div>
                <button type="button" className="btn btn-ghost" onClick={resetDraft}>
                  Reset draft
                </button>
              </div>

              {!posts && (
                <p className="empty-hint">
                  Start with a concrete internship angle. Optional image applies to Facebook only;
                  leave empty to auto-generate an Airepro creative. Dry-run stays on until you turn
                  it off.
                </p>
              )}

              <label className="field">
                <span>Topic / angle</span>
                <textarea
                  ref={topicRef}
                  rows={3}
                  placeholder="e.g. Dream internship for students this summer"
                  value={topic}
                  list="topic-history"
                  onChange={(e) => {
                    setTopic(e.target.value);
                    if (e.target.value.trim()) setShowTopicHint(false);
                  }}
                  aria-invalid={showTopicHint}
                />
                {showTopicHint && (
                  <span className="field-error" role="alert">
                    Topic is required to polish.
                  </span>
                )}
              </label>

              {/* Feature 133: recent topics from publish history. */}
              {topicHistory.length > 0 && (
                <label className="field">
                  <span>Recent topics</span>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) setTopic(e.target.value);
                    }}
                  >
                    <option value="">pick a past topic…</option>
                    {topicHistory.map((t) => (
                      <option key={t} value={t}>
                        {t.length > 80 ? `${t.slice(0, 80)}…` : t}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {/* Feature 132: rotating topic-angle chips from the brand brief. */}
              {topicChips.length > 0 && (
                <div
                  className="chip-row"
                  role="group"
                  aria-label="Topic suggestions from brand brief"
                >
                  {topicChips.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="pill btn-pill"
                      onClick={() => {
                        setTopic(chip);
                        setShowTopicHint(false);
                      }}
                    >
                      {chip.length > 48 ? `${chip.slice(0, 48)}…` : chip}
                    </button>
                  ))}
                </div>
              )}

              <label className="field">
                <span>Notes (optional)</span>
                <textarea
                  rows={2}
                  placeholder="Tone, must-include phrases, audience…"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>

              {/* Feature 114: brand voice control. */}
              <fieldset className="tone-control">
                <legend>Brand voice</legend>
                <div className="tone-row" role="radiogroup" aria-label="Brand voice tone">
                  {TONES.map((t) => (
                    <label key={t} className={`tone-option ${tone === t ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="tone"
                        value={t}
                        checked={tone === t}
                        onChange={() => setTone(t)}
                      />
                      {t}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="ar-row">
                <label className="field inline">
                  <span>Language</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    <option value="en">English</option>
                    <option value="hi">Hindi</option>
                    <option value="hinglish">Hinglish</option>
                  </select>
                </label>
                <label className="field inline">
                  <span>Length</span>
                  <select value={lengthPreset} onChange={(e) => setLengthPreset(e.target.value)}>
                    <option value="short">Short</option>
                    <option value="medium">Medium</option>
                    <option value="long">Long</option>
                  </select>
                </label>
              </div>

              <details className="pack-import">
                <summary>Import pack markdown (no Ollama)</summary>
                <textarea
                  rows={5}
                  value={packImportText}
                  onChange={(e) => setPackImportText(e.target.value)}
                  placeholder="# topic&#10;## twitter&#10;…"
                />
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    const pack = markdownToPack(packImportText);
                    if (!pack.platforms.length) {
                      pushToast('No platform sections found', 'fail');
                      return;
                    }
                    setTopic(pack.topic);
                    setPosts(pack.posts);
                    setOriginalPosts(JSON.parse(JSON.stringify(pack.posts)));
                    pushToast('Pack imported', 'ok');
                  }}
                >
                  Import into review
                </button>
              </details>

              {/* Features 117/118: creative template + theme pickers (visual FB only). */}
              {facebookVisual && selected.facebook && (
                <div className="ar-row">
                  <label className="field inline">
                    <span>Creative layout</span>
                    <select
                      value={creativeTemplate}
                      onChange={(e) => setCreativeTemplate(e.target.value)}
                    >
                      {(health?.creative?.templates || ['classic']).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field inline">
                    <span>Creative theme</span>
                    <select
                      value={creativeTheme}
                      onChange={(e) => setCreativeTheme(e.target.value)}
                    >
                      {(health?.creative?.themes || ['magenta']).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              {/* Feature 113: UTM settings, editable inline. */}
              <div className="ar-row utm-row">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(utm.enabled)}
                    onChange={(e) => saveUtm({ enabled: e.target.checked })}
                  />
                  Tag airepro.in links with UTM
                </label>
                <label className="field inline">
                  <span>Campaign slug</span>
                  <input
                    type="text"
                    value={utm.campaign || ''}
                    disabled={!utm.enabled}
                    onChange={(e) => setUtm((u) => ({ ...u, campaign: e.target.value }))}
                    onBlur={(e) => saveUtm({ campaign: e.target.value })}
                  />
                </label>
              </div>

              {/* Features 130/131: named disk drafts. */}
              <div className="ar-row drafts-row">
                <label className="field inline">
                  <span>Draft name</span>
                  <input
                    type="text"
                    value={draftName}
                    maxLength={60}
                    placeholder="diwali-campaign"
                    onChange={(e) => setDraftName(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => saveDiskDraft(false)}
                >
                  Save draft to disk
                </button>
                {diskDrafts.length > 0 && (
                  <label className="field inline">
                    <span>Load saved draft</span>
                    <select value="" onChange={(e) => loadDiskDraft(e.target.value)}>
                      <option value="">choose…</option>
                      {diskDrafts.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <span className="field-label" style={{ display: 'block', marginBottom: '0.4rem' }}>
                Images (Facebook only, up to {MAX_UPLOAD_FILES})
              </span>
              <ImageDropzone
                uploads={uploads}
                localPreviews={localPreviews}
                busy={busy}
                cropPreset={cropPreset}
                onCropPreset={setCropPreset}
                altText={altText}
                onAltText={setAltText}
                onSuggestAlt={suggestAlt}
                onFiles={handleFiles}
                onClearOne={clearOneUpload}
                onClearAll={requestClearUpload}
                onPreview={setLightboxSrc}
              />

              <div className="panel-head" style={{ marginTop: '0.35rem' }}>
                <h2 style={{ margin: 0 }}>Platforms</h2>
                <div className="platform-bulk">
                  <button type="button" className="btn btn-ghost" onClick={selectAllPlatforms}>
                    Select all
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={clearPlatforms}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="platforms">
                {PLATFORM_KEYS.map((key, i) => {
                  const meta = health?.platforms?.[key];
                  const disabled = meta?.enabled === false;
                  const configured = meta?.configured;
                  // Feature 167 groundwork / tooltip clarity for disabled pills.
                  const why = disabled
                    ? `${key} is disabled via ${key.toUpperCase()}_ENABLED=false`
                    : configured
                      ? `Shortcut ${i + 1}`
                      : `${key} enabled but credentials missing — see .env.example`;
                  return (
                    <label
                      key={key}
                      className={`platform ${selected[key] ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                      title={why}
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(selected[key])}
                        disabled={disabled}
                        onChange={() => togglePlatform(key)}
                      />
                      <span className="name">
                        <kbd className="digit">{i + 1}</kbd> {key}
                      </span>
                      <span className="hint">
                        {disabled ? 'off' : configured ? 'ready' : 'creds?'}
                      </span>
                    </label>
                  );
                })}
              </div>
              {selectedList.length === 0 && (
                <p className="field-error" role="alert">
                  Select at least one platform to polish.
                </p>
              )}

              {error && <div className="error-banner">{error}</div>}
            </section>

            {busy === 'polish' && (
              <section className="panel" aria-busy="true">
                <div className="polish-status">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    {polishStage === 'generate' && 'Stage: generate — drafting with Ollama…'}
                    {polishStage === 'parse' && 'Stage: parse — extracting platform sections…'}
                    {polishStage === 'creative' && 'Stage: creative — rendering assets…'}
                    {polishStage === 'done' && 'Stage: done'}
                    {!polishStage && 'Polishing with Ollama…'}
                  </span>
                </div>
                <ol className="polish-stages" aria-label="Polish progress">
                  {['generate', 'parse', 'creative'].map((s) => (
                    <li
                      key={s}
                      className={
                        polishStage === s
                          ? 'active'
                          : ['generate', 'parse', 'creative', 'done'].indexOf(polishStage) >
                              ['generate', 'parse', 'creative'].indexOf(s)
                            ? 'done'
                            : ''
                      }
                    >
                      {s}
                    </li>
                  ))}
                </ol>
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
              <section className="panel" ref={reviewRef} tabIndex={-1}>
                <div className="panel-head">
                  <div>
                    <p className="stage-label">Review</p>
                    <h2>Editable platform cards</h2>
                  </div>
                  <div className="platform-bulk">
                    <button type="button" className="btn btn-ghost" onClick={copyAllPack}>
                      Copy pack (md)
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={exportPack}>
                      Export .md
                    </button>
                    {originalPosts && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setPosts(JSON.parse(JSON.stringify(originalPosts)));
                          setEditedPlatforms(new Set());
                          pushToast('Reverted cards to model output', 'ok');
                        }}
                      >
                        Undo edits
                      </button>
                    )}
                  </div>
                </div>
                {twitterOverLimit && (
                  <div className="error-banner" role="alert">
                    Twitter is over {TWITTER_MAX} characters. Shorten it before publish (thread
                    preview below the card).
                  </div>
                )}
                {bannedBlocked && (
                  <div className="error-banner" role="alert">
                    Flagged claim words found — review the lint notes on each card.{' '}
                    <label className="toggle" style={{ display: 'inline-flex' }}>
                      <input
                        type="checkbox"
                        checked={ackBanned}
                        onChange={(e) => setAckBanned(e.target.checked)}
                      />
                      I reviewed the flagged words — allow publish
                    </label>
                  </div>
                )}
                <div className="cards-grid">
                  {PLATFORM_KEYS.filter((p) => posts[p]).map((platform) => (
                    <PlatformCard
                      key={platform}
                      platform={platform}
                      entry={posts[platform]}
                      originalEntry={originalPosts?.[platform] || null}
                      edited={editedPlatforms.has(platform)}
                      regenBusy={regenBusy}
                      hashtagPacks={hashtagPacks}
                      lint={cardLints[platform]}
                      onChange={(field, value) => updatePostField(platform, field, value)}
                      onPreview={setLightboxSrc}
                      onRegenerate={regenerateCard}
                      onPickVariant={pickVariant}
                      pushToast={pushToast}
                    />
                  ))}
                </div>
              </section>
            )}

            {!posts && busy !== 'polish' && selectedList.length > 0 && (
              <section className="panel empty-panel" aria-label="Review placeholder">
                <p className="stage-label">Review</p>
                <h2>Waiting for polish</h2>
                <p className="empty-hint">
                  Platform cards appear here after Polish. You can edit copy, then dry-run publish
                  without hitting live APIs.
                </p>
              </section>
            )}

            {publishResults && (
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <p className="stage-label">Results</p>
                    <h2>
                      {publishResults.dryRun
                        ? 'Dry-run results'
                        : publishResults.mixed
                          ? 'Mixed dry/live results'
                          : 'Publish results'}
                    </h2>
                  </div>
                  {failedPlatforms(publishResults.results || []).length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={Boolean(busy)}
                      onClick={retryFailed}
                    >
                      Retry failed only ({failedPlatforms(publishResults.results || []).join(', ')})
                    </button>
                  )}
                </div>
                <div className="result-list">
                  {(publishResults.results || []).map((r) => (
                    <ResultRow key={r.platform} r={r} />
                  ))}
                </div>
              </section>
            )}

            <section className="panel help-panel">
              <button
                type="button"
                className="help-toggle"
                onClick={() => setShowHelp((v) => !v)}
                aria-expanded={showHelp}
              >
                {showHelp ? 'Hide' : 'How to use'} this console
              </button>
              {showHelp && (
                <div className="help-body">
                  <ul>
                    <li>
                      Dry-run stays on by default — no live APIs until you uncheck it and confirm.
                    </li>
                    <li>Images apply to Facebook only (upload or auto Airepro creative).</li>
                    <li>Cancel polish with Esc while Ollama is running.</li>
                    <li>Set a future date/time to queue instead of publishing immediately.</li>
                    <li>
                      Platform notes:{' '}
                      <a href="/docs/facebook.md" onClick={(e) => e.preventDefault()}>
                        docs/facebook.md
                      </a>{' '}
                      (see repo README → Local operator UI).
                    </li>
                  </ul>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {mainTab === 'compose' && (
        <div className="sticky-actions" role="region" aria-label="Primary actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canPolish}
            onClick={() => onPolish()}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
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
            aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
          >
            {busy === 'publish'
              ? 'Working…'
              : scheduleAt
                ? 'Queue for later'
                : dryRun
                  ? 'Dry-run publish'
                  : 'Publish live'}
          </button>

          {/* Feature 106: schedule picker — queues instead of publishing. */}
          <label className="field inline schedule-field">
            <span>Schedule (optional)</span>
            <input
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              aria-describedby="best-time-hint"
              aria-invalid={scheduleValid ? !scheduleValid.ok : undefined}
            />
          </label>
          {scheduleValid && !scheduleValid.ok && (
            <span className="field-error" role="alert">
              {scheduleValid.error}
            </span>
          )}
          {/* Feature 135: static best-time hints per selected platform. */}
          <span id="best-time-hint" className="best-time-hint">
            {selectedList
              .filter((p) => bestTimes[p])
              .slice(0, 2)
              .map((p) => `${p}: ${bestTimes[p]}`)
              .join(' · ')}
          </span>

          {forceDryRun ? (
            <span className="pill ok" title="UI_FORCE_DRY_RUN=true">
              Dry-run pinned
            </span>
          ) : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              Dry-run (skip live APIs)
            </label>
          )}

          {/* Feature 148: per-platform dry-run for live requests. */}
          {!dryRun && !forceDryRun && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={showAdvancedDry}
              onClick={() => setShowAdvancedDry((v) => !v)}
            >
              Advanced
            </button>
          )}
          {!dryRun && !forceDryRun && showAdvancedDry && (
            <div className="advanced-dry" role="group" aria-label="Per-platform dry-run">
              {selectedList.map((p) => (
                <label key={p} className="toggle">
                  <input
                    type="checkbox"
                    checked={Boolean(dryRunByPlatform[p])}
                    onChange={(e) =>
                      setDryRunByPlatform((prev) => ({ ...prev, [p]: e.target.checked }))
                    }
                  />
                  dry {p}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <datalist id="topic-history">
        {topicHistory.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <footer className="app-footer">
        <span>
          Airepro operator · localhost · v{health?.version || '…'}
          {health?.armed?.paused ? ' · PAUSED' : ''}
        </span>
        <span className="footer-links">
          <button type="button" className="btn btn-ghost" onClick={() => setShowKeys(true)}>
            Shortcuts (?)
          </button>
          <span aria-hidden="true">·</span>
          <a href="/api/docs" target="_blank" rel="noreferrer">
            API docs
          </a>
        </span>
      </footer>

      {showKeys && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowKeys(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Keyboard shortcuts</h2>
            <ul>
              <li>
                <kbd>1</kbd>–<kbd>5</kbd> toggle platforms
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>Enter</kbd> polish
              </li>
              <li>
                <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> publish
              </li>
              <li>
                <kbd>?</kbd> this help · <kbd>Esc</kbd> close
              </li>
            </ul>
            <button type="button" className="btn" onClick={() => setShowKeys(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />

      <ConfirmModal
        open={confirmLive}
        title="Publish live?"
        body="Dry-run is off. This will call live platform APIs for the selected channels. Continue only if credentials and copy are intentional."
        confirmLabel="Publish live"
        onCancel={() => setConfirmLive(false)}
        onConfirm={() => doPublish()}
      />
      <ConfirmModal
        open={confirmRemoveImage}
        title="Remove images?"
        body="This clears the uploaded images from the draft. If Facebook already used an upload, polish again after removing."
        confirmLabel="Remove images"
        onCancel={() => setConfirmRemoveImage(false)}
        onConfirm={clearUploads}
      />
      <ConfirmModal
        open={Boolean(duplicateWarn)}
        title="Similar topic already published"
        body={
          duplicateWarn
            ? `“${duplicateWarn.topic}” was published ${new Date(duplicateWarn.ts).toLocaleDateString()} (${duplicateWarn.dryRun ? 'dry-run' : 'live'}). Polish this topic anyway?`
            : ''
        }
        confirmLabel="Polish anyway"
        onCancel={() => setDuplicateWarn(null)}
        onConfirm={() => {
          setDuplicateWarn(null);
          onPolish({ skipDuplicateCheck: true });
        }}
      />
    </div>
  );
}
