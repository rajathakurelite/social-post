// @ts-nocheck
/**
 * Pure content-lint helpers for Wave-3 features 128 and 139–146.
 *
 * BROWSER-SAFE: imported by both the Express server and the Vite React app —
 * no Node imports (no fs, no path, no process) allowed here. The banned-words
 * and handle-allowlist configs are loaded Node-side in skills/compose_config.js
 * and passed in as plain arrays.
 */

/** One emoji = one pictograph plus any variation selectors / ZWJ continuations. */
const EMOJI_RE = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

/**
 * Count emojis in text (ZWJ sequences like 👩‍💻 count once).
 * @param {string} text
 * @returns {number}
 */
export function countEmojis(text) {
  const matches = String(text ?? '').match(EMOJI_RE);
  return matches ? matches.length : 0;
}

/** Brand names / short acronyms that never count as shouting. */
const ALL_CAPS_IGNORE = new Set(['AIREPRO', 'CTA', 'AI', 'HR', 'FAQ', 'ASAP', 'DM']);

/**
 * True when a sentence reads as all-caps shouting: either 3+ consecutive
 * all-caps words, or every letter-word uppercase with enough letters that it
 * is not just a short acronym (so "GREAT" flags, "CTA" alone does not).
 * @param {string} sentence
 * @returns {boolean}
 */
function sentenceIsAllCaps(sentence) {
  const words = (sentence.match(/[\p{L}][\p{L}\p{N}'’-]*/gu) || []).filter(
    (w) => w.replace(/[^\p{L}]/gu, '').length >= 2
  );
  if (!words.length) return false;
  const caps = words.map(
    (w) => !ALL_CAPS_IGNORE.has(w) && w === w.toUpperCase() && w !== w.toLowerCase()
  );
  let run = 0;
  for (const isCaps of caps) {
    run = isCaps ? run + 1 : 0;
    if (run >= 3) return true;
  }
  if (!caps.every(Boolean)) return false;
  const totalLetters = words.join('').replace(/[^\p{L}]/gu, '').length;
  return words.length >= 3 || totalLetters >= 4;
}

/**
 * Emoji/tone lint for a platform caption (feature 128).
 * @param {string} text
 * @returns {{ warnings: Array<{ code: 'EMOJI_OVERLOAD' | 'ALL_CAPS' | 'TRIPLE_EXCLAIM', message: string }> }}
 */
export function lintCaption(text) {
  const t = String(text ?? '');
  const warnings = [];
  const emojiCount = countEmojis(t);
  if (emojiCount > 4) {
    warnings.push({
      code: 'EMOJI_OVERLOAD',
      message: `Caption uses ${emojiCount} emojis — keep it to 4 or fewer.`,
    });
  }
  if (t.split(/[.!?\n]+/).some((s) => sentenceIsAllCaps(s))) {
    warnings.push({
      code: 'ALL_CAPS',
      message: 'Caption contains an all-caps sentence — reads like shouting.',
    });
  }
  if (/!{3,}/.test(t)) {
    warnings.push({
      code: 'TRIPLE_EXCLAIM',
      message: "Caption contains '!!!' — one exclamation mark is plenty.",
    });
  }
  return { warnings };
}

/**
 * Flag lines longer than max chars (feature 139, creative caption scannability).
 * @param {string} text
 * @param {number} [max]
 * @returns {{ longLines: Array<{ index: number, length: number }> }}
 */
export function lintLineLength(text, max = 90) {
  const longLines = [];
  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.length > max) longLines.push({ index, length: line.length });
    });
  return { longLines };
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive banned-words check (feature 141): single words match on
 * word boundaries, multi-word phrases as substrings. Hits echo the banned
 * entries that matched.
 * @param {string} text
 * @param {string[]} banned
 * @returns {{ hits: string[] }}
 */
export function lintBannedWords(text, banned) {
  const lower = String(text ?? '').toLowerCase();
  const hits = [];
  for (const entry of Array.isArray(banned) ? banned : []) {
    const needle = String(entry ?? '')
      .toLowerCase()
      .trim();
    if (!needle) continue;
    if (/\s/.test(needle)) {
      if (lower.includes(needle)) hits.push(entry);
    } else if (new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(lower)) {
      hits.push(entry);
    }
  }
  return { hits };
}

/**
 * Flag @handles not in the allowlist (feature 142, typo protection).
 * Allowlist entries may carry a leading '@'; matching is case-insensitive.
 * @param {string} text
 * @param {string[]} allowlist
 * @returns {{ unknown: string[] }}
 */
export function lintHandles(text, allowlist) {
  const allow = new Set(
    (Array.isArray(allowlist) ? allowlist : []).map((h) =>
      String(h ?? '')
        .replace(/^@/, '')
        .toLowerCase()
    )
  );
  const unknown = [];
  const seen = new Set();
  for (const handle of String(text ?? '').match(/@[a-z0-9_]{2,}/gi) || []) {
    const key = handle.slice(1).toLowerCase();
    if (allow.has(key) || seen.has(key)) continue;
    seen.add(key);
    unknown.push(handle);
  }
  return { unknown };
}

