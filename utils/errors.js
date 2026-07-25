// @ts-nocheck
/**
 * Wave-3 error taxonomy (features 172, 212) — stable codes for the API envelope.
 */

/** @type {readonly string[]} */
export const ERROR_CODES = Object.freeze([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAUSED',
  'DEMO',
  'FORBIDDEN',
  'OLLAMA_DOWN',
  'OLLAMA_CIRCUIT_OPEN',
  'FB_TOKEN_EXPIRED',
  'TWITTER_TOKEN_EXPIRED',
  'LINKEDIN_TOKEN_EXPIRED',
  'YOUTUBE_TOKEN_EXPIRED',
  'WHATSAPP_TOKEN_EXPIRED',
  'TOKEN_EXPIRED',
  'PUBLISH_LOCKED',
  'INTERNAL',
]);

const CODE_SET = new Set(ERROR_CODES);

/**
 * @param {string} code
 * @returns {boolean}
 */
export function isKnownErrorCode(code) {
  return CODE_SET.has(String(code || ''));
}

/**
 * Typed API error — always carries a known taxonomy code.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, details?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ApiError';
    const code = isKnownErrorCode(opts.code) ? opts.code : 'INTERNAL';
    this.code = code;
    this.status = Number.isFinite(opts.status) ? opts.status : defaultStatus(code);
    this.details = opts.details;
  }
}

/**
 * @param {string} code
 * @returns {number}
 */
function defaultStatus(code) {
  switch (code) {
    case 'VALIDATION':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'PUBLISH_LOCKED':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'PAUSED':
      return 503;
    case 'DEMO':
    case 'FORBIDDEN':
      return 403;
    case 'OLLAMA_DOWN':
    case 'OLLAMA_CIRCUIT_OPEN':
      return 503;
    case 'FB_TOKEN_EXPIRED':
    case 'TWITTER_TOKEN_EXPIRED':
    case 'LINKEDIN_TOKEN_EXPIRED':
    case 'YOUTUBE_TOKEN_EXPIRED':
    case 'WHATSAPP_TOKEN_EXPIRED':
    case 'TOKEN_EXPIRED':
      return 401;
    default:
      return 500;
  }
}

/**
 * Map platform API error bodies to friendly token-expiry guidance (feature 213).
 * @param {string} platform
 * @param {unknown} bodyOrMessage
 * @returns {{ code: string, message: string } | null}
 */
export function mapTokenExpiry(platform, bodyOrMessage) {
  const raw =
    typeof bodyOrMessage === 'string' ? bodyOrMessage : JSON.stringify(bodyOrMessage || '');
  const lower = raw.toLowerCase();
  const looksExpired =
    /\b190\b/.test(raw) ||
    /token.*(expired|invalid)/i.test(raw) ||
    /oauth.*exception/i.test(lower) ||
    /invalid_grant/i.test(lower) ||
    /\b401\b/.test(raw);

  if (!looksExpired) return null;

  const plat = String(platform || '').toLowerCase();
  const codeMap = {
    facebook: 'FB_TOKEN_EXPIRED',
    twitter: 'TWITTER_TOKEN_EXPIRED',
    linkedin: 'LINKEDIN_TOKEN_EXPIRED',
    youtube: 'YOUTUBE_TOKEN_EXPIRED',
    whatsapp: 'WHATSAPP_TOKEN_EXPIRED',
  };
  const code = codeMap[plat] || 'TOKEN_EXPIRED';
  const doc = plat ? `docs/${plat}.md` : 'docs/';
  return {
    code,
    message: `Token expired or revoked — refresh credentials (see ${doc})`,
  };
}

/**
 * Build the structured error envelope (feature 172).
 * @param {{ error: string, code?: string, requestId?: string, details?: unknown }} args
 */
export function errorEnvelope({ error, code = 'INTERNAL', requestId, details }) {
  /** @type {Record<string, unknown>} */
  const body = {
    error: String(error || 'Unknown error'),
    code: isKnownErrorCode(code) ? code : 'INTERNAL',
  };
  if (requestId) body.requestId = requestId;
  if (details !== undefined) body.details = details;
  return body;
}
