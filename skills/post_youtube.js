/**
 * Skill: update an existing YouTube video's title and description (YouTube Data API v3).
 * Google does not expose "Community tab" text posts via the public Data API; this updates metadata on a video you already uploaded.
 */
import fetch from 'node-fetch';
import { config, assertYouTubeConfig } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { refreshGoogleAccessToken } from '../utils/google_access_token.js';

/**
 * @param {{ title: string, description: string }} meta
 * @returns {Promise<string>} video id
 */
export async function postToYouTube(meta) {
  assertYouTubeConfig();

  const title = String(meta?.title || '').trim();
  const description = String(meta?.description || '').trim();
  if (!title || !description) {
    throw new Error('YouTube: title and description are required');
  }

  const { videoId } = config.youtube;
  const accessToken = await refreshGoogleAccessToken({
    clientId: config.youtube.clientId,
    clientSecret: config.youtube.clientSecret,
    refreshToken: config.youtube.refreshToken,
  });

  const listUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  listUrl.searchParams.set('part', 'snippet');
  listUrl.searchParams.set('id', videoId);

  logger.info('Fetching YouTube video snippet before update', { videoId });

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listText = await listRes.text();
  let listData;
  try {
    listData = JSON.parse(listText);
  } catch {
    throw new Error(`YouTube videos.list non-JSON (${listRes.status}): ${listText.slice(0, 400)}`);
  }

  if (!listRes.ok || listData.error) {
    throw new Error(
      `YouTube videos.list failed (${listRes.status}): ${listData.error?.message || listText}`
    );
  }

  const item = listData.items?.[0];
  if (!item?.snippet) {
    throw new Error(`YouTube: video not found or inaccessible: ${videoId}`);
  }

  const snippet = {
    title: title.slice(0, 100),
    description,
    categoryId: item.snippet.categoryId || '22',
    tags: Array.isArray(item.snippet.tags) ? item.snippet.tags : [],
  };

  const updateUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  updateUrl.searchParams.set('part', 'snippet');

  const updateRes = await fetch(updateUrl.toString(), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: videoId,
      snippet,
    }),
  });

  const updateText = await updateRes.text();
  let updateData;
  try {
    updateData = updateText ? JSON.parse(updateText) : {};
  } catch {
    throw new Error(`YouTube videos.update non-JSON (${updateRes.status}): ${updateText.slice(0, 400)}`);
  }

  if (!updateRes.ok || updateData.error) {
    throw new Error(
      `YouTube videos.update failed (${updateRes.status}): ${updateData.error?.message || updateText}`
    );
  }

  const id = updateData.id || videoId;
  logger.success('YouTube video metadata updated', { id });
  return id;
}
