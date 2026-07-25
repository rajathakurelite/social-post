// @ts-nocheck
/**
 * Local operator API for ai-social-agent.
 * Binds to 127.0.0.1 only — no auth in v1; uses project .env credentials.
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { pathToFileURL } from 'url';
import {
  config,
  filterEnabledPlatforms,
  hasTwitterConfig,
  assertFacebookConfig,
  assertTwitterConfig,
  assertLinkedInConfig,
  assertYouTubeConfig,
  assertWhatsAppConfig,
} from '../config/config.js';
import {
  generateMultiPlatformPack,
  generateFacebookCreative,
  defaultFacebookCreative,
  assertOllamaReady,
  generatePost,
  assertBrandBrief,
} from '../skills/generate_post.js';
import {
  renderCreativePng,
  CREATIVE_TEMPLATES,
  CREATIVE_THEMES,
  resolveCreativeStyle,
} from '../skills/render_creative.js';
import {
  applyUtm,
  expandLinkSlugs,
  suggestYoutubeTags,
  capYoutubeTags,
} from '../skills/compose_tools.js';
import { loadLinkSlugs } from '../skills/compose_config.js';
import { loadUtmSettings } from '../skills/utm_store.js';
import { appendPublishLog } from '../skills/publish_history.js';
import { isQueueArmed } from '../skills/schedule_store.js';
import { createWave3Router } from './wave3.js';
import { createOpsRouter, appendOutboundAudit } from './ops.js';
import {
  corsMiddleware,
  requestContextMiddleware,
  errorHandler,
  sendError,
  assertBindHost,
  formatListenError,
  API_VERSION,
  ensureAccessLogDir,
} from './middleware.js';
import {
  bootIso,
  computeHealthStatus,
  freeDiskBytes,
  checkRssWatchdog,
  pushHealthSnapshot,
  getHealthHistory,
  staleEnvFlag,
} from './health_util.js';
import { createCircuitBreaker } from '../utils/circuit_breaker.js';
import { getRetryCounts } from '../utils/retry.js';
import { errorEnvelope } from '../utils/errors.js';
import { isPaused } from '../utils/ops_state.js';
import { loadFeatureFlags } from '../utils/feature_flags.js';
import { acquirePidLock, releasePidLock } from '../utils/ops_state.js';
import {
  postToFacebook,
  postPhotoToFacebook,
  sendMessengerReply,
  buildFacebookFeedPayload,
  buildFacebookPhotoPayload,
} from '../skills/post_facebook.js';
import { postToTwitter } from '../skills/post_twitter.js';
import { postToLinkedIn } from '../skills/post_linkedin.js';
import { postToYouTube } from '../skills/post_youtube.js';
import { postToWhatsApp } from '../skills/post_whatsapp.js';
import { buildTwitterMediaPayload, buildLinkedInDocumentPayload } from '../skills/compose_tools.js';
import {
  quarantineWebhook,
  checkWebhookFreshness,
  isMalformedWebhook,
} from '../utils/webhook_quarantine.js';
import { purgeUploadsToCap } from '../utils/upload_quota.js';
import { startCreativesTtlInterval } from '../utils/creatives_ttl.js';
import { withWriteLock } from '../utils/write_lock.js';
import { fetchWithTimeout } from '../utils/http_fetch.js';
import {
  loadRules,
  saveRules,
  loadSettings,
  saveSettings,
  matchRules,
  keywordToRegex,
  processInbound,
  readMatchLog,
  isAutoReplyEnabled,
  platformAutoReplyEnabled,
  getStats,
  readDlq,
  matchLogToCsv,
  diffRules,
  listRuleSnapshots,
  explainPattern,
  loadTakeovers,
  setTakeover,
  listApprovals,
  resolveApproval,
  listFollowUps,
  processFollowUps,
  simulateInbox,
} from '../skills/auto_reply.js';
import { logger } from '../utils/logger.js';

const HOST = process.env.UI_API_HOST || '127.0.0.1';
const PORT = Number(process.env.UI_API_PORT) || 8787;
const ALLOWED = new Set(['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 120_000;

const creativesDir = path.join(config.rootDir, 'output', 'creatives');
const uploadsDir = path.join(config.rootDir, 'output', 'uploads');
fs.mkdirSync(creativesDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
ensureAccessLogDir();

const ollamaBreaker = createCircuitBreaker({
  failureThreshold: Number(process.env.OLLAMA_BREAKER_THRESHOLD) || 3,
  cooldownMs: Number(process.env.OLLAMA_BREAKER_COOLDOWN_MS) || 30_000,
});

/** Feature 203: publish idempotency cache (10 minutes). */
const idempotencyCache = new Map();
/** Feature 204: one live publish at a time. */
let livePublishInFlight = false;
/** Feature 182: in-flight polish/publish counter for drain. */
let inFlightMutations = 0;

const app = express();
app.use(requestContextMiddleware);
app.use(corsMiddleware());
/** Feature 192: tighter body cap on webhook routes vs global 6mb. */
const WEBHOOK_BODY_MAX = Number(process.env.WEBHOOK_BODY_MAX_BYTES) || 256 * 1024;
app.use((req, res, next) => {
  if (req.method === 'POST' && String(req.path || '').startsWith('/api/webhooks')) {
    const len = Number(req.headers['content-length'] || 0);
    if (len > WEBHOOK_BODY_MAX) {
      return res.status(413).json({ error: 'Webhook body too large', code: 'PAYLOAD_TOO_LARGE' });
    }
  }
  return next();
});
// Keep the raw body so Meta webhook signatures (X-Hub-Signature-256) can be verified.
app.use(
  express.json({
    limit: '6mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
      if (
        String(req.path || '').startsWith('/api/webhooks') &&
        buf &&
        buf.length > WEBHOOK_BODY_MAX
      ) {
        const err = new Error('Webhook body too large');
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        throw err;
      }
    },
  })
);

/**
 * Rate limit mutating API routes (generous for the localhost operator model).
 * Features 190/191: RateLimit-* headers via standardHeaders.
 */
const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT_PER_MIN) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down', code: 'RATE_LIMITED' },
});
/** Tighter polish/publish budget (feature 190). */
const polishPublishLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.PUBLISH_RATE_LIMIT_PER_MIN) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many polish/publish requests', code: 'RATE_LIMITED' },
});
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return mutationLimiter(req, res, next);
});
app.use(['/api/polish', '/api/publish'], polishPublishLimiter);

// Wave-3 routes: publish history, schedule, drafts, compose helpers, ops/docs/stats.
app.use(createWave3Router());
app.use(createOpsRouter());

function isDemoMode() {
  return String(process.env.DEMO_MODE || '').toLowerCase() === 'true';
}

/**
 * Feature 116: UI_FORCE_DRY_RUN=true pins the console to dry-run — live
 * publishing is refused with 403 and the UI hides the live toggle.
 * Read at call time so tests can stub the env.
 * @returns {boolean}
 */
function isForceDryRun() {
  return String(process.env.UI_FORCE_DRY_RUN || '').toLowerCase() === 'true';
}

/**
 * Feature 82: verify Meta's X-Hub-Signature-256 HMAC over the raw body.
 * If no app secret is configured, verification is skipped with a warning
 * so local development keeps working.
 * @param {import('express').Request} req
 * @returns {{ ok: boolean, skipped?: boolean }}
 */