/**
 * Offline URL syntax lint (feature 143): every scheme-ish token must be https
 * with a parseable, sane hostname. No network calls.
 * @param {string} text
 * @returns {{ invalid: Array<{ url: string, reason: string }> }}
 */
export function lintUrls(text) {
  const invalid = [];
  for (const raw of String(text ?? '').match(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi) || []) {
    const url = raw.replace(/[)\]}>.,!?;:'"]+$/, '');
    const scheme = url.slice(0, url.indexOf('://')).toLowerCase();
    if (scheme === 'mailto') continue;
    if (scheme !== 'https') {
      invalid.push({ url, reason: `non-https scheme "${scheme}"` });
      continue;
    }
    const hostname = url.slice(url.indexOf('://') + 3).split(/[/?#]/)[0];
    if (!hostname || hostname.includes(',') || !hostname.includes('.')) {
      invalid.push({ url, reason: `invalid hostname "${hostname}"` });
      continue;
    }
    try {
      new URL(url);
    } catch {
      invalid.push({ url, reason: 'URL does not parse' });
    }
  }
  return { invalid };
}

/** Interjections/imperatives that make a strong first-line opener. */
const HOOK_OPENERS = new Set(['imagine', 'stop', 'ready', 'want', 'new', 'meet', 'discover']);

/**
 * Deterministic 0–100 hook heuristic on the first line (feature 144):
 * +25 length 20–80, +25 question mark, +25 digit, +15 emoji, +10 strong opener.
 * @param {string} text
 * @returns {{ score: number, factors: string[] }}
 */
export function hookScore(text) {
  const firstLine = (
    String(text ?? '')
      .split(/\r?\n/)
      .find((l) => l.trim()) || ''
  ).trim();
  let score = 0;
  const factors = [];
  if (firstLine.length >= 20 && firstLine.length <= 80) {
    score += 25;
    factors.push('length');
  }
  if (firstLine.includes('?')) {
    score += 25;
    factors.push('question');
  }
  if (/\d/.test(firstLine)) {
    score += 25;
    factors.push('number');
  }
  if (countEmojis(firstLine) > 0) {
    score += 15;
    factors.push('emoji');
  }
  const firstWord = (firstLine.toLowerCase().match(/[a-z]+/) || [''])[0];
  if (HOOK_OPENERS.has(firstWord)) {
    score += 10;
    factors.push('opener');
  }
  return { score: Math.max(0, Math.min(100, score)), factors };
}

/**
 * Vowel-group syllable estimate for one word (silent trailing 'e' dropped).
 * @param {string} word
 * @returns {number}
 */
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  let n = (w.match(/[aeiouy]+/g) || []).length;
  if (n > 1 && w.endsWith('e') && !w.endsWith('le')) n -= 1;
  return Math.max(1, n);
}

/**
 * Flesch reading-ease estimate with a simple syllable counter (feature 145).
 * Band: >=60 easy, 30–59 medium, <30 hard.
 * @param {string} text
 * @returns {{ score: number, band: 'easy' | 'medium' | 'hard' }}
 */
export function readingLevel(text) {
  const t = String(text ?? '');
  const sentences = Math.max(1, t.split(/[.!?]+|\n+/).filter((s) => /[a-z0-9]/i.test(s)).length);
  const words = t.match(/[a-zA-Z'’]+/g) || [];
  const wordCount = Math.max(1, words.length);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0) || 1;
  const raw = 206.835 - 1.015 * (wordCount / sentences) - 84.6 * (syllables / wordCount);
  const score = Math.round(raw * 10) / 10;
  const band = score >= 60 ? 'easy' : score >= 30 ? 'medium' : 'hard';
  return { score, band };
}

/**
 * Brand presence check (feature 146): does the card name the brand or link
 * the site? Case-insensitive.
 * @param {string} text
 * @param {{ name?: string, domain?: string }} [brand]
 * @returns {{ present: boolean, hasName: boolean, hasLink: boolean }}
 */
export function brandPresence(text, { name = 'Airepro', domain = 'airepro.in' } = {}) {
  const lower = String(text ?? '').toLowerCase();
  const hasName = lower.includes(String(name).toLowerCase());
  const hasLink = lower.includes(String(domain).toLowerCase());
  return { present: hasName || hasLink, hasName, hasLink };
}

/**
 * Run every lint over one card's text; banned-word hits block publish
 * (feature 141).
 * @param {string} text
 * @param {{ banned?: string[], handleAllowlist?: string[] }} [opts]
 * @returns {{ warnings: object[], bannedHits: string[], unknownHandles: string[], invalidUrls: object[], blocked: boolean }}
 */
export function lintAll(text, { banned = [], handleAllowlist = [] } = {}) {
  const { warnings } = lintCaption(text);
  const { hits } = lintBannedWords(text, banned);
  const { unknown } = lintHandles(text, handleAllowlist);
  const { invalid } = lintUrls(text);
  return {
    warnings,
    bannedHits: hits,
    unknownHandles: unknown,
    invalidUrls: invalid,
    blocked: hits.length > 0,
  };
}
