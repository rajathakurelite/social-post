/**
 * Local operator API for ai-social-agent.
 * Binds to 127.0.0.1 only — no auth in v1; uses project .env credentials.
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
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
} from '../skills/generate_post.js';
import { renderCreativePng } from '../skills/render_creative.js';
import { postToFacebook, postPhotoToFacebook } from '../skills/post_facebook.js';
import { postToTwitter } from '../skills/post_twitter.js';
import { postToLinkedIn } from '../skills/post_linkedin.js';
import { postToYouTube } from '../skills/post_youtube.js';
import { postToWhatsApp } from '../skills/post_whatsapp.js';
import { logger } from '../utils/logger.js';

const HOST = process.env.UI_API_HOST || '127.0.0.1';
const PORT = Number(process.env.UI_API_PORT) || 8787;
const ALLOWED = new Set(['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp']);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const creativesDir = path.join(config.rootDir, 'output', 'creatives');
const uploadsDir = path.join(config.rootDir, 'output', 'uploads');
fs.mkdirSync(creativesDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '6mb' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXT.has(ext) ? ext : mimeToExt(file.mimetype) || '.png';
    const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`;
    cb(null, id);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME.has(file.mimetype);
    const extOk = !ext || ALLOWED_EXT.has(ext);
    if (mimeOk && extOk) return cb(null, true);
    return cb(new Error('Only JPEG, PNG, or WebP images up to 5 MB are allowed'));
  },
});

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
 * Multipart image upload (one file, max 5 MB, jpeg/png/webp).
 */
