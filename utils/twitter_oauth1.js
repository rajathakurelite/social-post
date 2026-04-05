/**
 * OAuth 1.0a signing for Twitter / X API (user context) when using API key + secret + access token + secret.
 * See https://developer.twitter.com/en/docs/authentication/oauth-1-0a/creating-a-signature
 */
import crypto from 'crypto';

/** RFC 3986 percent-encoding for OAuth. */
function encodeRfc3986(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * @param {string} method
 * @param {string} url — scheme + host + path (no query for /2/tweets)
 * @param {Record<string, string>} oauthParams — oauth_* fields except signature
 * @param {string} consumerSecret
 * @param {string} tokenSecret
 */
export function oauth1Signature(method, url, oauthParams, consumerSecret, tokenSecret) {
  const keys = Object.keys(oauthParams).sort();
  const paramString = keys
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(oauthParams[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    encodeRfc3986(url),
    encodeRfc3986(paramString),
  ].join('&');
  const key = `${encodeRfc3986(consumerSecret)}&${encodeRfc3986(tokenSecret || '')}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

/**
 * Builds the Authorization header value for a Twitter user-context request.
 */
export function buildTwitterAuthorizationHeader({
  method,
  url,
  consumerKey,
  consumerSecret,
  accessToken,
  accessTokenSecret,
}) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
  };
  const signature = oauth1Signature(method, url, oauthParams, consumerSecret, accessTokenSecret);
  const withSig = { ...oauthParams, oauth_signature: signature };
  const header =
    'OAuth ' +
    Object.keys(withSig)
      .sort()
      .map((k) => `${encodeRfc3986(k)}="${encodeRfc3986(withSig[k])}"`)
      .join(', ');
  return header;
}
