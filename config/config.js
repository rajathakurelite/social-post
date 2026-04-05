/**
 * Central configuration: loads .env from the project root and exposes typed-ish settings.
 * Import this module once at app entry so all skills see the same env.
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(rootDir, '.env') });

/** @returns {string} */
function req(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

const twMax = parseInt(req('TWITTER_MAX_CHARS'), 10);

export const config = {
  rootDir,

  ollama: {
    url: req('OLLAMA_URL') || 'http://localhost:11434',
    model: req('MODEL') || 'gemma:7b-instruct',
  },

  facebook: {
    pageId: req('FB_PAGE_ID'),
    pageToken: req('FB_PAGE_TOKEN'),
    graphVersion: req('FB_GRAPH_VERSION') || 'v19.0',
  },

  /**
   * Twitter / X: use EITHER OAuth 2.0 user access token (tweet.write) OR OAuth 1.0a user context keys.
   */
  twitter: {
    oauth2AccessToken: req('TWITTER_OAUTH2_ACCESS_TOKEN'),
    apiKey: req('TWITTER_API_KEY'),
    apiSecret: req('TWITTER_API_SECRET'),
    accessToken: req('TWITTER_ACCESS_TOKEN'),
    accessTokenSecret: req('TWITTER_ACCESS_TOKEN_SECRET'),
    maxChars: Number.isFinite(twMax) && twMax > 0 ? Math.min(4000, twMax) : 280,
  },

  linkedin: {
    accessToken: req('LINKEDIN_ACCESS_TOKEN'),
    /** e.g. urn:li:person:xxx or urn:li:organization:xxx */
    authorUrn: req('LINKEDIN_AUTHOR_URN'),
    /** Monthly version header required by LinkedIn REST APIs */
    restVersion: req('LINKEDIN_VERSION') || '202405',
  },

  youtube: {
    clientId: req('YOUTUBE_CLIENT_ID'),
    clientSecret: req('YOUTUBE_CLIENT_SECRET'),
    refreshToken: req('YOUTUBE_REFRESH_TOKEN'),
    /** Existing video on your channel to update title/description (Data API cannot create Community posts). */
    videoId: req('YOUTUBE_VIDEO_ID'),
  },

  /** Comma-separated: facebook,twitter,linkedin,youtube */
  platforms: (req('PLATFORMS') || 'facebook,twitter,linkedin,youtube')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

export function assertFacebookConfig() {
  const { pageId, pageToken } = config.facebook;
  if (!pageId || !pageToken) {
    throw new Error(
      'Missing FB_PAGE_ID or FB_PAGE_TOKEN. Copy .env.example to .env and fill in Facebook credentials.'
    );
  }
}

export function hasTwitterConfig() {
  const t = config.twitter;
  if (t.oauth2AccessToken) return true;
  return Boolean(t.apiKey && t.apiSecret && t.accessToken && t.accessTokenSecret);
}

export function assertTwitterConfig() {
  if (!hasTwitterConfig()) {
    throw new Error(
      'Twitter: set TWITTER_OAUTH2_ACCESS_TOKEN (OAuth 2 user token with tweet.write) OR TWITTER_API_KEY + TWITTER_API_SECRET + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET (OAuth 1.0a).'
    );
  }
}

export function assertLinkedInConfig() {
  const { accessToken, authorUrn } = config.linkedin;
  if (!accessToken || !authorUrn) {
    throw new Error('Missing LINKEDIN_ACCESS_TOKEN or LINKEDIN_AUTHOR_URN (urn:li:person:... or urn:li:organization:...).');
  }
}

export function assertYouTubeConfig() {
  const y = config.youtube;
  if (!y.clientId || !y.clientSecret || !y.refreshToken) {
    throw new Error('YouTube: set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.');
  }
  if (!y.videoId) {
    throw new Error(
      'YouTube: set YOUTUBE_VIDEO_ID to an existing video ID on your channel (this flow updates title/description via Data API).'
    );
  }
}
