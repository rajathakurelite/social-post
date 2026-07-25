import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchWithTimeout, fetchWithRetry, isRetryableStatus } from '../utils/http_fetch.js';

/** Minimal Response-like stub. */
function fakeResponse(status, { retryAfter = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('fetchWithRetry (mocked fetch, no network)', () => {
  it('retries a 500 then returns the success response', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(500, { retryAfter: '0' }))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithRetry('http://test.local/x', {}, { retries: 1, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable statuses (400)', async () => {
    const mock = vi.fn().mockResolvedValue(fakeResponse(400));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithRetry('http://test.local/x', {}, { retries: 3, timeoutMs: 1000 });
    expect(res.status).toBe(400);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('honors retry-after header on 429', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(429, { retryAfter: '0' }))
      .mockResolvedValueOnce(fakeResponse(200));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithRetry('http://test.local/x', {}, { retries: 2, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('retries network errors and surfaces the last one when exhausted', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED test'));
    vi.stubGlobal('fetch', mock);
    await expect(
      fetchWithRetry('http://test.local/x', {}, { retries: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(mock).toHaveBeenCalledTimes(2);
  }, 10000);

  it('returns the last retryable response when attempts are exhausted', async () => {
    const mock = vi.fn().mockResolvedValue(fakeResponse(503, { retryAfter: '0' }));
    vi.stubGlobal('fetch', mock);
    const res = await fetchWithRetry('http://test.local/x', {}, { retries: 1, timeoutMs: 1000 });
    expect(res.status).toBe(503);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWithTimeout (mocked fetch, no network)', () => {
  it('aborts and reports a timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
            );
          })
      )
    );
    await expect(fetchWithTimeout('http://test.local/slow', {}, 50)).rejects.toThrow(
      /timed out after 50ms/
    );
  });

  it('passes through non-abort errors unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    await expect(fetchWithTimeout('http://test.local/x', {}, 1000)).rejects.toThrow('boom');
  });
});
