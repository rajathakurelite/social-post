// @ts-nocheck
/**
 * Regex auto-reply engine for WhatsApp / Facebook inbound messages.
 * Safe-by-default: no outbound send unless AUTO_REPLY_ENABLED=true and rule.enabled.
 *
 * Wave-2 features (71-100): quiet hours, business hours, templates, A/B variants,
 * follow-ups, human takeover, escalation skip, language gate, media stub,
 * interactive payloads, idempotency, DLQ, stats, tags, canary rollout,
 * per-platform env flags, mention guard, link guard, approvals, versioning.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { backupFile, loadJsonWithBackup } from '../utils/config_backup.js';
import { fetchWithTimeout } from '../utils/http_fetch.js';
import { validateRulesSchema, validateSettingsSchema } from '../utils/config_schema.js';

/**
 * @typedef {Object} AutoReplyRule
 * @property {string} id Unique rule id.
 * @property {string} name Human label (max 120 chars).
 * @property {boolean} enabled Disabled rules never match.
 * @property {'whatsapp' | 'facebook'} platform Platform this rule applies to.
 * @property {string} pattern Regex source (safety-validated).
 * @property {string} flags Regex flags (subset of gimsuy).
 * @property {string} reply Reply template ($1..$n, $&, {{tpl:id}} supported).
 * @property {Array<{ text: string, weight: number }>} [replyVariants] A/B variants (weighted random).
 * @property {number} cooldownSec Per chat+rule cooldown.
 * @property {'any' | 'dm' | 'group'} scope Chat scope filter.
 * @property {number} priority Higher wins.
 * @property {string[]} [tags] Free-form tags for filtering/bulk ops.
 * @property {{ start: string, end: string, tzOffsetMinutes?: number | null } | null} [quietHours]
 *   Suppression window (HH:MM-HH:MM, may wrap midnight): no sends inside it.
 * @property {string | null} [lang] Only reply when detected inbound language matches (e.g. 'en', 'hi').
 * @property {number | null} [canaryPercent] 0-100; only auto-send for this % of chats (hash bucket).
 * @property {boolean} [requireMention] In groups, only reply when a mention token is present.
 * @property {'text' | 'buttons' | 'list'} [replyType] Outbound payload shape (interactive is opt-in).
 * @property {string[]} [buttons] Button titles for replyType=buttons/list (max 3).
 * @property {{ afterMinutes: number, text: string } | null} [followUp] Follow-up message if no takeover.
 * @property {boolean} [useContext] Match against the recent conversation window, not just this message.
 */

/**
 * @typedef {Object} AutoReplySettings
 * @property {'first' | 'all'} matchMode Stop at first hit, or collect all.
 * @property {number} maxRepliesPerHour Global hourly send cap.
 * @property {string[]} stopWords Inbound text containing any of these never matches.
 * @property {string[]} ignoreList Senders to ignore entirely.
 * @property {{ enabled: boolean, start: string, end: string, days: number[], tzOffsetMinutes?: number | null }} businessHours
 *   Shared profile: when enabled, sends allowed only inside this window on listed days (0=Sun).
 * @property {string[]} escalationWords Angry/escalation keywords: skip sending, log 'escalation'.
 * @property {string[]} mentionTokens Tokens satisfying the group mention guard (e.g. '@airepro').
 * @property {string[]} allowedLinkDomains Non-empty = replies with URLs outside this list are blocked.
 * @property {boolean} approvalRequired Matched replies wait in the approval queue instead of sending.
 * @property {string} notifyWebhookUrl Localhost ops webhook pinged after each live send.
 * @property {number} memoryWindow How many recent inbound lines to keep per chat.
 * @property {{ enabled: boolean }} llmFallback Optional LLM draft when no rule matches (draft only).
 * @property {Array<{ id: string, text: string }>} templates Reusable snippets referenced by {{tpl:id}}.
 */

const MAX_PATTERN_LEN = 400;
const MAX_REPLY_LEN = 2000;
const MAX_RULES = 100;
const MAX_TEST_TEXT_LEN = 4000;
const MAX_FLAGS_LEN = 8;
const MAX_TAGS = 10;
const MAX_VARIANTS = 5;
const MAX_BUTTONS = 3;
const MAX_TEMPLATES = 50;
const REGEX_TIMEOUT_MS = 80;
const HISTORY_KEEP = 10;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_MAX = 5000;

/* —— data file paths (env-overridable so tests never touch operator data) —— */

function envPath(name, ...fallback) {
  const v = String(process.env[name] || '').trim();
  return v || path.join(config.rootDir, ...fallback);
}

const rulesPath = () => envPath('AUTO_REPLY_RULES_PATH', 'config', 'auto_reply_rules.json');
const settingsPath = () =>
  envPath('AUTO_REPLY_SETTINGS_PATH', 'config', 'auto_reply_settings.json');
const logPath = () => envPath('AUTO_REPLY_LOG_PATH', 'output', 'auto-reply-log.jsonl');
const dlqPath = () => envPath('AUTO_REPLY_DLQ_PATH', 'output', 'auto-reply-dlq.jsonl');
const historyDir = () => envPath('AUTO_REPLY_HISTORY_DIR', 'config', 'auto_reply_history');
const takeoverPath = () =>
  envPath('AUTO_REPLY_TAKEOVER_PATH', 'config', 'auto_reply_takeover.json');
const approvalsPath = () =>
  envPath('AUTO_REPLY_APPROVALS_PATH', 'output', 'auto-reply-approvals.json');

export const paths = {
  get RULES_PATH() {
    return rulesPath();
  },
  get SETTINGS_PATH() {
    return settingsPath();
  },
  get LOG_PATH() {
    return logPath();
  },
  get DLQ_PATH() {
    return dlqPath();
  },
  get HISTORY_DIR() {
    return historyDir();
  },
  get APPROVALS_PATH() {
    return approvalsPath();
  },
};

/* —— in-memory state —— */

/** @type {Map<string, number>} chatKey:ruleId → cooldown-until epoch ms */
const cooldownUntil = new Map();
/** @type {number[]} recent send timestamps (hour window) */
const recentSends = [];
/** @type {Map<string, number>} inbound message id → first-seen epoch ms (24h idempotency) */
const seenMessageIds = new Map();
/** @type {Map<string, string[]>} chatKey → recent inbound lines (conversation memory) */
const memoryByChat = new Map();
/** @type {Array<{ id: string, dueAt: number, chatKey: string, platform: string, to: string, ruleId: string, text: string }>} */
const pendingFollowUps = [];

/** Feature 85: counters exposed via /api/auto-reply/stats. */
const stats = {
  inbound: 0,
  matches: 0,
  sent: 0,
  dlq: 0,
  /** @type {Record<string, number>} */
  skipped: {},
};

function countSkip(reason) {
  if (!reason) return;
  stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
}

/** @returns {{ inbound: number, matches: number, sent: number, dlq: number, skipped: Record<string, number> }} */
export function getStats() {
  return { ...stats, skipped: { ...stats.skipped } };
}

