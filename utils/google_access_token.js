/**
 * Refresh a short-lived Google OAuth access token for YouTube Data API calls.
 */
import fetch from 'node-fetch';

/**
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} creds
 * @returns {Promise<string>} access_token
 */
export async function refreshGoogleAccessToken(creds) {
  const { clientId, clientSecret, refreshToken } = creds;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('YouTube OAuth: missing YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, or YOUTUBE_REFRESH_TOKEN');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Google token endpoint returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Google OAuth token refresh failed (${res.status}): ${data.error_description || data.error || text}`
    );
  }

  return data.access_token;
}