function verifyMetaSignature(req) {
  const secret = String(process.env.WHATSAPP_APP_SECRET || process.env.FB_APP_SECRET || '').trim();
  if (!secret) {
    logger.warn(
      'Webhook signature NOT verified — set WHATSAPP_APP_SECRET to enforce X-Hub-Signature-256'
    );
    return { ok: true, skipped: true };
  }
  const header = String(req.get('x-hub-signature-256') || '');
  if (!header.startsWith('sha256=')) return { ok: false };
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest();
  const got = Buffer.from(header.slice('sha256='.length), 'hex');
  if (got.length !== expected.length) return { ok: false };
  return { ok: crypto.timingSafeEqual(expected, got) };
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : mimeToExt(file.mimetype) || '.png';
    const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    cb(null, id);
  },
});

const MAX_UPLOAD_FILES = 4; // feature 136: up to 4 ordered images for Facebook

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME.has(file.mimetype);
    const extOk = !ext || ALLOWED_EXT.has(ext);
    if (mimeOk && extOk) return cb(null, true);
    return cb(new Error('Only JPEG, PNG, or WebP images up to 5 MB are allowed'));
  },
});

/**
 * Upload metadata sidecar (feature 126: alt text stored with the upload).
 * @param {string} name upload filename (basename, already validated)
 */
function uploadMetaPath(name) {
  return path.join(uploadsDir, `${name}.meta.json`);
}

/**
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function readUploadMeta(name) {
  try {
    return JSON.parse(fs.readFileSync(uploadMetaPath(name), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} meta
 */
function writeUploadMeta(name, meta) {
  try {
    fs.writeFileSync(uploadMetaPath(name), JSON.stringify(meta, null, 2));
  } catch (e) {
    logger.warn('Upload meta write failed', e.message || e);
  }
}

/**
 * @param {string} mime
 * @returns {string | null}
 */
function mimeToExt(mime) {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return null;
}

/**
 * Verify real file content (magic bytes), not just extension/mimetype.
 * PNG: 89 50 4E 47 · JPEG: FF D8 FF · WebP: RIFF....WEBP
 * @param {string} filePath
 * @returns {boolean}
 */
export function sniffImageMagicBytes(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const read = fs.readSync(fd, buf, 0, 12, 0);
    if (read < 3) return false;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
    if (
      read >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return true; // WebP
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Serve rendered creatives safely (path must be under output/creatives).
 */
app.get('/api/creatives/:filename', (req, res) => {
  const name = path.basename(String(req.params.filename || ''));
  if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) {
    return res.status(400).json({ error: 'Invalid creative filename' });
  }
  const filePath = path.join(creativesDir, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Creative not found' });
  }
  return res.sendFile(filePath);
});

/**
 * Serve operator uploads safely (path must be under output/uploads).
 */
app.get('/api/uploads/:filename', (req, res) => {
  const name = path.basename(String(req.params.filename || ''));
  if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) {
    return res.status(400).json({ error: 'Invalid upload filename' });
  }
  const filePath = path.join(uploadsDir, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  return res.sendFile(filePath);
});

/**
 * Multipart image upload (features 126, 136):
 * up to 4 jpeg/png/webp files (field name: image), max 5 MB each,
 * optional altText text field stored as sidecar metadata.
 */
app.post('/api/upload', (req, res) => {
  upload.array('image', MAX_UPLOAD_FILES)(req, res, (err) => {
    if (err) {
      let msg = err.message || String(err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') msg = 'Image must be 5 MB or smaller';
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          msg = `Up to ${MAX_UPLOAD_FILES} images allowed per upload`;
        }
      }
      return res.status(400).json({ error: msg });
    }
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'image file is required (field name: image)' });
    }
    // Content sniffing: reject the whole batch if any file's bytes aren't a real image.
    const bad = files.find((f) => !sniffImageMagicBytes(f.path));
    if (bad) {
      for (const f of files) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          /* already gone */
        }
      }
      return res
        .status(400)
        .json({ error: 'File content is not a valid PNG, JPEG, or WebP image' });
    }

    // Feature 193: purge oldest uploads when over cap.
    const uploadCap = Number(process.env.UPLOADS_MAX_BYTES) || 200 * 1024 * 1024;
    const purge = purgeUploadsToCap(uploadsDir, uploadCap);

    const altText = String(req.body?.altText || '')
      .trim()
      .slice(0, 500);
    const uploads = files.map((f) => {
      const meta = {
        uploadId: f.filename,
        originalName: f.originalname || null,
        mime: f.mimetype,
        size: f.size,
        altText: altText || null,
        ts: new Date().toISOString(),
      };
      writeUploadMeta(f.filename, meta);
      return {
        uploadId: f.filename,
        url: `/api/uploads/${encodeURIComponent(f.filename)}`,
        mime: f.mimetype,
        size: f.size,
        altText: meta.altText,
      };
    });

    logger.info('UI upload saved', { count: uploads.length, first: uploads[0].uploadId });
    return res.json({
      ok: true,
      // Back-compat single-file fields (first file)
      uploadId: uploads[0].uploadId,
      url: uploads[0].url,
      mime: uploads[0].mime,
      size: uploads[0].size,
      altText: uploads[0].altText,
      uploads,
      reclaimedBytes: purge.reclaimed,
    });
  });
});

/** Feature 126: upload metadata (alt text) round-trip. */
app.get('/api/uploads/:filename/meta', (req, res) => {
  const name = path.basename(String(req.params.filename || ''));
  if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) {
    return res.status(400).json({ error: 'Invalid upload filename' });
  }
  if (!fs.existsSync(path.join(uploadsDir, name))) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  return res.json({ ok: true, meta: readUploadMeta(name) });
});

app.put('/api/uploads/:filename/meta', (req, res) => {
  const name = path.basename(String(req.params.filename || ''));
  if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) {
    return res.status(400).json({ error: 'Invalid upload filename' });
  }
  if (!fs.existsSync(path.join(uploadsDir, name))) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  const meta = readUploadMeta(name);
  meta.altText =
    String(req.body?.altText || '')
      .trim()
      .slice(0, 500) || null;
  writeUploadMeta(name, meta);
  return res.json({ ok: true, meta });
});

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizePlatforms(list) {
  const raw = Array.isArray(list) ? list : [];
  const candidates = raw
    .map((p) =>
      String(p || '')
        .trim()
        .toLowerCase()
    )
    .filter((p) => ALLOWED.has(p));
  return filterEnabledPlatforms(candidates);
}

/**
 * Credential readiness without leaking secrets.
 * @returns {Record<string, { enabled: boolean, configured: boolean }>}
 */
function platformStatus() {
  const pe = config.platformEnabled;
  return {
    facebook: {
      enabled: pe.facebook !== false,
      configured: Boolean(config.facebook.pageId && config.facebook.pageToken),
    },
    twitter: {
      enabled: pe.twitter !== false,
      configured: hasTwitterConfig(),
    },
    linkedin: {
      enabled: pe.linkedin !== false,
      configured: Boolean(config.linkedin.accessToken && config.linkedin.authorUrn),
    },
    youtube: {
      enabled: pe.youtube !== false,
      configured: Boolean(
        config.youtube.clientId &&
        config.youtube.clientSecret &&
        config.youtube.refreshToken &&
        config.youtube.videoId
      ),
    },
    whatsapp: {
      enabled: pe.whatsapp !== false,
      configured: Boolean(
        config.whatsapp.accessToken && config.whatsapp.phoneNumberId && config.whatsapp.to
      ),
    },
  };
}

/**
 * Relative URL for UI preview of a PNG under output/creatives.
 * @param {string | null} absPath
 * @returns {string | null}
 */
function creativePreviewUrl(absPath) {
  if (!absPath) return null;
  const name = path.basename(absPath);
  return `/api/creatives/${encodeURIComponent(name)}`;
}

/**
 * Relative URL for an upload under output/uploads.
 * @param {string | null} absPath
 * @returns {string | null}
 */