/** Test helper: reset all in-memory engine state. */
export function resetEngineState() {
  cooldownUntil.clear();
  recentSends.length = 0;
  seenMessageIds.clear();
  memoryByChat.clear();
  pendingFollowUps.length = 0;
  stats.inbound = 0;
  stats.matches = 0;
  stats.sent = 0;
  stats.dlq = 0;
  stats.skipped = {};
}

/** @type {AutoReplySettings} */
const DEFAULT_SETTINGS = {
  matchMode: 'first', // first | all
  maxRepliesPerHour: 60,
  stopWords: [],
  ignoreList: [],
  businessHours: {
    enabled: false,
    start: '09:00',
    end: '18:00',
    days: [1, 2, 3, 4, 5],
    tzOffsetMinutes: null,
  },
  escalationWords: [],
  mentionTokens: [],
  allowedLinkDomains: [],
  approvalRequired: false,
  notifyWebhookUrl: '',
  memoryWindow: 5,
  llmFallback: { enabled: false },
  templates: [],
};

/**
 * @returns {boolean}
 */
export function isAutoReplyEnabled() {
  const v = String(process.env.AUTO_REPLY_ENABLED || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Feature 97: per-platform kill switches (unset = enabled).
 * AUTO_REPLY_WHATSAPP_ENABLED / AUTO_REPLY_FACEBOOK_ENABLED.
 * @param {string} platform
 * @returns {boolean}
 */
export function platformAutoReplyEnabled(platform) {
  const name = `AUTO_REPLY_${String(platform || '').toUpperCase()}_ENABLED`;
  const v = String(process.env[name] || '')
    .trim()
    .toLowerCase();
  if (!v) return true;
  return !['false', '0', 'no', 'off'].includes(v);
}

/**
 * Reject patterns that are likely catastrophic backtracking.
 * Practical heuristics — not a full regex analyzer.
 * @param {string} pattern
 * @returns {string | null} error message or null if ok
 */
export function validatePatternSafety(pattern) {
  const p = String(pattern || '');
  if (!p.trim()) return 'pattern is required';
  if (p.length > MAX_PATTERN_LEN) return `pattern max length is ${MAX_PATTERN_LEN}`;
  // Nested quantifiers on groups/classes: (a+)+ (a*)* [a-z]++ etc.
  if (/(\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*]/.test(p) && /[+*][+?]|[+*]\{/.test(p)) {
    return 'pattern looks catastrophic (nested quantifiers); simplify it';
  }
  if (/(\.\*){3,}|(\.\+){3,}/.test(p)) {
    return 'pattern has too many consecutive .* / .+ quantifiers';
  }
  if (/\([^)]*[+*][^)]*\)[+*]/.test(p)) {
    return 'pattern has nested quantified groups; rewrite without nesting';
  }
  try {
    new RegExp(p);
  } catch (e) {
    return `invalid regex: ${e.message || e}`;
  }
  return null;
}

/**
 * @param {string} flags
 * @returns {string | null}
 */
export function validateFlags(flags) {
  const f = String(flags || '');
  if (f.length > MAX_FLAGS_LEN) return `flags max length is ${MAX_FLAGS_LEN}`;
  if (f && !/^[gimsuy]*$/.test(f)) return 'flags may only include g i m s u y';
  const seen = new Set();
  for (const ch of f) {
    if (seen.has(ch)) return `duplicate flag: ${ch}`;
    seen.add(ch);
  }
  return null;
}

/**
 * Convert a plain keyword list into a simple word-boundary regex.
 * @param {string} keywords comma or newline separated
 * @param {{ caseInsensitive?: boolean }} [opts]
 * @returns {{ pattern: string, flags: string }}
 */
export function keywordToRegex(keywords, opts = {}) {
  const parts = String(keywords || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return { pattern: '', flags: opts.caseInsensitive === false ? '' : 'i' };
  const pattern = `\\b(?:${parts.join('|')})\\b`;
  return { pattern, flags: opts.caseInsensitive === false ? '' : 'i' };
}

/**
 * @param {string} template
 * @param {RegExpMatchArray | string[] | null} match
 * @returns {string}
 */
export function formatReply(template, match) {
  let out = String(template ?? '');
  if (!match) return out;
  out = out.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n);
    if (!Number.isFinite(idx) || idx < 0) return '';
    return match[idx] != null ? String(match[idx]) : '';
  });
  out = out.replace(/\$&/g, () => (match[0] != null ? String(match[0]) : ''));
  return out;
}

/**
 * Feature 73: expand {{tpl:id}} references from settings.templates.
 * Unknown ids are left as-is so the operator notices.
 * @param {string} text
 * @param {AutoReplySettings} settings
 * @returns {string}
 */
export function expandTemplates(text, settings) {
  const templates = Array.isArray(settings?.templates) ? settings.templates : [];
  return String(text ?? '').replace(/\{\{tpl:([a-zA-Z0-9_-]+)\}\}/g, (whole, id) => {
    const t = templates.find((x) => x && x.id === id);
    return t ? String(t.text ?? '') : whole;
  });
}

/**
 * Feature 74: pick a weighted reply variant (falls back to rule.reply).
 * @param {AutoReplyRule} rule
 * @param {() => number} [rng] injectable for deterministic tests
 * @returns {{ text: string, variantIndex: number | null }}
 */
export function pickReplyVariant(rule, rng = Math.random) {
  const variants = Array.isArray(rule.replyVariants)
    ? rule.replyVariants.filter((v) => v && v.text)
    : [];
  if (!variants.length) return { text: String(rule.reply || ''), variantIndex: null };
  const total = variants.reduce((sum, v) => sum + (Number(v.weight) > 0 ? Number(v.weight) : 1), 0);
  let roll = rng() * total;
  for (let i = 0; i < variants.length; i++) {
    roll -= Number(variants[i].weight) > 0 ? Number(variants[i].weight) : 1;
    if (roll < 0) return { text: String(variants[i].text), variantIndex: i };
  }
  return { text: String(variants[variants.length - 1].text), variantIndex: variants.length - 1 };
}

/**
 * Run regex with a cooperative timeout via worker-less length + early abort heuristics.
 * @param {RegExp} re
 * @param {string} text
 * @returns {RegExpMatchArray | null}
 */
function safeMatch(re, text) {
  const start = Date.now();
  const m = text.match(re);
  if (Date.now() - start > REGEX_TIMEOUT_MS) {
    throw new Error(`regex exceeded ${REGEX_TIMEOUT_MS}ms`);
  }
  return m;
}

/**
 * Feature 78: tiny language heuristic — enough for an en/hi gate without deps.
 * @param {string} text
 * @returns {'en' | 'hi' | 'other' | 'unknown'}
 */
export function detectLanguage(text) {
  const s = String(text || '');
  const letters = s.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (letters.length < 3) return 'unknown';
  let devanagari = 0;
  let ascii = 0;
  for (const ch of letters) {
    const code = ch.codePointAt(0);
    if (code >= 0x0900 && code <= 0x097f) devanagari++;
    else if (code < 128) ascii++;
  }
  if (devanagari / letters.length > 0.2) return 'hi';
  if (ascii / letters.length > 0.6) return 'en';
  return 'other';
}

