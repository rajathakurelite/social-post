/**
 * Skill: publish a text post to a Facebook Page using the Graph API.
 * POST https://graph.facebook.com/{version}/{page_id}/feed
 */
import fetch from 'node-fetch';
import { config, assertFacebookConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';

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
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
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
