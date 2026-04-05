/**
 * Skill: publish a post on X (Twitter) using API v2.
 * Supports OAuth 2.0 user access token (Bearer) OR OAuth 1.0a user context (HMAC-SHA1).
 */
import fetch from 'node-fetch';
import { config, assertTwitterConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { buildTwitterAuthorizationHeader } from '../utils/twitter_oauth1.js';

const TWITTER_POST_URL = 'https://api.twitter.com/2/tweets';

/**
 * @param {string} text — tweet body (length enforced by caller or API)
 * @returns {Promise<string>} Tweet id
 */
export async function postToTwitter(text) {
  assertTwitterConfig();

  const bodyText = String(text || '').trim();
  if (!bodyText) {
    throw new Error('Message is required for postToTwitter()');
  }

  const max = config.twitter.maxChars;
  const payload = bodyText.length > max ? `${bodyText.slice(0, max - 1)}…` : bodyText;

  const jsonBody = JSON.stringify({ text: payload });

  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
  };

  if (config.twitter.oauth2AccessToken) {
    headers.Authorization = `Bearer ${config.twitter.oauth2AccessToken}`;
    logger.info('Posting to X (Twitter) via OAuth 2.0 user token');
  } else {
    headers.Authorization = buildTwitterAuthorizationHeader({
      method: 'POST',
      url: TWITTER_POST_URL,
      consumerKey: config.twitter.apiKey,
      consumerSecret: config.twitter.apiSecret,
      accessToken: config.twitter.accessToken,
      accessTokenSecret: config.twitter.accessTokenSecret,
    });
    logger.info('Posting to X (Twitter) via OAuth 1.0a');
  }

  let res;
  try {
    res = await fetch(TWITTER_POST_URL, {
      method: 'POST',
      headers,
      body: jsonBody,
    });
  } catch (e) {
    throw new Error(`Twitter request failed: ${e.message}`);
  }

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Twitter returned non-JSON (${res.status}): ${raw.slice(0, 500)}`);
  }

  if (!res.ok) {
    const msg = data?.detail || data?.title || data?.errors?.[0]?.message || raw;
    throw new Error(`Twitter API error ${res.status}: ${msg}`);
  }

  const id = data?.data?.id;
  if (!id) {
    throw new Error(`Twitter response missing tweet id: ${JSON.stringify(data)}`);
  }

  return id;
}