/**
 * Parse "HH:MM" → minutes since midnight, or null.
 * @param {string} s
 * @returns {number | null}
 */
function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Minutes-since-midnight in the window's timezone (tzOffsetMinutes from UTC; null = server local).
 * @param {Date} now
 * @param {number | null | undefined} tzOffsetMinutes
 * @returns {{ minutes: number, day: number }}
 */
function localClock(now, tzOffsetMinutes) {
  if (tzOffsetMinutes == null || !Number.isFinite(Number(tzOffsetMinutes))) {
    return { minutes: now.getHours() * 60 + now.getMinutes(), day: now.getDay() };
  }
  const shifted = new Date(now.getTime() + Number(tzOffsetMinutes) * 60 * 1000);
  return {
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    day: shifted.getUTCDay(),
  };
}

/**
 * Feature 71: true when `now` falls inside the rule's quiet window (no sends).
 * Window may wrap midnight (e.g. 22:00 → 07:00).
 * @param {{ start: string, end: string, tzOffsetMinutes?: number | null } | null | undefined} quietHours
 * @param {Date} [now]
 * @returns {boolean}
 */
export function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours) return false;
  const start = parseHHMM(quietHours.start);
  const end = parseHHMM(quietHours.end);
  if (start == null || end == null || start === end) return false;
  const { minutes } = localClock(now, quietHours.tzOffsetMinutes);
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // wraps midnight
}

/**
 * Feature 72: when the shared business-hours profile is enabled, sends are only
 * allowed inside the window on listed days.
 * @param {AutoReplySettings['businessHours'] | null | undefined} bh
 * @param {Date} [now]
 * @returns {boolean} true if sending is allowed
 */
export function withinBusinessHours(bh, now = new Date()) {
  if (!bh || !bh.enabled) return true;
  const start = parseHHMM(bh.start);
  const end = parseHHMM(bh.end);
  if (start == null || end == null) return true;
  const { minutes, day } = localClock(now, bh.tzOffsetMinutes);
  const days = Array.isArray(bh.days) && bh.days.length ? bh.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(day)) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/**
 * Feature 96: deterministic canary bucket 0-99 for a chat key.
 * @param {string} chatKey
 * @returns {number}
 */
export function canaryBucket(chatKey) {
  let h = 5381;
  const s = String(chatKey || '');
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return Math.abs(h) % 100;
}

/**
 * @param {string} chatKey
 * @param {number | null | undefined} canaryPercent
 * @returns {boolean} true if this chat is inside the canary
 */
export function canaryAllows(chatKey, canaryPercent) {
  if (canaryPercent == null || !Number.isFinite(Number(canaryPercent))) return true;
  const pct = Math.max(0, Math.min(100, Number(canaryPercent)));
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return canaryBucket(chatKey) < pct;
}

/**
 * Feature 99: block replies containing URLs outside the allowlist.
 * Empty allowlist = guard disabled.
 * @param {string} replyText
 * @param {string[]} allowedDomains
 * @returns {{ ok: boolean, blockedUrl?: string }}
 */
export function linkGuard(replyText, allowedDomains) {
  const allow = (Array.isArray(allowedDomains) ? allowedDomains : [])
    .map((d) =>
      String(d || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  if (!allow.length) return { ok: true };
  const urls = String(replyText || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const u of urls) {
    let host;
    try {
      host = new URL(u).hostname.toLowerCase();
    } catch {
      return { ok: false, blockedUrl: u };
    }
    const allowed = allow.some((d) => host === d || host.endsWith(`.${d}`));
    if (!allowed) return { ok: false, blockedUrl: u };
  }
  return { ok: true };
}

/**
 * Feature 98: group mention guard.
 * @param {string} text
 * @param {string[]} mentionTokens
 * @returns {boolean} true when at least one token is present (or no tokens configured)
 */
export function hasMention(text, mentionTokens) {
  const tokens = (Array.isArray(mentionTokens) ? mentionTokens : [])
    .map((t) =>
      String(t || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  if (!tokens.length) return false;
  const lower = String(text || '').toLowerCase();
  return tokens.some((t) => lower.includes(t));
}

/**
 * Feature 89: explain a pattern — capture group count, named groups, optional sample match.
 * @param {string} pattern
 * @param {string} [flags]
 * @param {string} [sampleText]
 * @returns {{ ok: boolean, error?: string, groupCount?: number, namedGroups?: string[], sample?: { matched: boolean, captures: string[], groups: Record<string, string> } }}
 */
export function explainPattern(pattern, flags = '', sampleText = '') {
  const patErr = validatePatternSafety(pattern);
  if (patErr) return { ok: false, error: patErr };
  const flagErr = validateFlags(flags);
  if (flagErr) return { ok: false, error: flagErr };

  let groupCount = 0;
  try {
    // Alternation-with-empty trick: exec('') always matches and exposes every group slot.
    const probe = new RegExp(`${pattern}|`);
    const m = probe.exec('');
    groupCount = m ? m.length - 1 : 0;
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }

  const namedGroups = [];
  const nameRe = /\(\?<([a-zA-Z_$][a-zA-Z0-9_$]*)>/g;
  let nm;
  while ((nm = nameRe.exec(pattern)) !== null) namedGroups.push(nm[1]);

  const out = { ok: true, groupCount, namedGroups };
  if (sampleText) {
    const text = String(sampleText).slice(0, MAX_TEST_TEXT_LEN);
    try {
      const re = new RegExp(pattern, String(flags || '').replace('g', ''));
      const m = safeMatch(re, text);
      out.sample = {
        matched: Boolean(m),
        captures: m ? [...m].map((c) => (c == null ? '' : String(c))) : [],
        groups: m && m.groups ? { ...m.groups } : {},
      };
    } catch (e) {
      out.sample = { matched: false, captures: [], groups: {}, error: e.message || String(e) };
    }
  }
  return out;
}

/**
 * Feature 80: build the outbound WhatsApp payload for a rule (text or interactive).
 * Interactive payloads are opt-in; the live sender may still send plain text.
 * @param {AutoReplyRule} rule
 * @param {string} replyText
 * @returns {object}
 */
export function buildReplyPayload(rule, replyText) {
  const type = rule.replyType === 'buttons' || rule.replyType === 'list' ? rule.replyType : 'text';
  if (type === 'text') return { type: 'text', text: { body: replyText } };
  const buttons = (Array.isArray(rule.buttons) ? rule.buttons : [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, MAX_BUTTONS);
  if (!buttons.length) return { type: 'text', text: { body: replyText } };
  if (type === 'buttons') {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: replyText },
        action: {
          buttons: buttons.map((title, i) => ({
            type: 'reply',
            reply: { id: `${rule.id}-btn-${i}`, title: title.slice(0, 20) },
          })),
        },
      },
    };
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: replyText },
      action: {
        button: 'Options',
        sections: [
          {
            title: 'Options',
            rows: buttons.map((title, i) => ({
              id: `${rule.id}-row-${i}`,
              title: title.slice(0, 24),
            })),
          },
        ],
      },
    },
  };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, rule: AutoReplyRule } | { ok: false, error: string }}
 */