function uploadPreviewUrl(absPath) {
  if (!absPath) return null;
  const name = path.basename(absPath);
  return `/api/uploads/${encodeURIComponent(name)}`;
}

/**
 * Resolve an uploadId to an absolute path under output/uploads.
 * @param {unknown} uploadId
 * @returns {string | null}
 */
function resolveUploadPath(uploadId) {
  if (!uploadId) return null;
  const name = path.basename(String(uploadId));
  if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) return null;
  const filePath = path.resolve(path.join(uploadsDir, name));
  if (!filePath.startsWith(path.resolve(uploadsDir))) return null;
  if (!fs.existsSync(filePath)) return null;
  return filePath;
}

/**
 * Resolve a creative or upload image path for Facebook visual publish.
 * Accepts absolute paths under creatives/uploads, or uploadId / basename.
 * @param {{ imagePath?: unknown, uploadId?: unknown, creativePath?: unknown }} source
 * @returns {{ absPath: string | null, source: 'upload' | 'creative' | null }}
 */
function resolveImageForFacebook(source) {
  const uploadFromId = resolveUploadPath(source.uploadId);
  if (uploadFromId) return { absPath: uploadFromId, source: 'upload' };

  const candidates = [source.imagePath, source.creativePath].filter(Boolean);
  for (const raw of candidates) {
    const asUpload = resolveUploadPath(raw);
    if (asUpload) return { absPath: asUpload, source: 'upload' };

    const name = path.basename(String(raw));
    if (!name || !/\.(png|jpe?g|webp)$/i.test(name)) continue;

    const creativeCandidate = path.resolve(path.join(creativesDir, name));
    if (
      creativeCandidate.startsWith(path.resolve(creativesDir)) &&
      fs.existsSync(creativeCandidate)
    ) {
      return { absPath: creativeCandidate, source: 'creative' };
    }

    const resolved = path.resolve(String(raw));
    if (resolved.startsWith(path.resolve(uploadsDir)) && fs.existsSync(resolved)) {
      return { absPath: resolved, source: 'upload' };
    }
    if (resolved.startsWith(path.resolve(creativesDir)) && fs.existsSync(resolved)) {
      return { absPath: resolved, source: 'creative' };
    }
  }

  return { absPath: null, source: null };
}

app.get('/api/health', async (req, res) => {
  let ollama = {
    ok: false,
    url: config.ollama.url,
    model: config.ollama.model,
    error: null,
    timeoutMs: OLLAMA_TIMEOUT_MS,
    circuit: ollamaBreaker.snapshot(),
  };
  try {
    await assertOllamaReady();
    ollama = { ...ollama, ok: true, error: null };
  } catch (e) {
    ollama.error = e.message || String(e);
  }

  const brief = assertBrandBrief();
  const diskFree = freeDiskBytes();
  const rss = checkRssWatchdog();
  const paused = isPaused();
  const status = computeHealthStatus({
    ollamaOk: ollama.ok,
    paused,
    diskFreeBytes: diskFree,
  });
  const settings = loadSettings();
  const flags = loadFeatureFlags();
  const armed = {
    autoReply: isAutoReplyEnabled(),
    queue: isQueueArmed(),
    forceDryRun: isForceDryRun(),
    paused,
    demoMode: isDemoMode(),
  };

  const body = {
    ok: status !== 'down',
    status,
    version: API_VERSION,
    requestId: req.requestId,
    uptimeSeconds: Math.floor(process.uptime()),
    bootAt: bootIso(),
    brand: config.brand.name,
    brandBriefOk: brief.ok,
    brandBriefError: brief.ok ? null : brief.error,
    facebookPostMode: config.facebook.postMode,
    dryRunDefault: config.dryRun,
    forceDryRun: isForceDryRun(),
    queueArmed: isQueueArmed(),
    paused,
    demoMode: isDemoMode(),
    armed,
    featureFlags: flags,
    staleEnv: staleEnvFlag(),
    diskFreeBytes: diskFree,
    rssBytes: rss,
    retryCounts: getRetryCounts(),
    healthHistory: getHealthHistory(),
    creative: { templates: CREATIVE_TEMPLATES, themes: Object.keys(CREATIVE_THEMES) },
    utm: loadUtmSettings(),
    ollama,
    platforms: platformStatus(),
    autoReply: {
      enabled: isAutoReplyEnabled(),
      ruleCount: loadRules().length,
      matchMode: settings.matchMode,
      maxRepliesPerHour: settings.maxRepliesPerHour,
      verifyTokenConfigured: Boolean(String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim()),
    },
  };
  pushHealthSnapshot({ status, ollamaOk: ollama.ok, paused });
  res.json(body);
});

/* —— Auto-reply —— */

app.get('/api/auto-reply/rules', (_req, res) => {
  res.json({
    ok: true,
    rules: loadRules(),
    settings: loadSettings(),
    autoReplyEnabled: isAutoReplyEnabled(),
  });
});

app.put('/api/auto-reply/rules', async (req, res) => {
  try {
    const body = req.body || {};
    const list = Array.isArray(body) ? body : body.rules;
    // Feature 228: serialize concurrent settings/rules PUTs.
    const saved = await withWriteLock('auto_reply_rules', () => saveRules(list || []));
    if (body.settings && typeof body.settings === 'object') {
      await withWriteLock('auto_reply_settings', () =>
        saveSettings({ ...loadSettings(), ...body.settings })
      );
    }
    return res.json({ ok: true, rules: saved, settings: loadSettings() });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

app.get('/api/auto-reply/settings', (_req, res) => {
  res.json({ ok: true, settings: loadSettings(), autoReplyEnabled: isAutoReplyEnabled() });
});

app.put('/api/auto-reply/settings', async (req, res) => {
  try {
    const saved = await withWriteLock('auto_reply_settings', () =>
      saveSettings({ ...loadSettings(), ...(req.body || {}) })
    );
    return res.json({ ok: true, settings: saved });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/api/auto-reply/test', async (req, res) => {
  try {
    const text = String(req.body?.text || '');
    const dryRun = req.body?.dryRun !== false; // default true — never send unless explicit
    const platform = String(req.body?.platform || 'whatsapp').toLowerCase();
    const scope = String(req.body?.scope || 'any').toLowerCase();
    const from = String(req.body?.from || 'test-operator').trim() || 'test-operator';

    if (dryRun) {
      const matches = matchRules(text, { platform, scope });
      return res.json({
        ok: true,
        dryRun: true,
        autoReplyEnabled: isAutoReplyEnabled(),
        matches: matches.map((h) => ({
          ruleId: h.rule.id,
          name: h.rule.name,
          reply: h.reply,
          match: h.match,
          sent: false,
        })),
      });
    }

    // Non-dry only when AUTO_REPLY_ENABLED — still operator-triggered
    const result = await processInbound(
      { text, platform, from, scope: scope === 'group', isGroup: scope === 'group', dryRun: false },
      {
        sendReply: async ({ to, text: replyText }) => {
          if (!isAutoReplyEnabled()) {
            throw new Error('AUTO_REPLY_ENABLED is false');
          }
          if (platform === 'whatsapp') {
            return postToWhatsApp(replyText, { to });
          }
          throw new Error('Live Facebook auto-reply send is not wired in v1 (use dry-run)');
        },
      }
    );
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

app.post('/api/auto-reply/keyword-to-regex', (req, res) => {
  const keywords = String(req.body?.keywords || '');
  const caseInsensitive = req.body?.caseInsensitive !== false;
  const out = keywordToRegex(keywords, { caseInsensitive });
  return res.json({ ok: true, ...out });
});

app.get('/api/auto-reply/log', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ok: true, entries: readMatchLog(limit) });
});

/** Feature 94: match log as CSV download. */
app.get('/api/auto-reply/log.csv', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const csv = matchLogToCsv(readMatchLog(limit));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="auto-reply-log.csv"');
  res.send(csv);
});

/** Feature 85: engine counters + queue depths. */
app.get('/api/auto-reply/stats', (_req, res) => {
  res.json({
    ok: true,
    stats: getStats(),
    dlqRecent: readDlq(10).length,
    approvalsPending: listApprovals().filter((a) => a.status === 'pending').length,
    followUpsPending: listFollowUps().length,
    autoReplyEnabled: isAutoReplyEnabled(),
    platformFlags: {
      whatsapp: platformAutoReplyEnabled('whatsapp'),
      facebook: platformAutoReplyEnabled('facebook'),
    },
  });
});

/** Feature 84: dead-letter queue of failed sends. */
app.get('/api/auto-reply/dlq', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ok: true, entries: readDlq(limit) });
});

