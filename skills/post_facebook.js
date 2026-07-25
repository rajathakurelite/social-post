// @ts-nocheck
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
 * Feature 160/221: build the Graph feed payload (no network).
 * `scheduled_publish_time` is only included when provided; callers honor it live-armed only.
 * @param {string} message
 * @param {{ link?: string, scheduledPublishTime?: number | null, pageToken?: string }} [options]
 * @returns {Record<string, string>}
 */
export function buildFacebookFeedPayload(message, options = {}) {
  const params = {
    message: String(message || '').trim(),
    published: 'true',
    access_token: options.pageToken != null ? String(options.pageToken) : '[redacted]',
  };
  if (options.link) params.link = String(options.link).trim();
  const sched = options.scheduledPublishTime;
  if (sched != null && Number.isFinite(Number(sched)) && Number(sched) > 0) {
    params.published = 'false';
    params.scheduled_publish_time = String(Math.floor(Number(sched)));
  }
  return params;
}

/**
 * Feature 221: photo upload form fields (sans binary) for dry-run parity.
 * @param {string} caption
 * @param {{ altText?: string, scheduledPublishTime?: number | null, filename?: string }} [options]
 */
export function buildFacebookPhotoPayload(caption, options = {}) {
  const params = {
    caption: String(caption || '').trim(),
    published: 'true',
    source: options.filename || 'image.png',
  };
  if (options.altText && String(options.altText).trim()) {
    params.alt_text_custom = String(options.altText).trim().slice(0, 500);
  }
  const sched = options.scheduledPublishTime;
  if (sched != null && Number.isFinite(Number(sched)) && Number(sched) > 0) {
    params.published = 'false';
    params.scheduled_publish_time = String(Math.floor(Number(sched)));
  }
  return params;
}

/**
 * Publishes `message` to the configured Page feed (public by default).
 * @param {string} message — post body (plain text)
 * @param {{ link?: string, scheduledPublishTime?: number | null }} [options] — optional URL preview + schedule
 * @returns {Promise<string>} Facebook post id (format: {page-id}_{post-id})
 */
export async function postToFacebook(message, options = {}) {
  assertFacebookConfig();

  if (!message || !String(message).trim()) {
    throw new Error('Message is required for postToFacebook()');
  }

  const { pageId, pageToken, graphVersion } = config.facebook;
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/feed`;

  const built = buildFacebookFeedPayload(message, {
    link: options.link,
    scheduledPublishTime: options.scheduledPublishTime,
    pageToken,
  });
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(built)) params.set(k, v);

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
 * Feature 81: send a Messenger reply via the Page Send API (me/messages).
 * Requires the Page token to have pages_messaging; used only by the armed
 * auto-reply path — never called from tests or dry-run.
 * @param {string} recipientId — PSID from the webhook sender.id
 * @param {string} message — plain text reply
 * @returns {Promise<string>} message id
 */
export async function sendMessengerReply(recipientId, message) {
  assertFacebookConfig();

  const psid = String(recipientId || '').trim();
  const body = String(message || '').trim();
  if (!psid) throw new Error('recipientId (PSID) is required for sendMessengerReply()');
  if (!body) throw new Error('Message is required for sendMessengerReply()');

  const { pageToken, graphVersion } = config.facebook;
  const url = `https://graph.facebook.com/${graphVersion}/me/messages?access_token=${encodeURIComponent(pageToken)}`;

  logger.info('Sending Messenger reply', { graphVersion, to: `${psid.slice(0, 6)}…` });

  let res;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: { text: body.slice(0, 2000) },
        }),
      },
      { timeoutMs: config.http.timeoutMs, retries: config.http.retries }
    );
  } catch (e) {
    throw new Error(`Messenger send failed: ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Messenger returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok || data.error) {
    const err = data.error;
    const detail = err
      ? `${err.message || 'Unknown'} (code ${err.code ?? 'n/a'}, type ${err.type ?? 'n/a'}, fbtrace_id: ${err.fbtrace_id ?? 'n/a'})`
      : text;
    throw new Error(`Messenger Send API error ${res.status}: ${detail}`);
  }

  return String(data.message_id || data.recipient_id || 'ok');
}

/**
 * Publishes a photo to the Page with a caption (creates a Page post).
 * Uses multipart upload of a local image file.
 * @param {string} caption
 * @param {string} imagePath — absolute or relative path to PNG/JPEG
 * @param {{ altText?: string, scheduledPublishTime?: number | null }} [options] — feature 126/160
 * @returns {Promise<string>} Graph photo/post id
 */
export async function postPhotoToFacebook(caption, imagePath, options = {}) {
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

  const fields = buildFacebookPhotoPayload(caption, {
    altText: options.altText,
    scheduledPublishTime: options.scheduledPublishTime,
    filename,
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'source') continue;
    form.set(k, v);
  }
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
