// @ts-nocheck
/**
 * Pure compose/publish helpers for Wave-3 features 101–150.
 *
 * BROWSER-SAFE: this module is imported by both the Express server and the
 * Vite React app — no Node imports (no fs, no path, no process) allowed here.
 * Node-only config loading lives in skills/compose_config.js.
 */

/** Hard character limits per platform (feature 129). */
export const PLATFORM_LIMITS = {
  facebook: 63206,
  twitter: 280,
  linkedin: 3000,
  whatsapp: 900,
  youtubeTitle: 100,
  youtubeDescription: 5000,
};

/**
 * Live character-counter status for a platform (feature 129).
 * @param {string} platform PLATFORM_LIMITS key.
 * @param {string} text
 * @returns {{ count: number, limit: number | null, over: boolean }}
 */
export function charStatus(platform, text) {
  const count = String(text ?? '').length;
  const limit = Object.prototype.hasOwnProperty.call(PLATFORM_LIMITS, platform)
    ? PLATFORM_LIMITS[platform]
    : null;
  return { count, limit, over: limit != null && count > limit };
}

/**
 * Lowercase slug: alphanumerics + hyphens, repeats collapsed, edges trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Matches airepro.in URLs; trailing punctuation is trimmed after matching. */
const AIREPRO_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*airepro\.in(?:[/?#][^\s]*)?/gi;
const TRAILING_PUNCT_RE = /[.,!?;:'")\]}]+$/;

/**
 * Rewrite every airepro.in URL with utm_source/utm_campaign params (features 112/113).
 * URLs whose query already contains "utm_" are left alone (no double-tagging).
 * @param {string} text
 * @param {{ platform: string, campaign: string, enabled?: boolean }} opts
 * @returns {string}
 */
export function applyUtm(text, { platform, campaign, enabled = true } = {}) {
  const t = String(text ?? '');
  const campaignSlug = slugify(campaign);
  if (!enabled || !campaignSlug) return t;
  const source = encodeURIComponent(String(platform ?? '').trim());
  return t.replace(AIREPRO_URL_RE, (match) => {
    const trail = (match.match(TRAILING_PUNCT_RE) || [''])[0];
    let url = trail ? match.slice(0, match.length - trail.length) : match;
    const hashIdx = url.indexOf('#');
    const fragment = hashIdx >= 0 ? url.slice(hashIdx) : '';
    if (hashIdx >= 0) url = url.slice(0, hashIdx);
    const queryIdx = url.indexOf('?');
    if (queryIdx >= 0 && url.slice(queryIdx).includes('utm_')) return match;
    const sep = queryIdx >= 0 ? '&' : '?';
    return `${url}${sep}utm_source=${source}&utm_campaign=${campaignSlug}${fragment}${trail}`;
  });
}

/**
 * Append hashtags on a new line without ever exceeding the platform limit
 * (feature 111): tags are added one at a time and dropped, never truncated.
 * Tags already present in the text (case-insensitive) are skipped.
 * @param {string} text
 * @param {string[]} tags With or without leading '#'.
 * @param {string} platform PLATFORM_LIMITS key.
 * @returns {string}
 */
export function appendHashtags(text, tags, platform) {
  const base = String(text ?? '');
  const limit = Object.prototype.hasOwnProperty.call(PLATFORM_LIMITS, platform)
    ? PLATFORM_LIMITS[platform]
    : Infinity;
  const lower = base.toLowerCase();
  let out = base;
  let added = 0;
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw ?? '')
      .trim()
      .replace(/^#+/, '');
    if (!tag) continue;
    if (lower.includes(`#${tag.toLowerCase()}`)) continue;
    if (out.toLowerCase().includes(`#${tag.toLowerCase()}`)) continue;
    const candidate = out + (added === 0 ? '\n' : ' ') + `#${tag}`;
    if (candidate.length > limit) break;
    out = candidate;
    added += 1;
  }
  return added > 0 ? out : base;
}

/**
 * Split an oversized sentence at word boundaries into pieces <= limit,
 * hard-slicing pathological single words longer than the limit.
 * @param {string} sentence
 * @param {number} limit
 * @returns {string[]}
 */
function splitSentenceIntoUnits(sentence, limit) {
  const units = [];
  let current = '';
  for (const word of sentence.split(/\s+/).filter(Boolean)) {
    if (word.length > limit) {
      if (current) {
        units.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += limit) {
        units.push(word.slice(i, i + limit));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= limit) {
      current = next;
    } else {
      units.push(current);
      current = word;
    }
  }
  if (current) units.push(current);
  return units;
}

/**
 * Greedily pack sentence units into parts no longer than limit.
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
function chunkAtSentences(text, limit) {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const units = [];
  for (const sentence of sentences) {
    if (sentence.length <= limit) units.push(sentence);
    else units.push(...splitSentenceIntoUnits(sentence, limit));
  }
  const parts = [];
  let current = '';
  for (const unit of units) {
    const next = current ? `${current} ${unit}` : unit;
    if (next.length <= limit) {
      current = next;
    } else {
      if (current) parts.push(current);
      current = unit;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Split a long draft into numbered thread parts at sentence boundaries
 * (feature 121). Text within max returns [text] with NO suffix; otherwise
 * every part carries a " n/m" suffix and stays <= max including it.
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitThread(text, max = 280) {
  const t = String(text ?? '');
  if (t.length <= max) return [t];
  for (let suffixLen = 4; ; suffixLen += 1) {
    const parts = chunkAtSentences(t, max - suffixLen);
    const total = parts.length;
    const withSuffix = parts.map((p, i) => `${p} ${i + 1}/${total}`);
    if (withSuffix.every((p) => p.length <= max)) return withSuffix;
  }
}

/**
 * Short (<= 40 char) chapter label from a sentence: URLs removed,
 * whitespace collapsed.
 * @param {string} sentence
 * @returns {string}
 */
function chapterLabel(sentence) {
  return sentence
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
}

/**
 * Derive up to 5 YouTube chapter lines from a description (feature 123):
 * "00:00 Intro" first, then evenly spaced strictly-increasing MM:SS stamps.
 * Deterministic for a fixed input; [] for an empty description.
 * @param {string} description
 * @param {number} [videoMinutes]
 * @returns {string[]}
 */
export function generateChapterHints(description, videoMinutes = 6) {
  const text = String(description ?? '').trim();
  if (!text) return [];
  const labels = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => chapterLabel(s))
    .filter(Boolean);
  const lines = ['00:00 Intro'];
  const extra = Math.min(4, labels.length);
  const totalSec = Math.max(60, Math.floor(videoMinutes * 60));
  let prevSec = 0;
  for (let i = 1; i <= extra; i += 1) {
    const sec = Math.max(prevSec + 1, Math.round((totalSec * i) / (extra + 1)));
    prevSec = sec;
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    lines.push(`${mm}:${ss} ${labels[i - 1]}`);
  }
  return lines;
}

/**
 * True only when every line matches "MM:SS label" and timestamps strictly increase.
 * @param {string[]} lines
 * @returns {boolean}
 */
export function validateChapterLines(lines) {
  if (!Array.isArray(lines)) return false;
  let prev = -1;
  for (const line of lines) {
    const m = /^(\d{2}):(\d{2})\s+\S/.exec(String(line ?? ''));
    if (!m) return false;
    const sec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    if (sec <= prev) return false;
    prev = sec;
  }
  return true;
}

/**
 * Normalize YouTube tags into a comma-separated string capped at 500 chars
 * total (feature 124): trimmed, deduped case-insensitively, entries dropped
 * from the end rather than truncated.
 * @param {string[] | string} tags
 * @returns {string}
 */
export function capYoutubeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  while (out.length && out.join(', ').length > 500) out.pop();
  return out.join(', ');
}

/**
 * Suggest YouTube tags from a description (+ optional topic) (feature 124):
 * hashtags in the description, significant topic words, then brand defaults.
 * Output is always capped via capYoutubeTags (≤ 500 chars).
 * @param {string} description
 * @param {string} [topic]
 * @returns {string}
 */
export function suggestYoutubeTags(description, topic = '') {
  const tags = [];
  const seen = new Set();
  const add = (raw) => {
    const tag = String(raw ?? '')
      .replace(/^#+/, '')
      .trim();
    if (!tag || tag.length < 2) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };
  for (const m of String(description ?? '').matchAll(/#([a-zA-Z0-9_]{2,})/g)) {
    add(m[1]);
  }
  for (const word of String(topic ?? '')
    .split(/[^a-zA-Z0-9]+/)
    .filter((w) => w.length >= 4)) {
    add(word);
  }
  add('Airepro');
  add('internships');
  return capYoutubeTags(tags);
}

/** Emoji modifiers that survive Extended_Pictographic stripping. */
const EMOJI_JOINERS_RE = /[\u{FE0E}\u{FE0F}\u{200D}]/gu;

/**
 * Alt-text prefill from a caption's first non-empty line (feature 127):
 * emojis and URLs stripped, whitespace collapsed, capped at 125 chars.
 * @param {string} caption
 * @returns {string}
 */
export function suggestAltText(caption) {
  const line =
    String(caption ?? '')
      .split(/\r?\n/)
      .find((l) => l.trim()) || '';
  return line
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(EMOJI_JOINERS_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 125)
    .trim();
}

/**
 * Expand airepro.in/go/<slug> shortlinks using a local slug map (feature 134).
 * Unknown slugs leave the text untouched.
 * @param {string} text
 * @param {Record<string, string>} slugMap
 * @returns {string}
 */
export function expandLinkSlugs(text, slugMap) {
  const map = slugMap && typeof slugMap === 'object' ? slugMap : {};
  return String(text ?? '').replace(
    /(?:https?:\/\/)?(?:www\.)?airepro\.in\/go\/([a-z0-9_-]+)/gi,
    (match, slug) => {
      if (Object.prototype.hasOwnProperty.call(map, slug)) return map[slug];
      const lower = slug.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower];
      return match;
    }
  );
}

/**
 * Render a polished pack as one labeled markdown block (feature 149):
 * "# topic" then one "## platform" section per selected platform.
 * @param {{ topic: string, posts: Record<string, { text?: string, title?: string, description?: string }>, platforms: string[] }} pack
 * @returns {string}
 */
export function packToMarkdown({ topic, posts, platforms } = {}) {
  const out = [`# ${String(topic ?? '').trim() || 'Untitled'}`];
  for (const platform of Array.isArray(platforms) ? platforms : []) {
    const post = posts && posts[platform];
    if (!post) continue;
    out.push('', `## ${platform}`, '');
    if (platform === 'youtube') {
      out.push(post.title || '');
      if (post.description) out.push('', post.description);
    } else {
      out.push(post.text || '');
    }
  }
  return out.join('\n');
}

/**
 * Windows-safe pack filename "<slug>-<YYYY-MM-DD>.md" (feature 150):
 * slug capped at 60 chars, no reserved characters, "pack" fallback.
 * @param {string} topic
 * @param {Date} [date]
 * @returns {string}
 */
export function safePackFilename(topic, date = new Date()) {
  let slug = slugify(topic).slice(0, 60).replace(/-+$/g, '');
  if (!slug) slug = 'pack';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${slug}-${yyyy}-${mm}-${dd}.md`;
}

/**
 * Topic normalization for duplicate detection: lowercase, punctuation
 * stripped, whitespace collapsed.
 * @param {string} s
 * @returns {string}
 */
export function normalizeTopic(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fuzzy topic match (feature 115): normalized equality OR word-set Jaccard
 * similarity >= 0.8.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function topicsSimilar(a, b) {
  const na = normalizeTopic(a);
  const nb = normalizeTopic(b);
  if (na === nb) return true;
  const setA = new Set(na.split(' ').filter(Boolean));
  const setB = new Set(nb.split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return false;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= 0.8;
}

/**
 * Stepwise headline shrink for the creative canvas (feature 138): base size
 * up to maxCharsAtBase chars, then -4px per additional 6 chars, floored at min.
 * @param {string} text
 * @param {{ base?: number, min?: number, maxCharsAtBase?: number }} [opts]
 * @returns {number}
 */
export function headlineFontSize(text, { base = 54, min = 30, maxCharsAtBase = 24 } = {}) {
  const length = String(text ?? '').length;
  if (length <= maxCharsAtBase) return base;
  const steps = Math.ceil((length - maxCharsAtBase) / 6);
  return Math.max(min, base - steps * 4);
}

/**
 * Parse a crop ratio: number, or "w:h" string like "1.91:1".
 * @param {string | number} ratio
 * @returns {number | null}
 */
function parseRatio(ratio) {
  if (typeof ratio === 'number') {
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  if (typeof ratio === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(ratio.trim());
    if (!m) return null;
    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);
    return w > 0 && h > 0 ? w / h : null;
  }
  return null;
}

/**
 * Largest centered crop rect of the given aspect ratio inside width x height
 * (feature 137). Integer values; null for invalid input.
 * @param {number} width
 * @param {number} height
 * @param {string | number} ratio '1:1' | '4:5' | '1.91:1' | number (w/h)
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function cropRect(width, height, ratio) {
  const r = parseRatio(ratio);
  if (
    r == null ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  let cropWidth = width;
  let cropHeight = width / r;
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = height * r;
  }
  const w = Math.round(cropWidth);
  const h = Math.round(cropHeight);
  return {
    x: Math.round((width - w) / 2),
    y: Math.round((height - h) / 2),
    width: w,
    height: h,
  };
}

/**
 * Platforms that failed in a publish results array (feature 147, partial retry).
 * @param {Array<{ platform: string, ok: boolean }>} results
 * @returns {string[]}
 */
export function failedPlatforms(results) {
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.ok === false)
    .map((r) => r.platform);
}

/**
 * Client-side schedule validation (feature 106): the ISO datetime must parse
 * and sit at least 60 seconds in the future.
 * @param {string} iso
 * @param {Date} [now]
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateScheduleTime(iso, now = new Date()) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) {
    return { ok: false, error: 'Invalid date/time — pick a valid schedule time.' };
  }
  if (t - now.getTime() < 60_000) {
    return { ok: false, error: 'Schedule time must be at least 1 minute in the future.' };
  }
  return { ok: true };
}

/**
 * Feature 151: parse a pack markdown (from packToMarkdown) back into posts.
 * @param {string} markdown
 * @returns {{ topic: string, posts: Record<string, { text?: string, title?: string, description?: string }>, platforms: string[] }}
 */
export function markdownToPack(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  let topic = 'Untitled';
  /** @type {Record<string, { text?: string, title?: string, description?: string }>} */
  const posts = {};
  /** @type {string[]} */
  const platforms = [];
  let current = null;
  /** @type {string[]} */
  let buf = [];

  const flush = () => {
    if (!current) return;
    const body = buf.join('\n').replace(/^\n+|\n+$/g, '');
    if (current === 'youtube') {
      const parts = body.split(/\n\n+/);
      posts.youtube = {
        title: (parts[0] || '').trim(),
        description: parts.slice(1).join('\n\n').trim(),
      };
    } else {
      posts[current] = { text: body };
    }
    buf = [];
  };

  for (const line of lines) {
    if (/^#\s+/.test(line) && current == null && topic === 'Untitled') {
      topic = line.replace(/^#\s+/, '').trim() || 'Untitled';
      continue;
    }
    const m = line.match(/^##\s+(\w+)\s*$/);
    if (m) {
      flush();
      current = m[1].toLowerCase();
      if (!platforms.includes(current)) platforms.push(current);
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return { topic, posts, platforms };
}

/**
 * Feature 156: word-level diff between model output and edited text.
 * @param {string} original
 * @param {string} edited
 * @returns {Array<{ type: 'equal' | 'insert' | 'delete', value: string }>}
 */
export function wordDiff(original, edited) {
  const a = String(original ?? '')
    .split(/(\s+)/)
    .filter((t) => t.length);
  const b = String(edited ?? '')
    .split(/(\s+)/)
    .filter((t) => t.length);
  const n = a.length;
  const m = b.length;
  /** @type {number[][]} */
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  /** @type {Array<{ type: 'equal' | 'insert' | 'delete', value: string }>} */
  const parts = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      parts.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: 'delete', value: a[i] });
      i++;
    } else {
      parts.push({ type: 'insert', value: b[j] });
      j++;
    }
  }
  while (i < n) parts.push({ type: 'delete', value: a[i++] });
  while (j < m) parts.push({ type: 'insert', value: b[j++] });
  return parts;
}

/**
 * Feature 152: insert a snippet at cursor, respecting platform character cap.
 * @param {string} text
 * @param {string} snippet
 * @param {number} cursor
 * @param {string} platform
 * @returns {{ text: string, cursor: number, truncated: boolean }}
 */
export function insertSnippet(text, snippet, cursor, platform) {
  const base = String(text ?? '');
  const snip = String(snippet ?? '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, base.length));
  const limit = PLATFORM_LIMITS[platform];
  let insert = snip;
  let truncated = false;
  if (Number.isFinite(limit)) {
    const room = Math.max(0, limit - base.length);
    if (insert.length > room) {
      insert = insert.slice(0, room);
      truncated = true;
    }
  }
  const next = base.slice(0, pos) + insert + base.slice(pos);
  return { text: next, cursor: pos + insert.length, truncated };
}

/**
 * Feature 163: language directive for prompts.
 * @param {string} [lang] 'en' | 'hi' | 'hinglish'
 * @returns {string}
 */
export function languageDirective(lang) {
  const l = String(lang || 'en').toLowerCase();
  if (l === 'hi' || l === 'hindi') {
    return 'Language directive: write primarily in Hindi (Devanagari), keep brand names and URLs in Latin script.';
  }
  if (l === 'hinglish') {
    return 'Language directive: write in Hinglish (Hindi+English mix), natural and conversational.';
  }
  return 'Language directive: write in clear professional English.';
}

/**
 * Feature 164: length preset → LinkedIn word-range text (and siblings).
 * @param {string} [preset] 'short' | 'medium' | 'long'
 * @returns {{ linkedin: string, facebook: string, twitter: string }}
 */
export function lengthPresetTargets(preset) {
  const p = String(preset || 'medium').toLowerCase();
  if (p === 'short') {
    return {
      linkedin: '80-120 words',
      facebook: '2-3 short lines',
      twitter: 'under 200 characters',
    };
  }
  if (p === 'long') {
    return {
      linkedin: '220-320 words',
      facebook: '5-7 lines with a clear CTA',
      twitter: 'use the full 280 when valuable',
    };
  }
  return {
    linkedin: '140-200 words',
    facebook: '3-5 lines',
    twitter: 'under 260 characters',
  };
}

/**
 * Feature 159: expand a WhatsApp broadcast list for dry-run reporting.
 * Never calls fetch — pure expansion.
 * @param {{ recipients?: string[], armed?: boolean }} list
 * @param {{ dryRun?: boolean, liveArmed?: boolean }} [opts]
 * @returns {{ wouldSendCount: number, recipients: string[], blocked: boolean, reason?: string }}
 */
export function expandBroadcastList(list, opts = {}) {
  const recipients = Array.isArray(list?.recipients)
    ? list.recipients.map(String).filter(Boolean)
    : [];
  const dryRun = opts.dryRun !== false;
  if (dryRun) {
    return { wouldSendCount: recipients.length, recipients, blocked: false };
  }
  if (!list?.armed && !opts.liveArmed) {
    return {
      wouldSendCount: 0,
      recipients: recipients.slice(0, 1),
      blocked: true,
      reason: 'Broadcast list is not armed — live multi-send blocked',
    };
  }
  return { wouldSendCount: recipients.length, recipients, blocked: false };
}

/**
 * Feature 162: LinkedIn document/carousel dry-run payload shape.
 * @param {{ text: string, pdfName: string, authorUrn?: string }} args
 */
export function buildLinkedInDocumentPayload({ text, pdfName, authorUrn }) {
  const name = pathBasename(pdfName);
  return {
    author: authorUrn || 'urn:li:person:EXAMPLE',
    commentary: String(text || ''),
    visibility: 'PUBLIC',
    content: {
      media: {
        title: name,
        id: `urn:li:digitalmediaAsset:DRYRUN_${name.replace(/\W+/g, '_')}`,
      },
    },
    dryRun: true,
  };
}

/**
 * Feature 161: Twitter media alt-text payload stub.
 * @param {{ text: string, altText?: string, mediaId?: string }} args
 */
export function buildTwitterMediaPayload({ text, altText, mediaId }) {
  /** @type {Record<string, unknown>} */
  const payload = { text: String(text || '') };
  if (mediaId) payload.media = { media_ids: [String(mediaId)] };
  if (altText && String(altText).trim()) {
    payload.media_alt_text = String(altText).trim().slice(0, 1000);
  }
  return payload;
}

/**
 * Feature 167: human-readable reason a platform pill is unavailable.
 * @param {{ enabled: boolean, configured: boolean }} status
 * @returns {string | null} null when usable
 */
export function platformDisabledReason(status) {
  if (!status) return 'Unknown platform status';
  if (status.enabled === false) return 'Disabled in PLATFORMS / *_ENABLED';
  if (!status.configured) return 'Enabled but credentials missing — check .env';
  return null;
}

/**
 * Feature 170: apply a compose preset onto a state object (only bundled fields).
 * @param {object} state
 * @param {{ platforms?: string[], tone?: string, length?: string, hashtagPackId?: string }} preset
 */
export function applyComposePreset(state, preset) {
  const next = { ...state };
  if (Array.isArray(preset?.platforms)) next.platforms = [...preset.platforms];
  if (preset?.tone != null) next.tone = preset.tone;
  if (preset?.length != null) next.length = preset.length;
  if (preset?.hashtagPackId != null) next.hashtagPackId = preset.hashtagPackId;
  return next;
}

/** @param {string} p */
function pathBasename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