/** Feature 87: bulk enable/disable rules by id. */
app.post('/api/auto-reply/rules/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const enabled = req.body?.enabled === true;
    if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
    const saved = await withWriteLock('auto_reply_rules', () => {
      const rules = loadRules();
      let changed = 0;
      for (const rule of rules) {
        if (ids.includes(rule.id) && rule.enabled !== enabled) {
          rule.enabled = enabled;
          changed++;
        }
      }
      return { rules: saveRules(rules), changed };
    });
    return res.json({ ok: true, changed: saved.changed, rules: saved.rules });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

/** Feature 88: diff a proposed import against saved rules before committing. */
app.post('/api/auto-reply/rules/diff', (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : body.rules;
  const d = diffRules(list || []);
  if (!d.ok) return res.status(400).json({ error: d.error });
  return res.json(d);
});

/** Feature 95: list rules snapshots taken on each save. */
app.get('/api/auto-reply/history', (_req, res) => {
  res.json({ ok: true, snapshots: listRuleSnapshots() });
});

/** Feature 89: explain a regex — group count, named groups, sample match. */
app.post('/api/auto-reply/explain', (req, res) => {
  const out = explainPattern(
    String(req.body?.pattern || ''),
    String(req.body?.flags || ''),
    String(req.body?.sampleText || '')
  );
  if (!out.ok) return res.status(400).json({ error: out.error });
  return res.json(out);
});

/** Feature 76: human takeover — pause auto-reply per chat. */
app.get('/api/auto-reply/takeover', (_req, res) => {
  res.json({ ok: true, takeovers: loadTakeovers() });
});

app.post('/api/auto-reply/takeover', (req, res) => {
  try {
    const platform = String(req.body?.platform || 'whatsapp').toLowerCase();
    const from = String(req.body?.from || '').trim();
    if (!from) return res.status(400).json({ error: 'from is required' });
    const active = req.body?.active !== false;
    const takeovers = setTakeover(platform, from, active);
    return res.json({ ok: true, takeovers });
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

/** Feature 92: approval queue for outbound replies. */
app.get('/api/auto-reply/approvals', (_req, res) => {
  res.json({ ok: true, approvals: listApprovals().slice().reverse() });
});

app.post('/api/auto-reply/approvals/:id', async (req, res) => {
  const action = String(req.body?.action || '').toLowerCase();
  if (action !== 'approve' && action !== 'reject') {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }
  const result = await resolveApproval(String(req.params.id), action, {
    sendReply: async ({ platform, to, text }) => {
      if (platform === 'whatsapp') return postToWhatsApp(text, { to });
      if (platform === 'facebook') return sendMessengerReply(to, text);
      throw new Error(`No sender for platform: ${platform}`);
    },
  });
  if (!result.ok) return res.status(400).json({ error: result.error, entry: result.entry || null });
  return res.json(result);
});

/** Feature 75: pending follow-ups + manual tick (dry-run by default). */
app.get('/api/auto-reply/followups', (_req, res) => {
  res.json({ ok: true, followUps: listFollowUps() });
});

app.post('/api/auto-reply/followups/run', async (req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const results = await processFollowUps({
    dryRun,
    sendReply: async ({ platform, to, text }) => {
      if (platform === 'whatsapp') return postToWhatsApp(text, { to });
      if (platform === 'facebook') return sendMessengerReply(to, text);
      throw new Error(`No sender for platform: ${platform}`);
    },
  });
  res.json({ ok: true, dryRun, processed: results });
});

/** Feature 100: chaos/webhook simulator — replay a sample inbox (always dry-run). */
app.post('/api/auto-reply/simulate', async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'messages array is required' });
    const out = await simulateInbox(messages);
    return res.json(out);
  } catch (e) {
    return res.status(400).json({ error: e.message || String(e) });
  }
});

/**
 * Meta-style WhatsApp webhook verification (hub.challenge).
 */
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const expected = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();

  if (mode === 'subscribe' && expected && token === expected) {
    logger.info('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('WhatsApp webhook verify failed');
  return res.status(403).json({ error: 'Verification failed' });
});

/**
 * Inbound WhatsApp messages → match rules → optional auto-send.
 */
app.post('/api/webhooks/whatsapp', async (req, res) => {
  // Feature 82: reject payloads with a bad X-Hub-Signature-256 before processing.
  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    logger.warn('WhatsApp webhook rejected: bad X-Hub-Signature-256');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Always 200 quickly for Meta retries; process async-ish but await for localhost ops
  try {
    const body = req.body || {};

    // Feature 178: malformed → quarantine, still 200.
    if (isMalformedWebhook(body, 'whatsapp')) {
      quarantineWebhook({ reason: 'malformed_envelope', source: 'whatsapp', body });
      return res.status(200).json({ ok: true, quarantined: true, reason: 'malformed_envelope' });
    }

    // Feature 214: stale timestamps → quarantine.
    const freshness = checkWebhookFreshness(body);
    if (!freshness.fresh) {
      quarantineWebhook({
        reason: 'stale_timestamp',
        source: 'whatsapp',
        body,
        meta: { ageMs: freshness.ageMs, timestampMs: freshness.timestampMs },
      });
      return res.status(200).json({ ok: true, quarantined: true, reason: 'stale_timestamp' });
    }

    const entries = body.entry || [];
    /** @type {object[]} */
    const processed = [];

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        for (const msg of messages) {
          const from = String(msg.from || '');
          if (!from) continue;

          // Feature 79: media messages are logged (not dropped silently, never crash).
          const text = msg.text?.body || '';
          if (!text && (!msg.type || msg.type === 'text')) continue;

          const dryRun = !isAutoReplyEnabled();
          const result = await processInbound(
            {
              text,
              platform: 'whatsapp',
              from,
              isGroup: false,
              dryRun,
              messageId: msg.id || null, // feature 83: idempotency
              type: msg.type || 'text',
            },
            {
              sendReply: async ({ to, text: replyText }) => postToWhatsApp(replyText, { to }),
            }
          );
          processed.push({ from, text: text.slice(0, 120), ...result });
        }
      }
    }

    // Empty payloads (status updates) still OK
    logger.info('WhatsApp webhook POST', { processed: processed.length });
    return res.status(200).json({ ok: true, processed });
  } catch (e) {
    logger.error('WhatsApp webhook error', e.message || e);
    quarantineWebhook({
      reason: 'handler_error',
      source: 'whatsapp',
      body: req.body,
      meta: { error: e.message || String(e) },
    });
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * Facebook Page webhook stub — verify + log; Messenger send not wired.
 */
app.get('/api/webhooks/facebook', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const expected = String(
    process.env.WHATSAPP_VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || ''
  ).trim();
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Verification failed' });
});