export function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'rule must be an object' };
  const id = String(raw.id || '').trim() || `rule-${Date.now()}`;
  const name = String(raw.name || id)
    .trim()
    .slice(0, 120);
  const enabled = raw.enabled !== false;
  const platform = String(raw.platform || 'whatsapp').toLowerCase();
  if (platform !== 'whatsapp' && platform !== 'facebook') {
    return { ok: false, error: `invalid platform: ${platform}` };
  }
  const pattern = String(raw.pattern || '');
  const flags = String(raw.flags || '');
  const reply = String(raw.reply || '');
  const patErr = validatePatternSafety(pattern);
  if (patErr) return { ok: false, error: `${id}: ${patErr}` };
  const flagErr = validateFlags(flags);
  if (flagErr) return { ok: false, error: `${id}: ${flagErr}` };

  /** @type {Array<{ text: string, weight: number }>} */
  let replyVariants = [];
  if (raw.replyVariants != null) {
    if (!Array.isArray(raw.replyVariants))
      return { ok: false, error: `${id}: replyVariants must be an array` };
    if (raw.replyVariants.length > MAX_VARIANTS) {
      return { ok: false, error: `${id}: max ${MAX_VARIANTS} reply variants` };
    }
    for (const v of raw.replyVariants) {
      const text = String(v?.text || '').trim();
      if (!text) return { ok: false, error: `${id}: variant text is required` };
      if (text.length > MAX_REPLY_LEN)
        return { ok: false, error: `${id}: variant max length is ${MAX_REPLY_LEN}` };
      const weight = Number(v?.weight);
      replyVariants.push({ text, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    }
  }

  if (!reply.trim() && !replyVariants.length) {
    return { ok: false, error: `${id}: reply is required` };
  }
  if (reply.length > MAX_REPLY_LEN) {
    return { ok: false, error: `${id}: reply max length is ${MAX_REPLY_LEN}` };
  }
  const cooldownSec = Math.max(0, Math.min(86400, Number(raw.cooldownSec) || 0));
  const scope = String(raw.scope || 'any').toLowerCase();
  if (!['any', 'dm', 'group'].includes(scope)) {
    return { ok: false, error: `${id}: scope must be any|dm|group` };
  }
  const priority = Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0;

  /** @type {string[]} */
  let tags = [];
  if (raw.tags != null) {
    if (!Array.isArray(raw.tags)) return { ok: false, error: `${id}: tags must be an array` };
    tags = raw.tags
      .map((t) =>
        String(t || '')
          .trim()
          .toLowerCase()
          .slice(0, 30)
      )
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  }

  /** @type {AutoReplyRule['quietHours']} */
  let quietHours = null;
  if (raw.quietHours && typeof raw.quietHours === 'object') {
    const start = String(raw.quietHours.start || '');
    const end = String(raw.quietHours.end || '');
    if (parseHHMM(start) == null || parseHHMM(end) == null) {
      return { ok: false, error: `${id}: quietHours start/end must be HH:MM` };
    }
    const tz = raw.quietHours.tzOffsetMinutes;
    quietHours = {
      start,
      end,
      tzOffsetMinutes: tz == null ? null : Math.max(-840, Math.min(840, Number(tz) || 0)),
    };
  }

  const lang = raw.lang ? String(raw.lang).trim().toLowerCase().slice(0, 8) : null;

  let canaryPercent = null;
  if (raw.canaryPercent != null && raw.canaryPercent !== '') {
    const pct = Number(raw.canaryPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { ok: false, error: `${id}: canaryPercent must be 0-100` };
    }
    canaryPercent = Math.round(pct);
  }

  const requireMention = raw.requireMention === true;
  const replyType = ['text', 'buttons', 'list'].includes(raw.replyType) ? raw.replyType : 'text';
  const buttons = (Array.isArray(raw.buttons) ? raw.buttons : [])
    .map((b) => String(b || '').trim())
    .filter(Boolean)
    .slice(0, MAX_BUTTONS);

  /** @type {AutoReplyRule['followUp']} */
  let followUp = null;
  if (raw.followUp && typeof raw.followUp === 'object') {
    const afterMinutes = Number(raw.followUp.afterMinutes);
    const fuText = String(raw.followUp.text || '').trim();
    if (!Number.isFinite(afterMinutes) || afterMinutes < 1 || afterMinutes > 1440) {
      return { ok: false, error: `${id}: followUp.afterMinutes must be 1-1440` };
    }
    if (!fuText) return { ok: false, error: `${id}: followUp.text is required` };
    followUp = { afterMinutes: Math.round(afterMinutes), text: fuText.slice(0, MAX_REPLY_LEN) };
  }

  const useContext = raw.useContext === true;

  return {
    ok: true,
    rule: {
      id,
      name,
      enabled,
      platform,
      pattern,
      flags,
      reply,
      replyVariants,
      cooldownSec,
      scope,
      priority,
      tags,
      quietHours,
      lang,
      canaryPercent,
      requireMention,
      replyType,
      buttons,
      followUp,
      useContext,
    },
  };
}

/**
 * @param {unknown} list
 * @returns {{ ok: true, rules: AutoReplyRule[] } | { ok: false, error: string }}
 */
export function validateRulesList(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'rules must be an array' };
  if (list.length > MAX_RULES) return { ok: false, error: `max ${MAX_RULES} rules` };
  const out = [];
  const ids = new Set();
  for (let i = 0; i < list.length; i++) {
    const n = normalizeRule(list[i]);
    if (!n.ok) return { ok: false, error: n.error };
    if (ids.has(n.rule.id)) return { ok: false, error: `duplicate rule id: ${n.rule.id}` };
    ids.add(n.rule.id);
    out.push(n.rule);
  }
  // Stable priority: higher priority first, then array order
  out.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { ok: true, rules: out };
}

/**
 * @returns {AutoReplyRule[]}
 */
export function loadRules() {
  try {
    if (!fs.existsSync(rulesPath())) {
      const seed = defaultSampleRules();
      saveRules(seed);
      return validateRulesList(seed).rules;
    }
    // Feature 210: corrupt JSON → latest backup.
    const { data: raw, recovered } = loadJsonWithBackup(rulesPath(), []);
    if (recovered) logger.warn('auto-reply rules recovered from backup');
    const list = Array.isArray(raw) ? raw : raw?.rules;
    // Feature 209: schema path errors.
    const schema = validateRulesSchema(list || []);
    if (!schema.ok) {
      logger.warn('auto-reply rules schema invalid', { error: schema.error });
      return [];
    }
    const v = validateRulesList(list || []);
    if (!v.ok) {
      logger.warn('auto-reply rules invalid, using empty list', { error: v.error });
      return [];
    }
    return v.rules;
  } catch (e) {
    logger.warn('auto-reply loadRules failed', { error: e.message || String(e) });
    return [];
  }
}

/**
 * Feature 95: snapshot the previous rules file under config/auto_reply_history/
 * before each save; keep the last HISTORY_KEEP snapshots.
 */