app.post('/api/upload', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const msg =
        err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be 5 MB or smaller'
          : err.message || String(err);
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'image file is required (field name: image)' });
    }
    const uploadId = req.file.filename;
    logger.info('UI upload saved', { uploadId, size: req.file.size, mime: req.file.mimetype });
    return res.json({
      ok: true,
      uploadId,
      url: `/api/uploads/${encodeURIComponent(uploadId)}`,
      mime: req.file.mimetype,
      size: req.file.size,
    });
  });
});

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizePlatforms(list) {
  const raw = Array.isArray(list) ? list : [];
  const candidates = raw
    .map((p) => String(p || '').trim().toLowerCase())
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
        config.whatsapp.accessToken &&
          config.whatsapp.phoneNumberId &&
          config.whatsapp.to
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

app.get('/api/health', async (_req, res) => {
  let ollama = { ok: false, url: config.ollama.url, model: config.ollama.model, error: null };
  try {
    await assertOllamaReady();
    ollama = { ok: true, url: config.ollama.url, model: config.ollama.model, error: null };
  } catch (e) {
    ollama.error = e.message || String(e);
  }

  res.json({
    ok: true,
    brand: config.brand.name,
    facebookPostMode: config.facebook.postMode,
    dryRunDefault: config.dryRun,
    ollama,
    platforms: platformStatus(),
  });
});

app.post('/api/polish', async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    const notes = String(req.body?.notes || '').trim();
    if (!topic) {
      return res.status(400).json({ error: 'topic is required' });
    }

    const selected = normalizePlatforms(req.body?.platforms);
    if (!selected.length) {
      return res.status(400).json({
        error: 'Select at least one enabled platform',
        platforms: platformStatus(),
      });
    }

    const uploadResolved = resolveUploadPath(req.body?.uploadId);
    const angle = notes ? `${topic}\n\nOperator notes: ${notes}` : topic;
    const facebookVisual = config.facebook.postMode === 'visual';

    logger.info('UI polish', {
      brand: config.brand.name,
      platforms: selected,
      facebookPostMode: config.facebook.postMode,
      hasUpload: Boolean(uploadResolved),
    });

    let pack;
    const facebookOnly = selected.length === 1 && selected[0] === 'facebook';
    if (facebookOnly && facebookVisual) {
      const creative = await generateFacebookCreative(angle);
      pack = {
        facebook: creative.caption,
        twitter: '',
        linkedin: '',
        youtubeTitle: '',
        youtubeDescription: '',
        whatsapp: '',
        facebookCreative: creative,
      };
    } else {
      pack = await generateMultiPlatformPack(angle);
    }

    /** @type {string | null} */
    let imagePath = null;
    /** @type {'upload' | 'creative' | null} */
    let imageSource = null;
    /** @type {string | null} */
    let imageUrl = null;

    if (selected.includes('facebook') && facebookVisual) {
      if (uploadResolved) {
        imagePath = uploadResolved;
        imageSource = 'upload';
        imageUrl = uploadPreviewUrl(uploadResolved);
      } else {
        const fields = pack.facebookCreative || defaultFacebookCreative(angle);
        imagePath = await renderCreativePng({
          headline: fields.headline,
          accentWord: fields.accentWord,
          subhead: fields.subhead,
          body: fields.body,
          ctaLabel: fields.ctaLabel,
          ctaUrl: config.brand.internshipsUrl,
        });
        imageSource = 'creative';
        imageUrl = creativePreviewUrl(imagePath);
      }
    }

    /** @type {Record<string, unknown>} */
    const posts = {};
    if (selected.includes('facebook')) {
      posts.facebook = {
        text: pack.facebook,
        mode: config.facebook.postMode,
        creative: pack.facebookCreative || null,
        creativePath: imageSource === 'creative' ? imagePath : null,
        uploadId: imageSource === 'upload' ? path.basename(imagePath) : null,
        imagePath: imagePath || null,
        imageSource,
        creativeUrl: imageUrl,
        imageUrl,
      };
    }
    if (selected.includes('twitter')) {
      posts.twitter = { text: pack.twitter };
    }
    if (selected.includes('linkedin')) {
      posts.linkedin = { text: pack.linkedin };
    }
    if (selected.includes('youtube')) {
      posts.youtube = {
        title: pack.youtubeTitle,
        description: pack.youtubeDescription,
        text: [pack.youtubeTitle, pack.youtubeDescription].filter(Boolean).join('\n\n'),
      };
    }
    if (selected.includes('whatsapp')) {
      posts.whatsapp = { text: pack.whatsapp };
    }

    return res.json({
      ok: true,
      topic,
      notes: notes || null,
      brand: config.brand.name,
      platforms: selected,
      uploadId: uploadResolved ? path.basename(uploadResolved) : null,
      posts,
    });
  } catch (e) {
    logger.error('UI polish failed', e.message || e);
    if (!res.headersSent) {
      return res.status(500).json({ error: e.message || String(e) });
    }
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
  try {
    const dryRun = Boolean(req.body?.dryRun) || config.dryRun;
    const selected = normalizePlatforms(req.body?.platforms);
    if (!selected.length) {
      return res.status(400).json({
        error: 'Select at least one enabled platform',
        platforms: platformStatus(),
      });
    }

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
    const whatsappText = String(waIn.text || '').trim();

    let { absPath: imagePath, source: imageSource } = resolveImageForFacebook({
      uploadId: req.body?.uploadId || fbIn.uploadId,
      imagePath: fbIn.imagePath || req.body?.imagePath,
      creativePath: fbIn.creativePath,
    });

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
      });
      imageSource = 'creative';
    }

    const previewUrl =
      imageSource === 'upload' ? uploadPreviewUrl(imagePath) : creativePreviewUrl(imagePath);

    logger.info('UI publish', {
      platforms: selected,
      dryRun,
      facebookPostMode: config.facebook.postMode,
      imageSource,
    });

    if (dryRun) {
      /** @type {Array<{ platform: string, ok: boolean, dryRun: boolean, id?: string, preview?: string, imagePath?: string | null, imageSource?: string | null, creativePath?: string | null }>} */
      const results = [];
      for (const p of selected) {
        if (p === 'facebook') {
          results.push({
            platform: 'facebook',
            ok: Boolean(facebookText),
            dryRun: true,
            id: 'dry-run',
            preview: facebookText.slice(0, 200),
            imagePath: imagePath || null,
            imageSource: imageSource || null,
            creativePath: imageSource === 'creative' ? imagePath : null,
            ...(facebookText ? {} : { error: 'Missing Facebook text' }),
          });
        } else if (p === 'twitter') {
          results.push({
            platform: 'twitter',
            ok: Boolean(twitterText),
            dryRun: true,
            id: 'dry-run',
            preview: twitterText.slice(0, 200),
            ...(twitterText ? {} : { error: 'Missing Twitter text' }),
          });
        } else if (p === 'linkedin') {
          results.push({
            platform: 'linkedin',
            ok: Boolean(linkedinText),
            dryRun: true,
            id: 'dry-run',
            preview: linkedinText.slice(0, 200),
            ...(linkedinText ? {} : { error: 'Missing LinkedIn text' }),
          });
        } else if (p === 'youtube') {
          const ok = Boolean(youtubeTitle && youtubeDescription);
          results.push({
            platform: 'youtube',
            ok,
            dryRun: true,
            id: 'dry-run',
            preview: `${youtubeTitle} — ${youtubeDescription}`.slice(0, 200),
            ...(ok ? {} : { error: 'Missing YouTube title or description' }),
          });
        } else if (p === 'whatsapp') {
          results.push({
            platform: 'whatsapp',
            ok: Boolean(whatsappText),
            dryRun: true,
            id: 'dry-run',
            preview: whatsappText.slice(0, 200),
            ...(whatsappText ? {} : { error: 'Missing WhatsApp text' }),
          });
        }
      }
      return res.json({
        ok: results.every((r) => r.ok),
        dryRun: true,
        results,
        imageSource: imageSource || null,
        creativeUrl: previewUrl,
        imageUrl: previewUrl,
      });
    }

    /** @type {Array<{ platform: string, ok: boolean, id?: string, error?: string }>} */
    const results = [];

    if (selected.includes('facebook')) {
      try {
        assertFacebookConfig();
        if (!facebookText) throw new Error('Missing Facebook text');
        if (facebookVisual) {
          if (!imagePath) throw new Error('Visual mode requires an image (upload or generated creative)');
          results.push(await publishOne('facebook', () => postPhotoToFacebook(facebookText, imagePath)));
        } else {
          results.push(await publishOne('facebook', () => postToFacebook(facebookText)));
        }
      } catch (e) {
        results.push({ platform: 'facebook', ok: false, error: e.message || String(e) });
      }
    }

    if (selected.includes('twitter')) {
      try {
        if (!hasTwitterConfig()) throw new Error('Twitter credentials not configured');
        assertTwitterConfig();
        if (!twitterText) throw new Error('Missing Twitter text');
        results.push(await publishOne('twitter', () => postToTwitter(twitterText)));
      } catch (e) {
        results.push({ platform: 'twitter', ok: false, error: e.message || String(e) });
      }
    }

    if (selected.includes('linkedin')) {
      try {
        assertLinkedInConfig();
        if (!linkedinText) throw new Error('Missing LinkedIn text');
        results.push(await publishOne('linkedin', () => postToLinkedIn(linkedinText)));
      } catch (e) {
        results.push({ platform: 'linkedin', ok: false, error: e.message || String(e) });
      }
    }

    if (selected.includes('youtube')) {
      try {
        assertYouTubeConfig();
        if (!youtubeTitle || !youtubeDescription) {
          throw new Error('Missing YouTube title or description');
        }
        results.push(
          await publishOne('youtube', () =>
            postToYouTube({ title: youtubeTitle, description: youtubeDescription })
          )
        );
      } catch (e) {
        results.push({ platform: 'youtube', ok: false, error: e.message || String(e) });
      }
    }

    if (selected.includes('whatsapp')) {
      try {
        assertWhatsAppConfig();
        if (!whatsappText) throw new Error('Missing WhatsApp text');
        results.push(await publishOne('whatsapp', () => postToWhatsApp(whatsappText)));
      } catch (e) {
        results.push({ platform: 'whatsapp', ok: false, error: e.message || String(e) });
      }
    }

    return res.json({
      ok: results.every((r) => r.ok),
      dryRun: false,
      results,
      imageSource: imageSource || null,
      creativeUrl: previewUrl,
      imageUrl: previewUrl,
    });
  } catch (e) {
    logger.error('UI publish failed', e.message || e);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

app.listen(PORT, HOST, () => {
  logger.success(`Operator API listening on http://${HOST}:${PORT}`);
});