app.post('/api/webhooks/facebook', async (req, res) => {
  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    logger.warn('Facebook webhook rejected: bad X-Hub-Signature-256');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  try {
    const body = req.body || {};

    if (isMalformedWebhook(body, 'facebook')) {
      quarantineWebhook({ reason: 'malformed_envelope', source: 'facebook', body });
      return res.status(200).json({ ok: true, quarantined: true, reason: 'malformed_envelope' });
    }

    const freshness = checkWebhookFreshness(body);
    if (!freshness.fresh) {
      quarantineWebhook({
        reason: 'stale_timestamp',
        source: 'facebook',
        body,
        meta: { ageMs: freshness.ageMs, timestampMs: freshness.timestampMs },
      });
      return res.status(200).json({ ok: true, quarantined: true, reason: 'stale_timestamp' });
    }

    // Feature 81: Messenger Send API is wired only when armed + configured.
    const canSend =
      isAutoReplyEnabled() &&
      platformAutoReplyEnabled('facebook') &&
      Boolean(config.facebook.pageId && config.facebook.pageToken);

    logger.info('Facebook webhook POST', {
      object: body.object,
      entries: Array.isArray(body.entry) ? body.entry.length : 0,
      canSend,
    });

    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const text = event.message?.text;
        const from = event.sender?.id;
        if (!text || !from) continue;
        await processInbound(
          {
            text,
            platform: 'facebook',
            from,
            isGroup: false,
            dryRun: !canSend,
            messageId: event.message?.mid || null,
          },
          canSend
            ? { sendReply: async ({ to, text: replyText }) => sendMessengerReply(to, replyText) }
            : {}
        );
      }
    }
    return res.status(200).json({ ok: true, dryRun: !canSend });
  } catch (e) {
    logger.error('Facebook webhook error', e.message || e);
    quarantineWebhook({
      reason: 'handler_error',
      source: 'facebook',
      body: req.body,
      meta: { error: e.message || String(e) },
    });
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
});

/**
 * Feature 112/113: rewrite airepro.in links with UTM parameters when the
 * stored UTM settings are enabled. Applied at polish time, per platform.
 * @param {string} text
 * @param {string} platform
 * @returns {string}
 */
function utmize(text, platform) {
  if (!text) return text;
  // Feature 134: expand airepro.in/go/<slug> shortcuts before UTM tagging.
  let out = text;
  try {
    out = expandLinkSlugs(out, loadLinkSlugs());
  } catch {
    /* slug config unreadable — leave text as-is */
  }
  const settings = loadUtmSettings();
  if (!settings.enabled || !settings.campaign) return out;
  return applyUtm(out, { platform, campaign: settings.campaign, enabled: true });
}

/**
 * Render the Facebook creative plus one alternate-theme variant (feature 125).
 * @param {object} fields creative fields from the pack
 * @param {{ template?: string, theme?: string }} styleIn
 * @returns {Promise<{ imagePath: string, variants: Array<{ path: string, url: string | null, theme: string, template: string }> }>}
 */
async function renderCreativeVariants(fields, styleIn) {
  const style = resolveCreativeStyle(styleIn);
  const altTheme = style.theme === 'violet' ? 'magenta' : 'violet';
  const base = {
    headline: fields.headline,
    accentWord: fields.accentWord,
    subhead: fields.subhead,
    body: fields.body,
    ctaLabel: fields.ctaLabel,
    ctaUrl: config.brand.internshipsUrl,
    template: style.template,
  };
  const primaryPath = await renderCreativePng({ ...base, theme: style.theme });
  /** @type {Array<{ path: string, url: string | null, theme: string, template: string }>} */
  const variants = [
    {
      path: primaryPath,
      url: creativePreviewUrl(primaryPath),
      theme: style.theme,
      template: style.template,
    },
  ];
  try {
    const altPath = await renderCreativePng({ ...base, theme: altTheme });
    variants.push({
      path: altPath,
      url: creativePreviewUrl(altPath),
      theme: altTheme,
      template: style.template,
    });
  } catch (e) {
    // Variant B is best-effort — a failed alternate render never fails polish.
    logger.warn('Creative variant render failed', e.message || e);
  }
  return { imagePath: primaryPath, variants };
}