function snapshotRules() {
  try {
    if (!fs.existsSync(rulesPath())) return;
    const dir = historyDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(rulesPath(), path.join(dir, `rules-${stamp}.json`));
    const snaps = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('rules-') && f.endsWith('.json'))
      .sort();
    while (snaps.length > HISTORY_KEEP) {
      const oldest = snaps.shift();
      fs.unlinkSync(path.join(dir, oldest));
    }
  } catch (e) {
    logger.warn('auto-reply rules snapshot failed', { error: e.message || String(e) });
  }
}

/**
 * List available rules snapshots (newest first).
 * @returns {Array<{ file: string, ts: string }>}
 */
export function listRuleSnapshots() {
  try {
    const dir = historyDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('rules-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((file) => ({ file, ts: file.replace(/^rules-/, '').replace(/\.json$/, '') }));
  } catch {
    return [];
  }
}

/**
 * @param {AutoReplyRule[]} rules
 */
export function saveRules(rules) {
  const v = validateRulesList(rules);
  if (!v.ok) throw new Error(v.error);
  snapshotRules();
  // Feature 179: timestamped backup before overwrite.
  try {
    backupFile(rulesPath());
  } catch {
    // backup is best-effort
  }
  fs.mkdirSync(path.dirname(rulesPath()), { recursive: true });
  fs.writeFileSync(rulesPath(), `${JSON.stringify(v.rules, null, 2)}\n`, 'utf8');
  return v.rules;
}

/**
 * Feature 88: diff a proposed rules list against the currently saved rules.
 * @param {unknown} proposed
 * @returns {{ ok: boolean, error?: string, added?: string[], removed?: string[], changed?: string[], unchanged?: string[] }}
 */
export function diffRules(proposed) {
  const v = validateRulesList(proposed);
  if (!v.ok) return { ok: false, error: v.error };
  const current = loadRules();
  const curById = new Map(current.map((r) => [r.id, r]));
  const nextById = new Map(v.rules.map((r) => [r.id, r]));
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [id, rule] of nextById) {
    const cur = curById.get(id);
    if (!cur) added.push(id);
    else if (JSON.stringify(cur) !== JSON.stringify(rule)) changed.push(id);
    else unchanged.push(id);
  }
  const removed = [...curById.keys()].filter((id) => !nextById.has(id));
  return { ok: true, added, removed, changed, unchanged };
}

/**
 * @returns {AutoReplySettings}
 */
