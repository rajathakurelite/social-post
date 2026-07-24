/**
 * Lightweight structured console logger for scripts and skills.
 * Timestamps every line for operational debugging.
 * Meta objects redact keys that look like secrets (token, secret, password, etc.).
 */

const SENSITIVE_KEY_RE =
  /^(authorization|access[_-]?token|refresh[_-]?token|page[_-]?token|api[_-]?key|api[_-]?secret|client[_-]?secret|password|secret|token)$/i;

function ts() {
  return new Date().toISOString();
}

/**
 * Deep-redact sensitive keys in plain objects/arrays. Leaves primitives unchanged.
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactMeta(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactMeta);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      out[k] = redactMeta(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Strip accidental Bearer / token= fragments from free-form error strings.
 * @param {unknown} err
 * @returns {unknown}
 */
function sanitizeErr(err) {
  if (typeof err !== 'string') return err;
  return err
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access_token=)[^&\s]+/gi, '$1[REDACTED]');
}

export const logger = {
  /** General informational messages. */
  info(message, meta) {
    if (meta !== undefined) console.log(`[${ts()}] [INFO]`, message, redactMeta(meta));
    else console.log(`[${ts()}] [INFO]`, message);
  },

  /** Errors and failures (still throws upstream; this is for logging). */
  error(message, err) {
    if (err !== undefined) console.error(`[${ts()}] [ERROR]`, message, sanitizeErr(err));
    else console.error(`[${ts()}] [ERROR]`, message);
  },

  /** Positive completion (posted, generated, etc.). */
  success(message, meta) {
    if (meta !== undefined) console.log(`[${ts()}] [SUCCESS]`, message, redactMeta(meta));
    else console.log(`[${ts()}] [SUCCESS]`, message);
  },
};