app.post('/api/polish', async (req, res) => {
  inFlightMutations += 1;
  try {
    const brief = assertBrandBrief();
    if (!brief.ok) {
      return sendError(res, req, 400, brief.error, 'VALIDATION');
    }
    const topic = String(req.body?.topic || '').trim();
    const notes = String(req.body?.notes || '').trim();
    if (!topic) {
      return sendError(res, req, 400, 'topic is required', 'VALIDATION');
    }

    const tone =
      String(req.body?.tone || '')
        .trim()
        .toLowerCase() || undefined;
    const language =
      String(req.body?.language || '')
        .trim()
        .toLowerCase() || undefined;
    const length =
      String(req.body?.length || '')
        .trim()
        .toLowerCase() || undefined;
    const uploadResolved = resolveUploadPath(req.body?.uploadId);
    const angle = notes ? `${topic}\n\nOperator notes: ${notes}` : topic;
    const facebookVisual = config.facebook.postMode === 'visual';
    const creativeStyle = {
      template: req.body?.creativeTemplate,
      theme: req.body?.creativeTheme,
    };

    // Feature 108: regenerate a single platform without touching other cards.
    const only = String(req.body?.only || '')
      .trim()
      .toLowerCase();
    if (only) {
      if (!ALLOWED.has(only)) {
        return res.status(400).json({ error: `Unknown platform: ${only}` });
      }
      if (!normalizePlatforms([only]).length) {
        return res.status(400).json({ error: `Platform is disabled: ${only}` });
      }

      logger.info('UI polish (single platform)', { platform: only, tone: tone || 'neutral' });

      /** @type {Record<string, unknown>} */
      const posts = {};
      if (only === 'youtube') {
        const raw = await generatePost(angle, { platform: 'youtube', tone });
        const titleLine = raw.match(/TITLE:\s*(.+)/i);
        const descLine = raw.match(/DESCRIPTION:\s*([\s\S]+)/i);
        const title = (titleLine ? titleLine[1].trim() : topic).slice(0, 100);
        const description = utmize(descLine ? descLine[1].trim() : raw.trim(), 'youtube');
        posts.youtube = {
          title,
          description,
          /** Feature 124: editable tag suggestions derived from the description. */
          tags: suggestYoutubeTags(description, topic),
          text: [title, description].filter(Boolean).join('\n\n'),
        };
      } else if (only === 'facebook' && facebookVisual) {
        const creative = await generateFacebookCreative(angle, { tone });
        let imagePath = null;
        let imageSource = null;
        let imageUrl = null;
        let creativeVariants = [];
        if (uploadResolved) {
          imagePath = uploadResolved;
          imageSource = 'upload';
          imageUrl = uploadPreviewUrl(uploadResolved);
        } else {
          const rendered = await renderCreativeVariants(creative, creativeStyle);
          imagePath = rendered.imagePath;
          imageSource = 'creative';
          imageUrl = creativePreviewUrl(imagePath);
          creativeVariants = rendered.variants;
        }
        posts.facebook = {
          text: utmize(creative.caption, 'facebook'),
          mode: config.facebook.postMode,
          creative,
          creativePath: imageSource === 'creative' ? imagePath : null,
          uploadId: imageSource === 'upload' ? path.basename(imagePath) : null,
          imagePath,
          imageSource,
          creativeUrl: imageUrl,
          imageUrl,
          creativeVariants,
        };
      } else {
        const raw = await generatePost(angle, { platform: only, tone });
        let text = raw.trim();
        if (only === 'twitter') {
          text = text.replace(/\s+/g, ' ').trim();
          const max = config.twitter.maxChars || 280;
          if (text.length > max) text = `${text.slice(0, max - 1)}…`;
        }
        posts[only] = { text: utmize(text, only) };
        if (only === 'facebook') {
          posts.facebook.mode = config.facebook.postMode;
        }
      }

      return res.json({ ok: true, topic, notes: notes || null, only, posts });
    }

    const selected = normalizePlatforms(req.body?.platforms);
    if (!selected.length) {
      return res.status(400).json({
        error: 'Select at least one enabled platform',
        platforms: platformStatus(),
      });
    }

    logger.info('UI polish', {
      brand: config.brand.name,
      platforms: selected,
      facebookPostMode: config.facebook.postMode,
      hasUpload: Boolean(uploadResolved),
      tone: tone || 'neutral',
    });

    let pack;
    const facebookOnly = selected.length === 1 && selected[0] === 'facebook';
    if (facebookOnly && facebookVisual) {
      const creative = await ollamaBreaker.exec(() => generateFacebookCreative(angle, { tone }));
      pack = {
        facebook: creative.caption,
        twitter: '',
        linkedin: '',
        linkedinComment: '',
        youtubeTitle: '',
        youtubeDescription: '',
        whatsapp: '',
        facebookCreative: creative,
      };
    } else {
      try {
        pack = await ollamaBreaker.exec(() =>
          generateMultiPlatformPack(angle, { tone, language, length })
        );
      } catch (e) {
        if (e?.code === 'OLLAMA_CIRCUIT_OPEN') {
          return res.status(503).json(
            errorEnvelope({
              error: e.message,
              code: 'OLLAMA_CIRCUIT_OPEN',
              requestId: req.requestId,
              details: { retryAfterMs: e.retryAfterMs, circuit: ollamaBreaker.snapshot() },
            })
          );
        }
        throw e;
      }
    }

    /** @type {string | null} */
    let imagePath = null;
    /** @type {'upload' | 'creative' | null} */
    let imageSource = null;
    /** @type {string | null} */
    let imageUrl = null;
    /** @type {Array<{ path: string, url: string | null, theme: string, template: string }>} */
    let creativeVariants = [];

    if (selected.includes('facebook') && facebookVisual) {
      if (uploadResolved) {
        imagePath = uploadResolved;
        imageSource = 'upload';
        imageUrl = uploadPreviewUrl(uploadResolved);
      } else {
        const fields = pack.facebookCreative || defaultFacebookCreative(angle);
        const rendered = await renderCreativeVariants(fields, creativeStyle);
        imagePath = rendered.imagePath;
        creativeVariants = rendered.variants;
        imageSource = 'creative';
        imageUrl = creativePreviewUrl(imagePath);
      }
    }

    /** @type {Record<string, unknown>} */
    const posts = {};
    if (selected.includes('facebook')) {
      posts.facebook = {
        text: utmize(pack.facebook, 'facebook'),
        mode: config.facebook.postMode,
        creative: pack.facebookCreative || null,
        creativePath: imageSource === 'creative' ? imagePath : null,
        uploadId: imageSource === 'upload' ? path.basename(imagePath) : null,
        imagePath: imagePath || null,
        imageSource,
        creativeUrl: imageUrl,
        imageUrl,
        creativeVariants,
      };
    }
    if (selected.includes('twitter')) {
      posts.twitter = { text: utmize(pack.twitter, 'twitter') };
    }
    if (selected.includes('linkedin')) {
      posts.linkedin = {
        text: utmize(pack.linkedin, 'linkedin'),
        /** Feature 119: suggested first comment — copy-only, never auto-posted. */
        firstComment: utmize(pack.linkedinComment || '', 'linkedin'),
      };
    }
    if (selected.includes('youtube')) {
      const description = utmize(pack.youtubeDescription, 'youtube');
      posts.youtube = {
        title: pack.youtubeTitle,
        description,
        /** Feature 124: editable tag suggestions derived from the description. */
        tags: suggestYoutubeTags(description, topic),
        text: [pack.youtubeTitle, description].filter(Boolean).join('\n\n'),
      };
    }
    if (selected.includes('whatsapp')) {
      posts.whatsapp = { text: utmize(pack.whatsapp, 'whatsapp') };
    }

    return res.json({
      ok: true,
      topic,
      notes: notes || null,
      tone: tone || null,
      brand: config.brand.name,
      platforms: selected,
      uploadId: uploadResolved ? path.basename(uploadResolved) : null,
      posts,
    });
  } catch (e) {
    logger.error('UI polish failed', e.message || e);
    if (!res.headersSent) {
      return res.status(500).json(
        errorEnvelope({
          error: e.message || String(e),
          code: 'INTERNAL',
          requestId: req.requestId,
        })
      );
    }
  } finally {
    inFlightMutations = Math.max(0, inFlightMutations - 1);
  }
});

/**
 * @param {string} name
 * @param {() => Promise<string>} fn
 * @returns {Promise<{ platform: string, ok: boolean, id?: string, error?: string, dryRun?: boolean }>}
 */
async function publishOne(name, fn) {
  try {
    const id = await fn();
    return { platform: name, ok: true, id };
  } catch (e) {
    return { platform: name, ok: false, error: e.message || String(e) };
  }
}

