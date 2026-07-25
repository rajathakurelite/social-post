/**
 * Shared HTTP middleware for Wave-3 reliability (171–173, 190–191, 198, 200, 202, 218).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { errorEnvelope, ApiError } from '../utils/errors.js';
import { appendJsonl } from '../utils/jsonl.js';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
export const API_VERSION = String(pkg.version || '0.0.0');

const accessLogPath = path.join(config.rootDir, 'output', 'api-access.jsonl');
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 2000;

const LOCAL_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:8787',
  'http://localhost:8787',
  'null', // file:// / some Vite edge cases
]);

/** Feature 198: localhost-only CORS allowlist. */
export function corsMiddleware() {
  return cors({
    origin(origin, cb) {
      if (!origin || LOCAL_ORIGINS.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  });
}

/** Feature 171 + 200: requestId + x-api-version on every response. */
export function requestContextMiddleware(req, res, next) {
  const requestId = crypto.randomBytes(8).toString('hex');
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-api-version', API_VERSION);
  const started = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - started;
    try {
      appendJsonl(accessLogPath, {
        ts: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.path || req.url,
        status: res.statusCode,
        durationMs,
      });
    } catch {
      // never break the response for access logging
    }
    if (durationMs >= SLOW_MS) {
      logger.warn('Slow request', { requestId, path: req.path, durationMs });
    }
  });
  next();
}

/**
 * Feature 172/173: central error handler → structured envelope.
 * Mount last: `app.use(errorHandler)`.
 */
export function errorHandler(err, req, res, _next) {
  const status = err instanceof ApiError ? err.status : err.status || 500;
  const code = err instanceof ApiError ? err.code : err.code || 'INTERNAL';
  const requestId = req.requestId;
  if (status >= 500) {
    logger.error('Unhandled route error', { requestId, message: err.message || String(err) });
  }
  res.status(status).json(
    errorEnvelope({
      error: err.message || String(err),
      code: typeof code === 'string' ? code : 'INTERNAL',
      requestId,
      details: err.details,
    })
  );
}

/**
 * Helper for routes that still return ad-hoc errors — upgrade to envelope.
 * @param {import('express').Response} res
 * @param {import('express').Request} req
 * @param {number} status
 * @param {string} error
 * @param {string} [code]
 */
export function sendError(res, req, status, error, code = 'VALIDATION') {
  return res.status(status).json(errorEnvelope({ error, code, requestId: req.requestId }));
}

/**
 * Feature 199: refuse non-loopback bind unless ALLOW_NONLOCAL=true.
 * @param {string} host
 */
export function assertBindHost(host) {
  const h = String(host || '127.0.0.1').toLowerCase();
  const loopback = h === '127.0.0.1' || h === 'localhost' || h === '::1';
  if (loopback) return;
  if (String(process.env.ALLOW_NONLOCAL || '').toLowerCase() === 'true') return;
  throw new Error(
    `Refusing to bind UI_API_HOST=${host} — set ALLOW_NONLOCAL=true to expose beyond loopback`
  );
}

/**
 * Feature 197: friendly EADDRINUSE message.
 * @param {NodeJS.ErrnoException} err
 * @param {number} port
 * @returns {string}
 */
export function formatListenError(err, port) {
  if (err && err.code === 'EADDRINUSE') {
    return `port ${port} busy — is another dev server running?`;
  }
  return err?.message || String(err);
}

/** Ensure access log directory exists (tests may delete output/). */
export function ensureAccessLogDir() {
  fs.mkdirSync(path.dirname(accessLogPath), { recursive: true });
}

export { accessLogPath };