export function loadSettings() {
  try {
    if (!fs.existsSync(settingsPath())) {
      saveSettings(DEFAULT_SETTINGS);
      return { ...DEFAULT_SETTINGS };
    }
    // Feature 210: corrupt recovery.
    const { data: raw, recovered } = loadJsonWithBackup(settingsPath(), DEFAULT_SETTINGS);
    if (recovered) logger.warn('auto-reply settings recovered from backup');
    const schema = validateSettingsSchema(raw);
    if (!schema.ok) {
      logger.warn('auto-reply settings schema invalid', { error: schema.error });
    }
    return normalizeSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * @param {any} raw
 * @returns {AutoReplySettings}
 */
function normalizeSettings(raw) {
  const strList = (v, lower = false) =>
    Array.isArray(v)
      ? v.map((s) => (lower ? String(s).toLowerCase() : String(s))).filter(Boolean)
      : [];

  const bhRaw = raw.businessHours && typeof raw.businessHours === 'object' ? raw.businessHours : {};
  const businessHours = {
    enabled: bhRaw.enabled === true,
    start: parseHHMM(bhRaw.start) != null ? String(bhRaw.start) : '09:00',
    end: parseHHMM(bhRaw.end) != null ? String(bhRaw.end) : '18:00',
    days:
      Array.isArray(bhRaw.days) && bhRaw.days.length
        ? bhRaw.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [1, 2, 3, 4, 5],
    tzOffsetMinutes:
      bhRaw.tzOffsetMinutes == null
        ? null
        : Math.max(-840, Math.min(840, Number(bhRaw.tzOffsetMinutes) || 0)),
  };

  /** @type {Array<{ id: string, text: string }>} */
  const templates = (Array.isArray(raw.templates) ? raw.templates : [])
    .map((t) => ({
      id: String(t?.id || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 40),
      text: String(t?.text || '').slice(0, MAX_REPLY_LEN),
    }))
    .filter((t) => t.id && t.text)
    .slice(0, MAX_TEMPLATES);

  return {
    matchMode: raw.matchMode === 'all' ? 'all' : 'first',
    maxRepliesPerHour: Math.max(0, Math.min(10000, Number(raw.maxRepliesPerHour) || 60)),
    stopWords: strList(raw.stopWords, true),
    ignoreList: strList(raw.ignoreList),
    businessHours,
    escalationWords: strList(raw.escalationWords, true),
    mentionTokens: strList(raw.mentionTokens, true),
    allowedLinkDomains: strList(raw.allowedLinkDomains, true),
    approvalRequired: raw.approvalRequired === true,
    notifyWebhookUrl: String(raw.notifyWebhookUrl || '').slice(0, 300),
    memoryWindow: Number.isFinite(Number(raw.memoryWindow))
      ? Math.max(0, Math.min(20, Number(raw.memoryWindow)))
      : 5,
    llmFallback: { enabled: Boolean(raw.llmFallback && raw.llmFallback.enabled === true) },
    templates,
  };
}

/**
 * @param {Partial<AutoReplySettings>} settings
 */
export function saveSettings(settings) {
  const next = normalizeSettings(settings || {});
  try {
    backupFile(settingsPath());
  } catch {
    // best-effort
  }
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * @returns {AutoReplyRule[]}
 */
export function defaultSampleRules() {
  return [
    {
      id: 'internship-hello',
      name: 'Internship hello',
      enabled: true,
      platform: 'whatsapp',
      pattern: 'hello\\s+(internship)(\\s+(.+))?',
      flags: 'i',
      reply: 'Hi! Thanks for asking about $1$2. Apply at https://airepro.in/view/internships',
      cooldownSec: 120,
      scope: 'any',
      priority: 10,
      tags: ['internship'],
    },
    {
      id: 'hours-faq',
      name: 'Business hours',
      enabled: false,
      platform: 'whatsapp',
      pattern: '\\b(hours|timing|open)\\b',
      flags: 'i',
      reply:
        'We typically reply during business hours (IST). Leave your question and we will follow up.',
      cooldownSec: 300,
      scope: 'dm',
      priority: 5,
      tags: ['faq'],
    },
  ];
}

/**
 * @param {object} entry
 */
export function appendMatchLog(entry) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    logger.warn('auto-reply log write failed', { error: e.message || String(e) });
  }
}

/**
 * @param {number} [limit]
 * @returns {object[]}
 */
export function readMatchLog(limit = 50) {
  try {
    if (!fs.existsSync(logPath())) return [];
    const lines = fs.readFileSync(logPath(), 'utf8').split('\n').filter(Boolean);
    const slice = lines.slice(-Math.max(1, Math.min(500, limit)));
    return slice
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Feature 94: match log → CSV (ts, platform, from, scope, text, ruleIds, sent, skipped).
 * @param {object[]} entries
 * @returns {string}
 */
export function matchLogToCsv(entries) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'ts,platform,from,scope,text,ruleIds,replies,sent,skipped';
  const rows = (Array.isArray(entries) ? entries : []).map((e) => {
    const matches = Array.isArray(e.matches) ? e.matches : [];
    return [
      esc(e.ts),
      esc(e.platform),
      esc(e.from),
      esc(e.scope),
      esc(e.text),
      esc(matches.map((m) => m.ruleId).join('; ')),
      esc(matches.map((m) => m.reply).join(' | ')),
      esc(matches.some((m) => m.sent)),
      esc(
        e.skipped ||
          matches
            .map((m) => m.skipped)
            .filter(Boolean)
            .join('; ')
      ),
    ].join(',');
  });
  return [header, ...rows].join('\r\n');
}

/* —— dead-letter queue (84) —— */

/**
 * @param {object} entry
 */
export function appendDlq(entry) {
  try {
    stats.dlq++;
    fs.mkdirSync(path.dirname(dlqPath()), { recursive: true });
    fs.appendFileSync(dlqPath(), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    logger.warn('auto-reply DLQ write failed', { error: e.message || String(e) });
  }
}

/**
 * @param {number} [limit]
 * @returns {object[]}
 */
export function readDlq(limit = 50) {
  try {
    if (!fs.existsSync(dlqPath())) return [];
    const lines = fs.readFileSync(dlqPath(), 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

/* —— idempotency (83) —— */

/**
 * Record and test webhook message ids for 24h dedupe.
 * @param {string} messageId
 * @returns {boolean} true when the id was already seen (duplicate)
 */
export function isDuplicateMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  const now = Date.now();
  // opportunistic purge
  if (seenMessageIds.size > SEEN_MAX) {
    for (const [k, ts] of seenMessageIds) {
      if (now - ts > SEEN_TTL_MS) seenMessageIds.delete(k);
      if (seenMessageIds.size <= SEEN_MAX / 2) break;
    }
  }
  const seenAt = seenMessageIds.get(id);
  if (seenAt != null && now - seenAt < SEEN_TTL_MS) return true;
  seenMessageIds.set(id, now);
  return false;
}

/* —— human takeover (76) —— */

/**
 * @returns {Record<string, { active: boolean, ts: string }>}
 */
export function loadTakeovers() {
  try {
    if (!fs.existsSync(takeoverPath())) return {};
    const raw = JSON.parse(fs.readFileSync(takeoverPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} platform
 * @param {string} from
 * @param {boolean} active
 * @returns {Record<string, { active: boolean, ts: string }>}
 */
export function setTakeover(platform, from, active) {
  const chatKey = `${String(platform || 'whatsapp').toLowerCase()}:${String(from || '').trim()}`;
  const all = loadTakeovers();
  if (active) {
    all[chatKey] = { active: true, ts: new Date().toISOString() };
  } else {
    delete all[chatKey];
    cancelFollowUps(chatKey);
  }
  fs.mkdirSync(path.dirname(takeoverPath()), { recursive: true });
  fs.writeFileSync(takeoverPath(), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return all;
}

/**
 * @param {string} chatKey
 * @returns {boolean}
 */
export function isTakenOver(chatKey) {
  const all = loadTakeovers();
  return Boolean(all[chatKey]?.active);
}

/* —— approval queue (92) —— */

/**
 * @returns {object[]}
 */
export function listApprovals() {
  try {
    if (!fs.existsSync(approvalsPath())) return [];
    const raw = JSON.parse(fs.readFileSync(approvalsPath(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/**
 * @param {object[]} list
 */
function writeApprovals(list) {
  fs.mkdirSync(path.dirname(approvalsPath()), { recursive: true });
  fs.writeFileSync(approvalsPath(), `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

/**
 * @param {{ platform: string, to: string, ruleId: string, reply: string }} item
 * @returns {object} queued approval entry
 */
export function enqueueApproval(item) {
  const entry = {
    id: `apr-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    ts: new Date().toISOString(),
    status: 'pending',
    platform: item.platform,
    to: item.to,
    ruleId: item.ruleId,
    reply: item.reply,
  };
  const list = listApprovals();
  list.push(entry);
  writeApprovals(list.slice(-200));
  return entry;
}

/**
 * Approve (send via deps.sendReply if armed) or reject a queued reply.
 * @param {string} id
 * @param {'approve' | 'reject'} action
 * @param {{ sendReply?: (args: { platform: string, to: string, text: string, ruleId: string }) => Promise<unknown> }} [deps]
 * @returns {Promise<{ ok: boolean, error?: string, entry?: object }>}
 */
export async function resolveApproval(id, action, deps = {}) {
  const list = listApprovals();
  const entry = list.find((e) => e.id === id);
  if (!entry) return { ok: false, error: 'approval not found' };
  if (entry.status !== 'pending') return { ok: false, error: `approval already ${entry.status}` };

  if (action === 'reject') {
    entry.status = 'rejected';
    entry.resolvedAt = new Date().toISOString();
    writeApprovals(list);
    return { ok: true, entry };
  }

  if (!isAutoReplyEnabled() || !platformAutoReplyEnabled(entry.platform)) {
    return {
      ok: false,
      error: 'AUTO_REPLY_ENABLED (or platform flag) is off — cannot send approved reply',
    };
  }
  if (typeof deps.sendReply !== 'function') {
    return { ok: false, error: 'no sender wired for approvals' };
  }
  try {
    await deps.sendReply({
      platform: entry.platform,
      to: entry.to,
      text: entry.reply,
      ruleId: entry.ruleId,
    });
    entry.status = 'sent';
    entry.resolvedAt = new Date().toISOString();
    stats.sent++;
    recentSends.push(Date.now());
    writeApprovals(list);
    return { ok: true, entry };
  } catch (e) {
    entry.status = 'failed';
    entry.error = e.message || String(e);
    entry.resolvedAt = new Date().toISOString();
    writeApprovals(list);
    appendDlq({ ts: new Date().toISOString(), kind: 'approvalSend', ...entry });
    return { ok: false, error: entry.error, entry };
  }
}

/* —— follow-ups (75) —— */

/**
 * @returns {Array<{ id: string, dueAt: number, chatKey: string, platform: string, to: string, ruleId: string, text: string }>}
 */
export function listFollowUps() {
  return pendingFollowUps.map((f) => ({ ...f }));
}

/**
 * @param {string} chatKey
 */
export function cancelFollowUps(chatKey) {
  for (let i = pendingFollowUps.length - 1; i >= 0; i--) {
    if (pendingFollowUps[i].chatKey === chatKey) pendingFollowUps.splice(i, 1);
  }
}

/**
 * Send (or dry-run) all due follow-ups. Skips chats under human takeover.
 * @param {{ sendReply?: Function, dryRun?: boolean, now?: number }} [deps]
 * @returns {Promise<object[]>} processed follow-ups
 */
export async function processFollowUps(deps = {}) {
  const now = deps.now ?? Date.now();
  const due = pendingFollowUps.filter((f) => f.dueAt <= now);
  const results = [];
  for (const f of due) {
    const idx = pendingFollowUps.indexOf(f);
    if (idx >= 0) pendingFollowUps.splice(idx, 1);
    if (isTakenOver(f.chatKey)) {
      results.push({ ...f, sent: false, skipped: 'takeover' });
      continue;
    }
    const armed = isAutoReplyEnabled() && platformAutoReplyEnabled(f.platform);
    if (deps.dryRun !== false || !armed || typeof deps.sendReply !== 'function') {
      results.push({ ...f, sent: false, skipped: deps.dryRun !== false ? 'dryRun' : 'notArmed' });
      continue;
    }
    try {
      await deps.sendReply({ platform: f.platform, to: f.to, text: f.text, ruleId: f.ruleId });
      stats.sent++;
      recentSends.push(Date.now());
      results.push({ ...f, sent: true });
    } catch (e) {
      appendDlq({
        ts: new Date().toISOString(),
        kind: 'followUp',
        ...f,
        error: e.message || String(e),
      });
      results.push({ ...f, sent: false, error: e.message || String(e) });
    }
  }
  return results;
}

/* —— conversation memory (90) —— */

/**
 * @param {string} chatKey
 * @param {string} text
 * @param {number} windowSize
 */
function rememberInbound(chatKey, text, windowSize) {
  if (!windowSize) return;
  const arr = memoryByChat.get(chatKey) || [];
  arr.push(String(text || '').slice(0, 500));
  while (arr.length > windowSize) arr.shift();
  memoryByChat.set(chatKey, arr);
}

/**
 * @param {string} chatKey
 * @returns {string[]}
 */
export function getConversationMemory(chatKey) {
  return [...(memoryByChat.get(chatKey) || [])];
}

/* —— matching —— */

/**
 * Render a rule's final reply text: variant pick → template expansion → captures.
 * @param {AutoReplyRule} rule
 * @param {RegExpMatchArray | null} match
 * @param {AutoReplySettings} settings
 * @param {() => number} [rng]
 * @returns {{ reply: string, variantIndex: number | null }}
 */
export function renderRuleReply(rule, match, settings, rng = Math.random) {
  const { text, variantIndex } = pickReplyVariant(rule, rng);
  const expanded = expandTemplates(text, settings);
  return { reply: formatReply(expanded, match), variantIndex };
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @returns {Array<{ rule: AutoReplyRule, match: string[], reply: string, variantIndex: number | null }>}
 */
export function matchRules(text, opts = {}) {
  const input = String(text || '');
  if (input.length > MAX_TEST_TEXT_LEN) {
    throw new Error(`text max length is ${MAX_TEST_TEXT_LEN}`);
  }
  const settings = opts.settings || loadSettings();
  const rules = opts.rules || loadRules();
  const platform = opts.platform ? String(opts.platform).toLowerCase() : null;
  const scope = opts.scope ? String(opts.scope).toLowerCase() : 'any';
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const lower = input.toLowerCase();

  for (const sw of settings.stopWords || []) {
    if (sw && lower.includes(sw)) return [];
  }

  const detected = detectLanguage(input);
  const contextText = opts.chatKey ? getConversationMemory(opts.chatKey).join('\n') : '';

  const hits = [];
  const ordered = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of ordered) {
    if (opts.includeDisabled !== true && !rule.enabled) continue;
    if (platform && rule.platform !== platform) continue;
    if (rule.scope && rule.scope !== 'any' && scope !== 'any' && rule.scope !== scope) continue;
    // Feature 78: language gate — only when detection is confident.
    if (rule.lang && detected !== 'unknown' && detected !== rule.lang) continue;

    let re;
    try {
      re = new RegExp(rule.pattern, rule.flags || '');
    } catch {
      continue;
    }

    // Feature 90: contextual rules match against the recent window too.
    const haystack = rule.useContext && contextText ? `${contextText}\n${input}` : input;

    let m;
    try {
      m = safeMatch(re, haystack);
    } catch {
      continue;
    }
    if (!m) continue;

    const { reply, variantIndex } = renderRuleReply(rule, m, settings, rng);
    hits.push({
      rule: { ...rule },
      match: [...m],
      reply,
      variantIndex,
    });

    if (settings.matchMode !== 'all') break;
  }

  return hits;
}

/**
 * @param {AutoReplySettings} settings
 * @returns {boolean}
 */
function underHourlyCap(settings) {
  const cap = settings.maxRepliesPerHour;
  if (!cap) return true;
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (recentSends.length && recentSends[0] < cutoff) recentSends.shift();
  return recentSends.length < cap;
}

/**
 * @param {string} chatKey
 * @param {number} cooldownSec
 * @returns {boolean} true if allowed
 */
function checkCooldown(chatKey, cooldownSec) {
  if (!cooldownSec) return true;
  const until = cooldownUntil.get(chatKey) || 0;
  return Date.now() >= until;
}

/**
 * @param {string} chatKey
 * @param {number} cooldownSec
 */
function markCooldown(chatKey, cooldownSec) {
  if (!cooldownSec) return;
  cooldownUntil.set(chatKey, Date.now() + cooldownSec * 1000);
}

/**
 * Feature 93: fire-and-forget ops notification after a live send.
 * @param {AutoReplySettings} settings
 * @param {object} payload
 * @param {{ notify?: (url: string, payload: object) => Promise<unknown> }} deps
 */
async function notifyOps(settings, payload, deps) {
  const url = String(settings.notifyWebhookUrl || '').trim();
  if (!url) return;
  try {
    if (typeof deps.notify === 'function') {
      await deps.notify(url, payload);
    } else {
      // Feature 211: always use fetchWithTimeout (no bare fetch).
      await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        5000
      );
    }
  } catch (e) {
    logger.warn('auto-reply ops notify failed', { error: e.message || String(e) });
  }
}

/**
 * Process an inbound message: match, log, optionally send.
 * @param {object} inbound { text, platform, from, isGroup, dryRun, messageId, type }
 * @param {object} [deps] { sendReply, generateDraft, notify, rng, now }
 * @returns {Promise<object>}
 */
export async function processInbound(inbound, deps = {}) {
  const text = String(inbound.text || '');
  const platform = String(inbound.platform || 'whatsapp').toLowerCase();
  const from = String(inbound.from || 'unknown');
  const chatKey = `${platform}:${from}`;
  const scope = inbound.isGroup ? 'group' : 'dm';
  const dryRun = inbound.dryRun !== false; // default dry
  const now = deps.now instanceof Date ? deps.now : new Date();
  const settings = deps.settings || loadSettings();
  stats.inbound++;

  const skipResult = (reason, extra = {}) => {
    countSkip(reason);
    const result = { ok: true, skipped: reason, matches: [], sent: false, ...extra };
    appendMatchLog({
      ts: new Date().toISOString(),
      ...result,
      from,
      platform,
      scope,
      text: text.slice(0, 200),
    });
    return result;
  };

  // Feature 83: idempotency — drop duplicate webhook deliveries for 24h.
  if (inbound.messageId && isDuplicateMessage(inbound.messageId)) {
    return skipResult('duplicate', { messageId: String(inbound.messageId) });
  }

  // Feature 79: media stub — log non-text messages without crashing.
  if (inbound.type && String(inbound.type) !== 'text') {
    return skipResult('mediaType', { mediaType: String(inbound.type) });
  }

  if ((settings.ignoreList || []).includes(from)) {
    return skipResult('ignoreList');
  }

  // Feature 76: human takeover pauses all auto-replies for the chat.
  if (isTakenOver(chatKey)) {
    return skipResult('takeover');
  }

  // Feature 77: escalation keywords — never auto-reply to angry messages.
  const lower = text.toLowerCase();
  if ((settings.escalationWords || []).some((w) => w && lower.includes(w))) {
    return skipResult('escalation');
  }

  // Feature 98: group mention guard — tokens default to @{brand}.
  const mentionTokens = (settings.mentionTokens || []).length
    ? settings.mentionTokens
    : [`@${config.brand.name}`];

  // Feature 90: remember inbound for contextual rules.
  rememberInbound(chatKey, text, settings.memoryWindow ?? 5);

  const matches = matchRules(text, { platform, scope, settings, chatKey, rng: deps.rng });
  stats.matches += matches.length;

  // Feature 91: optional LLM draft when nothing matched (never auto-sent).
  let llmDraft = null;
  if (
    !matches.length &&
    settings.llmFallback?.enabled &&
    typeof deps.generateDraft === 'function'
  ) {
    try {
      llmDraft = String(await deps.generateDraft(text)).slice(0, MAX_REPLY_LEN);
    } catch (e) {
      logger.warn('auto-reply LLM fallback failed', { error: e.message || String(e) });
    }
  }

  const autoEnabled = isAutoReplyEnabled();
  const platformEnabled = platformAutoReplyEnabled(platform);
  const shouldSend = !dryRun && autoEnabled && platformEnabled && matches.length > 0;

  /** @type {object[]} */
  const actions = [];

  for (const hit of matches) {
    const key = `${chatKey}:${hit.rule.id}`;
    const cooled = checkCooldown(key, hit.rule.cooldownSec);
    const rateOk = underHourlyCap(settings);
    const link = linkGuard(hit.reply, settings.allowedLinkDomains);
    let sent = false;
    let sendError = null;
    let skipped = null;
    let approvalId = null;

    const mentionBlocked =
      scope === 'group' && hit.rule.requireMention === true && !hasMention(text, mentionTokens);

    if (!shouldSend) {
      skipped = dryRun
        ? 'dryRun'
        : !autoEnabled
          ? 'AUTO_REPLY_ENABLED=false'
          : !platformEnabled
            ? 'platformDisabled'
            : null;
    } else if (mentionBlocked) {
      skipped = 'mentionRequired';
    } else if (inQuietHours(hit.rule.quietHours, now)) {
      skipped = 'quietHours';
    } else if (!withinBusinessHours(settings.businessHours, now)) {
      skipped = 'businessHours';
    } else if (!canaryAllows(chatKey, hit.rule.canaryPercent)) {
      skipped = 'canary';
    } else if (!link.ok) {
      skipped = 'linkGuard';
    } else if (!cooled) {
      skipped = 'cooldown';
    } else if (!rateOk) {
      skipped = 'rateLimit';
    } else if (settings.approvalRequired) {
      // Feature 92: queue for operator approval instead of sending.
      const entry = enqueueApproval({ platform, to: from, ruleId: hit.rule.id, reply: hit.reply });
      approvalId = entry.id;
      skipped = 'approvalQueue';
    } else if (typeof deps.sendReply === 'function') {
      try {
        await deps.sendReply({
          platform,
          to: from,
          text: hit.reply,
          ruleId: hit.rule.id,
          payload: buildReplyPayload(hit.rule, hit.reply),
        });
        sent = true;
        stats.sent++;
        markCooldown(key, hit.rule.cooldownSec);
        recentSends.push(Date.now());
        // Feature 75: schedule follow-up after a successful send.
        if (hit.rule.followUp) {
          pendingFollowUps.push({
            id: `fu-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            dueAt: Date.now() + hit.rule.followUp.afterMinutes * 60 * 1000,
            chatKey,
            platform,
            to: from,
            ruleId: hit.rule.id,
            text: expandTemplates(hit.rule.followUp.text, settings),
          });
        }
        await notifyOps(
          settings,
          { event: 'auto-reply-sent', platform, ruleId: hit.rule.id, ts: new Date().toISOString() },
          deps
        );
      } catch (e) {
        sendError = e.message || String(e);
        // Feature 84: DLQ for failed sends.
        appendDlq({
          ts: new Date().toISOString(),
          kind: 'send',
          platform,
          to: from,
          ruleId: hit.rule.id,
          reply: hit.reply,
          error: sendError,
        });
      }
    } else {
      skipped = 'noSender';
    }

    countSkip(skipped);
    actions.push({
      ruleId: hit.rule.id,
      reply: hit.reply,
      match: hit.match,
      variantIndex: hit.variantIndex ?? null,
      sent,
      skipped,
      sendError,
      ...(approvalId ? { approvalId } : {}),
    });
  }

  const result = {
    ok: true,
    dryRun: !shouldSend || dryRun,
    autoReplyEnabled: autoEnabled,
    platformAutoReplyEnabled: platformEnabled,
    matches: actions,
    sent: actions.some((a) => a.sent),
    ...(llmDraft ? { llmDraft } : {}),
  };

  appendMatchLog({
    ts: new Date().toISOString(),
    platform,
    from,
    scope,
    text: text.slice(0, 500),
    dryRun: result.dryRun,
    autoReplyEnabled: autoEnabled,
    ...(llmDraft ? { llmDraft: llmDraft.slice(0, 300) } : {}),
    matches: actions.map((a) => ({
      ruleId: a.ruleId,
      reply: a.reply,
      sent: a.sent,
      skipped: a.skipped,
      sendError: a.sendError,
    })),
  });

  logger.info('auto-reply processInbound', {
    platform,
    from: from.slice(0, 6) + '…',
    matchCount: matches.length,
    sent: result.sent,
    dryRun: result.dryRun,
  });

  return result;
}

/**
 * Feature 100: replay a sample inbox through the engine (always dry-run).
 * @param {Array<{ text: string, from?: string, platform?: string, isGroup?: boolean, type?: string, messageId?: string }>} messages
 * @param {object} [deps]
 * @returns {Promise<{ ok: boolean, total: number, matched: number, results: object[] }>}
 */
export async function simulateInbox(messages, deps = {}) {
  const list = (Array.isArray(messages) ? messages : []).slice(0, 200);
  const results = [];
  for (const msg of list) {
    const r = await processInbound(
      {
        text: msg.text,
        from: msg.from || 'sim-user',
        platform: msg.platform || 'whatsapp',
        isGroup: Boolean(msg.isGroup),
        type: msg.type,
        messageId: msg.messageId,
        dryRun: true, // simulator is always dry
      },
      deps
    );
    results.push({
      from: msg.from || 'sim-user',
      text: String(msg.text || '').slice(0, 120),
      ...r,
    });
  }
  return {
    ok: true,
    total: results.length,
    matched: results.filter((r) => (r.matches || []).length > 0).length,
    results,
  };
}