app.post('/api/publish', async (req, res) => {
  inFlightMutations += 1;
  try {
    if (isDemoMode()) {
      return sendError(res, req, 403, 'DEMO_MODE disables publish', 'DEMO');
    }
    // Feature 205: panic pause.
    if (isPaused()) {
      return res.status(503).json(
        errorEnvelope({
          error: 'Outbound paused — POST /api/ops/resume to continue',
          code: 'PAUSED',
          requestId: req.requestId,
        })
      );
    }
    // Feature 116: pinned dry-run refuses any live publish attempt.
    if (isForceDryRun() && req.body?.dryRun === false) {
      return sendError(
        res,
        req,
        403,
        'Dry-run is pinned (UI_FORCE_DRY_RUN=true) — live publishing is disabled on this console',
        'FORBIDDEN'
      );
    }

    // Feature 203: idempotency key dedupe (10 minutes).
    const idem = String(req.body?.idempotencyKey || '').trim();
    if (idem) {
      const hit = idempotencyCache.get(idem);
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
        return res.json({ ...hit.body, idempotentReplay: true, requestId: req.requestId });
      }
    }

    const globalDryRun = Boolean(req.body?.dryRun) || config.dryRun || isForceDryRun();
    // Feature 204: concurrency lock for live publishes.
    if (!globalDryRun) {
      if (livePublishInFlight) {
        return sendError(res, req, 409, 'Another live publish is in flight', 'PUBLISH_LOCKED');
      }
      livePublishInFlight = true;
    }

    const selected = normalizePlatforms(req.body?.platforms);
    if (!selected.length) {
      return res.status(400).json(
        errorEnvelope({
          error: 'Select at least one enabled platform',
          code: 'VALIDATION',
          requestId: req.requestId,
          details: { platforms: platformStatus() },
        })
      );
    }

    /**
     * Feature 148: per-platform dry-run — when the request is live overall,
     * platforms flagged true here are still simulated.
     * @type {Record<string, unknown>}
     */
    const dryRunByPlatform =
      req.body?.dryRunByPlatform && typeof req.body.dryRunByPlatform === 'object'
        ? req.body.dryRunByPlatform
        : {};
    const effDry = (p) => globalDryRun || dryRunByPlatform[p] === true;

    const postsIn = req.body?.posts && typeof req.body.posts === 'object' ? req.body.posts : {};
    const facebookVisual = config.facebook.postMode === 'visual';

    const fbIn = postsIn.facebook || {};
    const twIn = postsIn.twitter || {};
    const liIn = postsIn.linkedin || {};
    const ytIn = postsIn.youtube || {};
    const waIn = postsIn.whatsapp || {};

    const facebookText = String(fbIn.text || '').trim();
    const twitterText = String(twIn.text || '').trim();
    const linkedinText = String(liIn.text || '').trim();
    const youtubeTitle = String(ytIn.title || '').trim();
    const youtubeDescription = String(ytIn.description || '').trim();
    const youtubeTags = capYoutubeTags(ytIn.tags || '');
    const whatsappText = String(waIn.text || '').trim();

    // Feature 120: WhatsApp template flag — template sends need a template name.
    const whatsappMessageType = String(waIn.messageType || 'freeform').toLowerCase();
    const whatsappTemplateName = String(waIn.templateName || '').trim();
    if (
      selected.includes('whatsapp') &&
      whatsappMessageType === 'template' &&
      !whatsappTemplateName
    ) {
      return res.status(400).json({
        error: 'WhatsApp template messages require templateName (or switch the draft to freeform)',
      });
    }

    let { absPath: imagePath, source: imageSource } = resolveImageForFacebook({
      uploadId: req.body?.uploadId || fbIn.uploadId,
      imagePath: fbIn.imagePath || req.body?.imagePath,
      creativePath: fbIn.creativePath,
    });

    // Feature 136: ordered multi-image uploads for Facebook.
    /** @type {string[]} */
    const imagePaths = [];
    if (Array.isArray(fbIn.uploadIds)) {
      for (const id of fbIn.uploadIds.slice(0, MAX_UPLOAD_FILES)) {
        const p = resolveUploadPath(id);
        if (p) imagePaths.push(p);
      }
    }
    if (!imagePath && imagePaths.length) {
      imagePath = imagePaths[0];
      imageSource = 'upload';
    }

    // Feature 126: alt text from the draft or the upload's stored metadata.
    let facebookAltText = String(fbIn.altText || '').trim();
    if (!facebookAltText && imageSource === 'upload' && imagePath) {
      facebookAltText = String(readUploadMeta(path.basename(imagePath)).altText || '');
    }
    // Feature 160: Graph scheduled_publish_time (unix seconds); dry-run echoes, live when armed.
    const scheduledPublishTimeRaw = fbIn.scheduledPublishTime ?? req.body?.scheduledPublishTime;
    const scheduledPublishTime =
      scheduledPublishTimeRaw != null && Number(scheduledPublishTimeRaw) > 0
        ? Math.floor(Number(scheduledPublishTimeRaw))
        : null;

    // Re-render if visual FB selected, no valid path, but creative fields present
    if (selected.includes('facebook') && facebookVisual && !imagePath) {
      const creative =
        fbIn.creative && typeof fbIn.creative === 'object'
          ? fbIn.creative
          : defaultFacebookCreative(facebookText || 'Airepro');
      imagePath = await renderCreativePng({
        headline: creative.headline,
        accentWord: creative.accentWord,
        subhead: creative.subhead,
        body: creative.body,
        ctaLabel: creative.ctaLabel,
        ctaUrl: config.brand.internshipsUrl,
        template: fbIn.creativeTemplate,
        theme: fbIn.creativeTheme,
      });
      imageSource = 'creative';
    }

    const previewUrl =
      imageSource === 'upload' ? uploadPreviewUrl(imagePath) : creativePreviewUrl(imagePath);

    logger.info('UI publish', {
      platforms: selected,
      dryRun: globalDryRun,
      mixed: selected.some((p) => effDry(p)) && selected.some((p) => !effDry(p)),
      facebookPostMode: config.facebook.postMode,
      imageSource,
    });

    /** @type {Array<Record<string, unknown>>} */
    const results = [];

    for (const p of selected) {
      const dry = effDry(p);

      if (dry) {
        if (p === 'facebook') {
          const payload = facebookVisual
            ? buildFacebookPhotoPayload(facebookText, {
                altText: facebookAltText,
                scheduledPublishTime,
                filename: imagePath ? path.basename(imagePath) : 'image.png',
              })
            : buildFacebookFeedPayload(facebookText, {
                scheduledPublishTime,
                pageToken: '[redacted]',
              });
          results.push({
            platform: 'facebook',
            ok: Boolean(facebookText),
            dryRun: true,
            id: `dry-fb-${Date.now().toString(36)}`,
            permalink: null,
            preview: facebookText.slice(0, 200),
            payload,
            imagePath: imagePath || null,
            imagePaths: imagePaths.length ? imagePaths : undefined,
            imageSource: imageSource || null,
            creativePath: imageSource === 'creative' ? imagePath : null,
            altText: facebookAltText || null,
            scheduledPublishTime,
            ...(facebookText ? {} : { error: 'Missing Facebook text' }),
          });
        } else if (p === 'twitter') {
          const payload = buildTwitterMediaPayload({
            text: twitterText,
            altText: facebookAltText || undefined,
          });
          results.push({
            platform: 'twitter',
            ok: Boolean(twitterText),
            dryRun: true,
            id: `dry-tw-${Date.now().toString(36)}`,
            permalink: null,
            preview: twitterText.slice(0, 200),
            payload,
            ...(twitterText ? {} : { error: 'Missing Twitter text' }),
          });
        } else if (p === 'linkedin') {
          const payload = buildLinkedInDocumentPayload({
            text: linkedinText,
            pdfName: String(liIn.pdfName || 'document.pdf'),
          });
          results.push({
            platform: 'linkedin',
            ok: Boolean(linkedinText),
            dryRun: true,
            id: `dry-li-${Date.now().toString(36)}`,
            permalink: null,
            preview: linkedinText.slice(0, 200),
            payload,
            ...(linkedinText ? {} : { error: 'Missing LinkedIn text' }),
          });
        } else if (p === 'youtube') {
          const okYt = Boolean(youtubeTitle && youtubeDescription);
          const payload = {
            snippet: {
              title: youtubeTitle,
              description: youtubeDescription,
              tags: youtubeTags || [],
            },
          };
          results.push({
            platform: 'youtube',
            ok: okYt,
            dryRun: true,
            id: `dry-yt-${Date.now().toString(36)}`,
            permalink: null,
            preview: `${youtubeTitle} — ${youtubeDescription}`.slice(0, 200),
            payload,
            tags: youtubeTags || null,
            ...(okYt ? {} : { error: 'Missing YouTube title or description' }),
          });
        } else if (p === 'whatsapp') {
          const payload = {
            messaging_product: 'whatsapp',
            to: '[redacted]',
            type: whatsappMessageType || 'text',
            text: { body: whatsappText },
            templateName: whatsappTemplateName || null,
          };
          results.push({
            platform: 'whatsapp',
            ok: Boolean(whatsappText),
            dryRun: true,
            id: `dry-wa-${Date.now().toString(36)}`,
            permalink: null,
            preview: whatsappText.slice(0, 200),
            payload,
            messageType: whatsappMessageType,
            templateName: whatsappTemplateName || null,
            ...(whatsappText ? {} : { error: 'Missing WhatsApp text' }),
          });
        }
        continue;
      }

      // Live path per platform (unchanged behavior, plus per-result dryRun flag).
      if (p === 'facebook') {
        try {
          assertFacebookConfig();
          if (!facebookText) throw new Error('Missing Facebook text');
          if (facebookVisual) {
            if (!imagePath) {
              throw new Error('Visual mode requires an image (upload or generated creative)');
            }
            results.push({
              ...(await publishOne('facebook', () =>
                postPhotoToFacebook(facebookText, imagePath, {
                  altText: facebookAltText,
                  scheduledPublishTime,
                })
              )),
              dryRun: false,
              payload: buildFacebookPhotoPayload(facebookText, {
                altText: facebookAltText,
                scheduledPublishTime,
                filename: path.basename(imagePath),
              }),
            });
          } else {
            results.push({
              ...(await publishOne('facebook', () =>
                postToFacebook(facebookText, { scheduledPublishTime })
              )),
              dryRun: false,
              payload: buildFacebookFeedPayload(facebookText, {
                scheduledPublishTime,
                pageToken: '[redacted]',
              }),
            });
          }
        } catch (e) {
          results.push({
            platform: 'facebook',
            ok: false,
            dryRun: false,
            error: e.message || String(e),
          });
        }
      } else if (p === 'twitter') {
        try {
          if (!hasTwitterConfig()) throw new Error('Twitter credentials not configured');
          assertTwitterConfig();
          if (!twitterText) throw new Error('Missing Twitter text');
          results.push({
            ...(await publishOne('twitter', () => postToTwitter(twitterText))),
            dryRun: false,
          });
        } catch (e) {
          results.push({
            platform: 'twitter',
            ok: false,
            dryRun: false,
            error: e.message || String(e),
          });
        }
      } else if (p === 'linkedin') {
        try {
          assertLinkedInConfig();
          if (!linkedinText) throw new Error('Missing LinkedIn text');
          results.push({
            ...(await publishOne('linkedin', () => postToLinkedIn(linkedinText))),
            dryRun: false,
          });
        } catch (e) {
          results.push({
            platform: 'linkedin',
            ok: false,
            dryRun: false,
            error: e.message || String(e),
          });
        }
      } else if (p === 'youtube') {
        try {
          assertYouTubeConfig();
          if (!youtubeTitle || !youtubeDescription) {
            throw new Error('Missing YouTube title or description');
          }
          results.push({
            ...(await publishOne('youtube', () =>
              postToYouTube({
                title: youtubeTitle,
                description: youtubeDescription,
                tags: youtubeTags,
              })
            )),
            dryRun: false,
            tags: youtubeTags || null,
          });
        } catch (e) {
          results.push({
            platform: 'youtube',
            ok: false,
            dryRun: false,
            error: e.message || String(e),
          });
        }
      } else if (p === 'whatsapp') {
        try {
          assertWhatsAppConfig();
          if (!whatsappText) throw new Error('Missing WhatsApp text');
          results.push({
            ...(await publishOne('whatsapp', () => postToWhatsApp(whatsappText))),
            dryRun: false,
          });
        } catch (e) {
          results.push({
            platform: 'whatsapp',
            ok: false,
            dryRun: false,
            error: e.message || String(e),
          });
        }
      }
    }

    const allDry = results.every((r) => r.dryRun === true);

    // Feature 101: append every publish outcome to output/publish-log.jsonl.
    appendPublishLog({
      topic: String(req.body?.topic || '').trim() || null,
      platforms: selected,
      dryRun: allDry,
      mixed: !allDry && results.some((r) => r.dryRun === true),
      imageSource: imageSource || null,
      results: results.map((r) => ({
        platform: r.platform,
        ok: r.ok,
        dryRun: r.dryRun,
        id: r.id || null,
        error: r.error || null,
      })),
    });

    // Feature 206: audit live (non-dry-run) sends only — no message bodies.
    if (!allDry) {
      for (const r of results) {
        if (r.dryRun) continue;
        try {
          appendOutboundAudit({
            platform: r.platform,
            ok: r.ok,
            id: r.id || null,
            target: r.platform,
          });
        } catch (e) {
          logger.warn('outbound audit write failed', { error: e.message || String(e) });
        }
      }
    }

    const body = {
      ok: results.every((r) => r.ok),
      dryRun: allDry,
      mixed: !allDry && results.some((r) => r.dryRun === true),
      results,
      imageSource: imageSource || null,
      creativeUrl: previewUrl,
      imageUrl: previewUrl,
      requestId: req.requestId,
    };
    const idemKey = String(req.body?.idempotencyKey || '').trim();
    if (idemKey) {
      idempotencyCache.set(idemKey, { at: Date.now(), body });
    }
    return res.json(body);
  } catch (e) {
    logger.error('UI publish failed', e.message || e);
    return res.status(500).json(
      errorEnvelope({
        error: e.message || String(e),
        code: 'INTERNAL',
        requestId: req.requestId,
      })
    );
  } finally {
    livePublishInFlight = false;
    inFlightMutations = Math.max(0, inFlightMutations - 1);
  }
});

