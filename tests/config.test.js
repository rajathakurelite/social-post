import { describe, it, expect, afterEach, vi } from 'vitest';
import { isEnabled, filterEnabledPlatforms, config } from '../config/config.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isEnabled flag parsing', () => {
  it('unset means enabled', () => {
    vi.stubEnv('TEST_FLAG_X', '');
    expect(isEnabled('TEST_FLAG_X')).toBe(true);
    expect(isEnabled('NEVER_SET_FLAG_ZZZ')).toBe(true);
  });

  it('false/0/no/off disable (case-insensitive)', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', 'Off']) {
      vi.stubEnv('TEST_FLAG_X', v);
      expect(isEnabled('TEST_FLAG_X')).toBe(false);
    }
  });

  it('any other value stays enabled', () => {
    for (const v of ['true', '1', 'yes', 'banana']) {
      vi.stubEnv('TEST_FLAG_X', v);
      expect(isEnabled('TEST_FLAG_X')).toBe(true);
    }
  });
});

describe('platformEnabled + filterEnabledPlatforms', () => {
  it('filters platforms disabled via *_ENABLED at load time', async () => {
    vi.resetModules();
    vi.stubEnv('TWITTER_ENABLED', 'false');
    vi.stubEnv('WHATSAPP_ENABLED', '0');
    const fresh = await import('../config/config.js');
    expect(fresh.config.platformEnabled.twitter).toBe(false);
    expect(fresh.config.platformEnabled.whatsapp).toBe(false);
    expect(fresh.config.platformEnabled.facebook).toBe(true);
    expect(fresh.filterEnabledPlatforms(['facebook', 'twitter', 'linkedin', 'whatsapp'])).toEqual([
      'facebook',
      'linkedin',
    ]);
  });

  it('current process config has sane defaults from test setup', () => {
    expect(config.dryRun).toBe(true);
    expect(config.facebook.postMode).toBe('text');
    expect(filterEnabledPlatforms(['facebook'])).toContain('facebook');
  });
});
