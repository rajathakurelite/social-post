/**
 * Skill: create a public feed post on LinkedIn using the REST Posts API.
 * Requires: w_member_social (person) or w_organization_social (org) on the access token.
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api
 */
import fetch from 'node-fetch';
import { config, assertLinkedInConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';

/**
 * @param {string} commentary — main post text
 * @returns {Promise<string>} Post URN or id from x-restli-id header when present
 */
export async function postToLinkedIn(commentary) {
  assertLinkedInConfig();

  const text = String(commentary || '').trim();
  if (!text) {
    throw new Error('Message is required for postToLinkedIn()');
  }

  const url = 'https://api.linkedin.com/rest/posts';
  const { accessToken, authorUrn, restVersion } = config.linkedin;

  const body = {
    author: authorUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  logger.info('Posting to LinkedIn', { authorUrn: authorUrn.replace(/\d+/g, '…') });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': restVersion,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`LinkedIn request failed: ${e.message}`);
  }

  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`LinkedIn returned non-JSON (${res.status}): ${raw.slice(0, 500)}`);
  }

  if (!res.ok) {
    const msg =
      data?.message ||
      data?.errorDetails?.[0]?.message ||
      data?.status ||
      raw;
    throw new Error(`LinkedIn API error ${res.status}: ${msg}`);
  }

  const restliId = res.headers.get('x-restli-id');
  if (restliId) return restliId;
  if (data.id) return String(data.id);
  return 'ok';
}
