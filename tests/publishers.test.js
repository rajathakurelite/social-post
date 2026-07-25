/**
 * Publisher skills tested against a MOCKED fetch — no live platform APIs, ever.
 * Credentials are the fake values injected by tests/setup.js.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  postToFacebook,
  postPhotoToFacebook,
  sendMessengerReply,
} from '../skills/post_facebook.js';
import { postToWhatsApp } from '../skills/post_whatsapp.js';
import { postToLinkedIn } from '../skills/post_linkedin.js';
import { postToTwitter } from '../skills/post_twitter.js';
import { postToYouTube } from '../skills/post_youtube.js';
import { refreshGoogleAccessToken } from '../utils/google_access_token.js';
import { oauth1Signature, buildTwitterAuthorizationHeader } from '../utils/twitter_oauth1.js';

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('postToFacebook (mocked)', () => {
  it('posts and returns the page post id', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(200, { id: '123_456' }));
    vi.stubGlobal('fetch', mock);
    const id = await postToFacebook('Hello from tests');
    expect(id).toBe('123_456');
    const [url, opts] = mock.mock.calls[0];
    expect(url).toMatch(/graph\.facebook\.com/);
    expect(opts.method).toBe('POST');
  });

  it('surfaces Graph API error details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          error: { message: 'Invalid token', code: 190, type: 'OAuthException' },
        })
      )
    );
    await expect(postToFacebook('x')).rejects.toThrow(/Invalid token.*code 190/);
  });

  it('requires a message', async () => {
    await expect(postToFacebook('')).rejects.toThrow(/Message is required/);
  });
});

describe('postPhotoToFacebook (mocked)', () => {
  it('uploads a local image and returns post id', async () => {
    const tmp = path.join(os.tmpdir(), `fb-test-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse(200, { id: '9', post_id: '123_9' }))
      );
      const id = await postPhotoToFacebook('caption', tmp);
      expect(id).toBe('123_9');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('fails fast on a missing file', async () => {
    await expect(postPhotoToFacebook('caption', 'Z:/nope/missing.png')).rejects.toThrow(
      /not found/
    );
  });
});

describe('sendMessengerReply (81, mocked)', () => {
  it('sends a Messenger RESPONSE message', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(200, { message_id: 'mid.1' }));
    vi.stubGlobal('fetch', mock);
    const id = await sendMessengerReply('1234567890123', 'Thanks for reaching out');
    expect(id).toBe('mid.1');
    const [url, opts] = mock.mock.calls[0];
    expect(url).toMatch(/me\/messages/);
    const body = JSON.parse(opts.body);
    expect(body.messaging_type).toBe('RESPONSE');
    expect(body.recipient.id).toBe('1234567890123');
  });

  it('rejects empty recipient or message', async () => {
    await expect(sendMessengerReply('', 'x')).rejects.toThrow(/PSID/);
    await expect(sendMessengerReply('123', '')).rejects.toThrow(/Message is required/);
  });
});

describe('postToWhatsApp (mocked)', () => {
  it('sends to the recipient override and returns wamid', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(200, { messages: [{ id: 'wamid.A' }] }));
    vi.stubGlobal('fetch', mock);
    const id = await postToWhatsApp('hi there', { to: '15551234567' });
    expect(id).toBe('wamid.A');
    const body = JSON.parse(mock.mock.calls[0][1].body);
    expect(body.to).toBe('15551234567');
    expect(body.type).toBe('text');
  });

  it('reports Cloud API errors with code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(401, { error: { message: 'Bad token', code: 190 } }))
    );
    await expect(postToWhatsApp('hi', { to: '15551234567' })).rejects.toThrow(
      /Bad token.*code 190/
    );
  });

  it('rejects when no valid recipients', async () => {
    await expect(postToWhatsApp('hi', { to: 'abc' })).rejects.toThrow(/WHATSAPP_TO/);
  });
});

describe('postToLinkedIn (mocked)', () => {
  it('creates a post and returns the restli id header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(201, {}, { 'x-restli-id': 'urn:li:share:42' }))
    );
    const id = await postToLinkedIn('Professional update');
    expect(id).toBe('urn:li:share:42');
  });

  it('surfaces API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(403, { message: 'Not permitted' }))
    );
    await expect(postToLinkedIn('x')).rejects.toThrow(/403.*Not permitted/);
  });
});

describe('postToTwitter (mocked)', () => {
  it('tweets via OAuth2 bearer and returns tweet id', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(201, { data: { id: '1789' } }));
    vi.stubGlobal('fetch', mock);
    const id = await postToTwitter('hello world');
    expect(id).toBe('1789');
    expect(mock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
  });

  it('truncates over-limit text to maxChars', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(201, { data: { id: '1' } }));
    vi.stubGlobal('fetch', mock);
    await postToTwitter('x'.repeat(400));
    const sent = JSON.parse(mock.mock.calls[0][1].body).text;
    expect(sent.length).toBeLessThanOrEqual(280);
    expect(sent.endsWith('…')).toBe(true);
  });
});

describe('twitter OAuth1 signing', () => {
  it('produces a deterministic HMAC-SHA1 signature', () => {
    const sig = oauth1Signature(
      'POST',
      'https://api.twitter.com/2/tweets',
      {
        oauth_consumer_key: 'ck',
        oauth_nonce: 'fixed-nonce',
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: '1700000000',
        oauth_token: 'tok',
        oauth_version: '1.0',
      },
      'cs',
      'ts'
    );
    expect(sig).toBe(
      oauth1Signature(
        'POST',
        'https://api.twitter.com/2/tweets',
        {
          oauth_consumer_key: 'ck',
          oauth_nonce: 'fixed-nonce',
          oauth_signature_method: 'HMAC-SHA1',
          oauth_timestamp: '1700000000',
          oauth_token: 'tok',
          oauth_version: '1.0',
        },
        'cs',
        'ts'
      )
    );
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('builds a sorted OAuth header with signature', () => {
    const header = buildTwitterAuthorizationHeader({
      method: 'POST',
      url: 'https://api.twitter.com/2/tweets',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      accessToken: 'tok',
      accessTokenSecret: 'ts',
    });
    expect(header).toMatch(/^OAuth /);
    expect(header).toContain('oauth_consumer_key="ck"');
    expect(header).toContain('oauth_signature=');
  });
});

describe('YouTube flow (mocked)', () => {
  it('refreshGoogleAccessToken exchanges the refresh token', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: 'ya29.fake' }));
    vi.stubGlobal('fetch', mock);
    const token = await refreshGoogleAccessToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });
    expect(token).toBe('ya29.fake');
    expect(mock.mock.calls[0][0]).toMatch(/oauth2\.googleapis\.com/);
  });

  it('refresh fails cleanly on error payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(400, { error: 'invalid_grant', error_description: 'expired' })
        )
    );
    await expect(
      refreshGoogleAccessToken({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' })
    ).rejects.toThrow(/expired/);
  });

  it('postToYouTube lists then updates the video snippet', async () => {
    const mock = vi
      .fn()
      // token refresh
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'ya29.fake' }))
      // videos.list
      .mockResolvedValueOnce(
        jsonResponse(200, { items: [{ snippet: { categoryId: '27', tags: ['a'] } }] })
      )
      // videos.update
      .mockResolvedValueOnce(jsonResponse(200, { id: 'FAKEVIDEO' }));
    vi.stubGlobal('fetch', mock);
    const id = await postToYouTube({ title: 'New title', description: 'New description' });
    expect(id).toBe('FAKEVIDEO');
    expect(mock).toHaveBeenCalledTimes(3);
    const updateBody = JSON.parse(mock.mock.calls[2][1].body);
    expect(updateBody.snippet.categoryId).toBe('27');
    expect(updateBody.snippet.title).toBe('New title');
  });
});
