/**
 * Skill: publish to a Facebook Page using the Graph API.
 * - Text mode: POST /{page-id}/feed (message + optional link)
 * - Visual mode: POST /{page-id}/photos (multipart caption + image)
 */
import fs from 'fs';
import path from 'path';
import { config, assertFacebookConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { fetchWithRetry } from '../utils/http_fetch.js';

/**
 * Publishes `message` to the configured Page feed (public by default).
 * @param {string} message — post body (plain text)
 * @param {{ link?: string }} [options] — optional URL preview attachment
 * @returns {Promise<string>} Facebook post id (format: {page-id}_{post-id})
 */
export async function postToFacebook(message, options = {}) {
  assertFacebookConfig();

  if (!message || !String(message).trim()) {
    throw new Error('Message is required for postToFacebook()');
  }

  const { pageId, pageToken, graphVersion } = config.facebook;
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/feed`;

  const params = new URLSearchParams();
  params.set('message', message.trim());
  params.set('published', 'true');
  if (options.link) {
    params.set('link', String(options.link).trim());
  }
  params.set('access_token', pageToken);

  logger.info('Posting to Facebook Page feed', { pageId, graphVersion });

  let res;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      },
      { timeoutMs: config.http.timeoutMs, retries: config.http.retries }
    );
  } catch (e) {
    throw new Error(`Facebook request failed: ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Facebook returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok || data.error) {
    const err = data.error;
    const detail = err
      ? `${err.message || 'Unknown'} (code ${err.code ?? 'n/a'}, type ${err.type ?? 'n/a'}, fbtrace_id: ${err.fbtrace_id ?? 'n/a'})`
      : text;
    throw new Error(`Facebook Graph API error ${res.status}: ${detail}`);
  }

  const id = data.id;
  if (!id || typeof id !== 'string') {
    throw new Error(`Facebook response missing post id: ${JSON.stringify(data)}`);
  }

  return id;
}

/**
 * Publishes a photo to the Page with a caption (creates a Page post).
 * Uses multipart upload of a local image file.
 * @param {string} caption
 * @param {string} imagePath — absolute or relative path to PNG/JPEG
 * @returns {Promise<string>} Graph photo/post id
 */
export async function postPhotoToFacebook(caption, imagePath) {
  assertFacebookConfig();

  if (!caption || !String(caption).trim()) {
    throw new Error('Caption is required for postPhotoToFacebook()');
  }
  if (!imagePath || !String(imagePath).trim()) {
    throw new Error('imagePath is required for postPhotoToFacebook()');
  }

  const abs = path.isAbsolute(imagePath) ? imagePath : path.resolve(imagePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Image file not found: ${abs}`);
  }

  const { pageId, pageToken, graphVersion } = config.facebook;
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/photos`;

  const bytes = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/png';
  const filename = path.basename(abs);

  const form = new FormData();
  form.set('caption', caption.trim());
  form.set('published', 'true');
  form.set('access_token', pageToken);
  form.set('source', new Blob([bytes], { type: mime }), filename);

  logger.info('Posting photo to Facebook Page', {
    pageId,
    graphVersion,
    image: filename,
  });

  let res;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        body: form,
      },
      { timeoutMs: Math.max(config.http.timeoutMs, 60_000), retries: config.http.retries }
    );
  } catch (e) {
    throw new Error(`Facebook photo upload failed: ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Facebook returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok || data.error) {
    const err = data.error;
    const detail = err
      ? `${err.message || 'Unknown'} (code ${err.code ?? 'n/a'}, type ${err.type ?? 'n/a'}, fbtrace_id: ${err.fbtrace_id ?? 'n/a'})`
      : text;
    throw new Error(`Facebook Photos API error ${res.status}: ${detail}`);
  }

  // Photos API returns { id, post_id? }
  const id = data.post_id || data.id;
  if (!id || (typeof id !== 'string' && typeof id !== 'number')) {
    throw new Error(`Facebook photo response missing id: ${JSON.stringify(data)}`);
  }

  return String(id);
}