app.use(errorHandler);

/**
 * Startup env presence table (feature 187) — names only, never values.
 */
function logEnvReport() {
  const rows = [
    ['facebook', ['FB_PAGE_ID', 'FB_PAGE_TOKEN']],
    [
      'twitter',
      ['TWITTER_API_KEY', 'TWITTER_API_SECRET', 'TWITTER_ACCESS_TOKEN', 'TWITTER_ACCESS_SECRET'],
    ],
    ['linkedin', ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_AUTHOR_URN']],
    [
      'youtube',
      ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_VIDEO_ID'],
    ],
    ['whatsapp', ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TO']],
  ];
  for (const [platform, vars] of rows) {
    const status = vars.map((v) => `${v}:${process.env[v] ? 'present' : 'missing'}`).join(' ');
    logger.info(`env ${platform}`, { status });
  }
}

/**
 * Only bind the port when executed directly (node server/index.js) or when
 * UI_API_FORCE_LISTEN=1. Importing the module (tests, tooling) never listens.
 */
const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun || process.env.UI_API_FORCE_LISTEN === '1') {
  try {
    assertBindHost(HOST);
  } catch (e) {
    logger.error(e.message || String(e));
    process.exit(1);
  }

  const lock = acquirePidLock();
  if (!lock.acquired) {
    logger.error(lock.reason || 'PID lock failed');
    process.exit(1);
  }

  logEnvReport();
  logger.info('selftest: pass', { packParser: true, matchRules: true });

  // Feature 194: creatives TTL sweep on boot + daily.
  const creativesTtlDays = Number(process.env.CREATIVES_TTL_DAYS) || 14;
  startCreativesTtlInterval(creativesDir, creativesTtlDays);

  // Feature 220: optional Ollama warmup (skip gracefully when down).
  if (String(process.env.OLLAMA_WARMUP || '').toLowerCase() === 'true') {
    const url = `${config.ollama.url.replace(/\/$/, '')}/api/generate`;
    fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollama.model,
          prompt: 'ping',
          stream: false,
          options: { num_predict: 1 },
        }),
      },
      8_000
    )
      .then(() => logger.info('ollama warmup: ok'))
      .catch((e) => logger.warn('ollama warmup skipped', { error: e.message || String(e) }));
  }

  const server = app.listen(PORT, HOST, () => {
    logger.success(`Operator API listening on http://${HOST}:${PORT}`);
  });
  server.on('error', (err) => {
    logger.error(formatListenError(err, PORT));
    releasePidLock();
    process.exit(1);
  });

  /** Features 181/182: graceful shutdown with in-flight drain (max 5s). */
  async function shutdown(signal) {
    logger.info(`shutdown: ${signal} — draining in-flight requests`);
    const deadline = Date.now() + 5000;
    while (inFlightMutations > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    server.close(() => {
      releasePidLock();
      logger.info('shutdown: complete');
      process.exit(0);
    });
    setTimeout(() => {
      releasePidLock();
      logger.warn('shutdown: forced after drain deadline');
      process.exit(0);
    }, 5500).unref?.();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { message: String(reason?.message || reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { message: err.message || String(err) });
    shutdown('uncaughtException');
  });
}

export { app };
export default app;
