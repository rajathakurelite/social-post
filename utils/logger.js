// @ts-nocheck
/**
 * Lightweight structured console logger for scripts and skills.
 * Features 189 (token redaction), 219 (LOG_LEVEL), 226 (noise dedupe).
 */

const SENSITIVE_KEY_RE =
  /^(authorization|access[_-]?token|refresh[_-]?token|page[_-]?token|api[_-]?key|api[_-]?secret|client[_-]?secret|password|secret|token)$/i;

/** Token-like substrings in free-form messages (EAAG…, AKIA…, long hex). */
const TOKENISH_RE = /\b(EAAG[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16}|[A-Fa-f0-9]{32,})\b/g;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, success: 20 };

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function allowed(level) {
  return (LEVELS[level] ?? 20) >= currentLevel();
}

function ts() {
  return new Date().toISOString();
}

/**
 * Mask token-like substrings (feature 189).
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactTokens(value) {
  if (typeof value === 'string') {
    return value.replace(TOKENISH_RE, '****');
  }
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactTokens);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) out[k] = '[REDACTED]';
    else out[k] = redactTokens(v);
  }
  return out;
}

/**
 * Deep-redact sensitive keys in plain objects/arrays.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactMeta(value) {
  return redactTokens(value);
}

/**
 * Strip accidental Bearer / token= fragments from free-form error strings.
 * @param {unknown} err
 * @returns {unknown}
 */
function sanitizeErr(err) {
  if (typeof err !== 'string') return redactTokens(err);
  return redactTokens(
    err
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]')
  );
}

/** Feature 226: collapse identical error lines within a minute. */
const dedupe = new Map();

function shouldEmit(key) {
  const now = Date.now();
  const prev = dedupe.get(key);
  if (!prev || now - prev.t > 60_000) {
    dedupe.set(key, { t: now, n: 1 });
    return { emit: true, repeated: 0 };
  }
  prev.n += 1;
  // emit only on first + every 50th within the window
  if (prev.n === 2 || prev.n % 50 === 0) {
    return { emit: true, repeated: prev.n };
  }
  return { emit: false, repeated: prev.n };
}

export const logger = {
  debug(message, meta) {
    if (!allowed('debug')) return;
    if (meta !== undefined)
      console.log(`[${ts()}] [DEBUG]`, redactTokens(message), redactMeta(meta));
    else console.log(`[${ts()}] [DEBUG]`, redactTokens(message));
  },

  info(message, meta) {
    if (!allowed('info')) return;
    if (meta !== undefined)
      console.log(`[${ts()}] [INFO]`, redactTokens(message), redactMeta(meta));
    else console.log(`[${ts()}] [INFO]`, redactTokens(message));
  },

  warn(message, meta) {
    if (!allowed('warn')) return;
    if (meta !== undefined)
      console.warn(`[${ts()}] [WARN]`, redactTokens(message), redactMeta(meta));
    else console.warn(`[${ts()}] [WARN]`, redactTokens(message));
  },

  error(message, err) {
    if (!allowed('error')) return;
    const key = `${message}|${typeof err === 'string' ? err : err?.message || ''}`;
    const { emit, repeated } = shouldEmit(key);
    if (!emit) return;
    const suffix = repeated > 1 ? { repeated } : undefined;
    if (err !== undefined) {
      console.error(`[${ts()}] [ERROR]`, redactTokens(message), sanitizeErr(err), suffix || '');
    } else {
      console.error(`[${ts()}] [ERROR]`, redactTokens(message), suffix || '');
    }
  },

  success(message, meta) {
    if (!allowed('info')) return;
    if (meta !== undefined)
      console.log(`[${ts()}] [SUCCESS]`, redactTokens(message), redactMeta(meta));
    else console.log(`[${ts()}] [SUCCESS]`, redactTokens(message));
  },
};

/** Test helper. */
export function _resetLogDedupe() {
  dedupe.clear();
}
