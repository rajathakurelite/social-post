import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PLATFORM_LIMITS,
  charStatus,
  slugify,
  applyUtm,
  appendHashtags,
  splitThread,
  generateChapterHints,
  validateChapterLines,
  capYoutubeTags,
  suggestYoutubeTags,
  suggestAltText,
  expandLinkSlugs,
  packToMarkdown,
  safePackFilename,
  normalizeTopic,
  topicsSimilar,
  headlineFontSize,
  cropRect,
  failedPlatforms,
  validateScheduleTime,
} from '../skills/compose_tools.js';
import {
  loadHashtagPacks,
  loadContentLintConfig,
  loadLinkSlugs,
  loadBestTimes,
} from '../skills/compose_config.js';

describe('charStatus (feature 129)', () => {
  it('over flips exactly at each platform cap', () => {
    const caps = [
      ['twitter', 280],
      ['linkedin', 3000],
      ['whatsapp', 900],
      ['youtubeTitle', 100],
    ];
    for (const [platform, cap] of caps) {
      const atCap = charStatus(platform, 'x'.repeat(cap));
      expect(atCap).toEqual({ count: cap, limit: cap, over: false });
      const overCap = charStatus(platform, 'x'.repeat(cap + 1));
      expect(overCap).toEqual({ count: cap + 1, limit: cap, over: true });
    }
  });

  it('unknown platform yields null limit and never over', () => {
    expect(charStatus('myspace', 'x'.repeat(9999))).toEqual({
      count: 9999,
      limit: null,
      over: false,
    });
  });
});

describe('slugify', () => {
  it('lowercases, hyphenates, collapses, trims', () => {
    expect(slugify('  July -- Drive 2026!  ')).toBe('july-drive-2026');
    expect(slugify('***')).toBe('');
  });
});

describe('applyUtm (features 112/113)', () => {
  const opts = { platform: 'twitter', campaign: 'July Drive' };

  it('tags a fresh airepro.in URL with both params', () => {
    const out = applyUtm('Apply at https://airepro.in/view/internships now', opts);
    expect(out).toContain(
      'https://airepro.in/view/internships?utm_source=twitter&utm_campaign=july-drive'
    );
  });

  it('appends with & when the URL already has a query', () => {
    const out = applyUtm('See https://airepro.in/view/internships?ref=fb today', opts);
    expect(out).toContain('?ref=fb&utm_source=twitter&utm_campaign=july-drive');
  });

  it('does not double-tag an already-utm-tagged URL', () => {
    const text = 'Go https://airepro.in/x?utm_source=old&utm_campaign=past now';
    expect(applyUtm(text, opts)).toBe(text);
  });

  it('leaves non-airepro URLs untouched', () => {
    const text = 'Read https://example.com/blog?x=1 today';
    expect(applyUtm(text, opts)).toBe(text);
  });

  it('disabled or empty campaign returns input unchanged', () => {
    const text = 'Apply at https://airepro.in/view/internships now';
    expect(applyUtm(text, { ...opts, enabled: false })).toBe(text);
    expect(applyUtm(text, { platform: 'twitter', campaign: '' })).toBe(text);
  });

  it('keeps trailing punctuation out of the URL', () => {
    const out = applyUtm('Visit https://airepro.in/view/internships.', opts);
    expect(out).toBe(
      'Visit https://airepro.in/view/internships?utm_source=twitter&utm_campaign=july-drive.'
    );
  });
});

describe('appendHashtags (feature 111)', () => {
  it('appends tags on a new line within the platform limit', () => {
    const out = appendHashtags('Join us today', ['internship', '#Careers'], 'twitter');
    expect(out).toBe('Join us today\n#internship #Careers');
  });

  it('drops (never truncates) tags that would overflow twitter 280', () => {
    const base = 'x'.repeat(270);
    const out = appendHashtags(base, ['#hire', '#internships2026'], 'twitter');
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out).toBe(base + '\n#hire');
    expect(out).not.toContain('#internships2026');
  });

  it('returns text unchanged when no tag fits', () => {
    const base = 'x'.repeat(279);
    expect(appendHashtags(base, ['#internship'], 'twitter')).toBe(base);
  });

  it('skips tags already present (case-insensitive)', () => {
    const out = appendHashtags('Loving #Internship life', ['#internship', 'careers'], 'twitter');
    expect(out).toBe('Loving #Internship life\n#careers');
  });
});

describe('splitThread (features 121/122)', () => {
  const sentence = 'Airepro connects students with real internships across India every week. ';
  const longText = sentence.repeat(9).trim(); // ~650 chars

  it('short text returns a single element with no suffix', () => {
    expect(splitThread('Just one short tweet.')).toEqual(['Just one short tweet.']);
  });

  it('600+ char text splits so no part exceeds 280 including the n/m suffix', () => {
    const parts = splitThread(longText, 280);
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(280);
      expect(part).toMatch(/ \d+\/\d+$/);
    }
    const total = parts.length;
    parts.forEach((part, i) => {
      expect(part.endsWith(` ${i + 1}/${total}`)).toBe(true);
    });
  });

  it('is deterministic', () => {
    expect(splitThread(longText, 280)).toEqual(splitThread(longText, 280));
  });
});

describe('YouTube chapters (feature 123)', () => {
  const description =
    'First we walk through resume basics. Then we cover interview prep in depth. ' +
    'Next we discuss stipend negotiation. Finally we share alumni success stories.';

  it('generates lines matching the timestamp regex, strictly increasing', () => {
    const lines = generateChapterHints(description, 6);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toBe('00:00 Intro');
    for (const line of lines) {
      expect(line).toMatch(/^\d{2}:\d{2}\s+\S/);
    }
    expect(validateChapterLines(lines)).toBe(true);
    expect(generateChapterHints(description, 6)).toEqual(lines);
  });

  it('returns [] for empty description', () => {
    expect(generateChapterHints('')).toEqual([]);
    expect(generateChapterHints('   ')).toEqual([]);
  });

  it('validateChapterLines rejects out-of-order and malformed lines', () => {
    expect(validateChapterLines(['00:00 Intro', '02:00 Mid', '01:00 Back'])).toBe(false);
    expect(validateChapterLines(['00:00 Intro', '00:00 Same'])).toBe(false);
    expect(validateChapterLines(['0:00 Intro'])).toBe(false);
    expect(validateChapterLines(['00:00 '])).toBe(false);
  });
});

describe('capYoutubeTags / suggestYoutubeTags (feature 124)', () => {
  it('caps the joined output at 500 chars for a long tag list', () => {
    const tags = Array.from({ length: 60 }, (_, i) => `internship opportunity number ${i}`);
    const out = capYoutubeTags(tags);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.length).toBeGreaterThan(0);
  });

  it('dedupes case-insensitively and trims entries', () => {
    expect(capYoutubeTags([' Internship ', 'internship', 'INTERNSHIP', 'career'])).toBe(
      'Internship, career'
    );
  });

  it('accepts a comma-separated string', () => {
    expect(capYoutubeTags('a, b , a ,')).toBe('a, b');
  });

  it('suggestYoutubeTags pulls hashtags and topic words, then caps via capYoutubeTags', () => {
    const out = suggestYoutubeTags(
      'Learn #Internships and #Careers at Airepro',
      'Remote Summer Internship Guide'
    );
    expect(out.toLowerCase()).toContain('internships');
    expect(out.toLowerCase()).toContain('airepro');
    expect(out.length).toBeLessThanOrEqual(500);
  });
});

describe('suggestAltText (feature 127)', () => {
  it('strips emojis and URLs from the first non-empty line', () => {
    const caption =
      '\nKickstart your career 🚀 today at https://airepro.in/view/internships!\nMore below.';
    const out = suggestAltText(caption);
    expect(out).toBe('Kickstart your career today at');
    expect(out).not.toMatch(/https?:/);
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('caps output at 125 chars', () => {
    expect(suggestAltText('word '.repeat(60)).length).toBeLessThanOrEqual(125);
  });
});

describe('expandLinkSlugs (feature 134)', () => {
  const slugMap = { intern: 'https://airepro.in/view/internships' };

  it('replaces a known slug (with or without https:// prefix)', () => {
    expect(expandLinkSlugs('Apply: airepro.in/go/intern', slugMap)).toBe(
      'Apply: https://airepro.in/view/internships'
    );
    expect(expandLinkSlugs('Apply: https://airepro.in/go/intern', slugMap)).toBe(
      'Apply: https://airepro.in/view/internships'
    );
  });

  it('leaves unknown slugs untouched', () => {
    const text = 'Apply: airepro.in/go/mystery';
    expect(expandLinkSlugs(text, slugMap)).toBe(text);
  });
});

describe('packToMarkdown (feature 149)', () => {
  const posts = {
    facebook: { text: 'FB copy' },
    twitter: { text: 'Tweet copy' },
    youtube: { title: 'Video title', description: 'Video description' },
    whatsapp: { text: 'WA copy' },
  };

  it('contains one ## section per selected platform', () => {
    const md = packToMarkdown({
      topic: 'Internship drive',
      posts,
      platforms: ['facebook', 'twitter', 'youtube'],
    });
    expect(md.startsWith('# Internship drive')).toBe(true);
    expect(md).toContain('## facebook');
    expect(md).toContain('## twitter');
    expect(md).toContain('## youtube');
    expect(md).not.toContain('## whatsapp');
    expect(md.match(/^## /gm)).toHaveLength(3);
    expect(md).toContain('Video title');
    expect(md).toContain('Video description');
  });
});

describe('safePackFilename (feature 150)', () => {
  const date = new Date(2026, 6, 25);

  it('produces a Windows-safe filename for a nasty topic', () => {
    const name = safePackFilename('Q4: "Launch" <intern/ship>?*', date);
    expect(name).toBe('q4-launch-intern-ship-2026-07-25.md');
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
    expect(name).not.toMatch(/[. ]\.md$/);
  });

  it('falls back to "pack" for an empty slug and caps at 60 chars', () => {
    expect(safePackFilename('***', date)).toBe('pack-2026-07-25.md');
    const long = safePackFilename('word '.repeat(40), date);
    expect(long.replace(/-2026-07-25\.md$/, '').length).toBeLessThanOrEqual(60);
  });
});

describe('topicsSimilar (feature 115)', () => {
  it('matches case/whitespace/punctuation variants of the same topic', () => {
    expect(topicsSimilar('Internship Tips 2026', '  internship,  TIPS: 2026! ')).toBe(true);
    expect(normalizeTopic('  Hello,   World! ')).toBe('hello world');
  });

  it('matches high word-overlap variants (Jaccard >= 0.8)', () => {
    expect(
      topicsSimilar('best summer internship tips 2026', 'best summer internship tips 2026 guide')
    ).toBe(true);
  });

  it('does not match unrelated topics', () => {
    expect(topicsSimilar('AI internships in Bangalore', 'Weekend cooking recipes')).toBe(false);
  });
});

describe('headlineFontSize (feature 138)', () => {
  it('returns base for a short headline', () => {
    expect(headlineFontSize('Short headline')).toBe(54);
  });

  it('60-char headline shrinks below base but stays >= min', () => {
    const size = headlineFontSize('x'.repeat(60));
    expect(size).toBeGreaterThanOrEqual(30);
    expect(size).toBeLessThan(54);
  });

  it('is deterministic and floors at min', () => {
    expect(headlineFontSize('x'.repeat(500))).toBe(30);
    expect(headlineFontSize('x'.repeat(60))).toBe(headlineFontSize('x'.repeat(60)));
  });
});

describe('cropRect (feature 137)', () => {
  const presets = [
    ['1:1', 1],
    ['4:5', 0.8],
    ['1.91:1', 1.91],
  ];

  it('each preset on 1080x1350 yields centered dims matching the ratio ±1px', () => {
    for (const [preset, ratio] of presets) {
      const rect = cropRect(1080, 1350, preset);
      expect(rect).not.toBeNull();
      expect(rect.width).toBeLessThanOrEqual(1080);
      expect(rect.height).toBeLessThanOrEqual(1350);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1080);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1350);
      expect(Math.abs(rect.width - rect.height * ratio)).toBeLessThanOrEqual(1);
      for (const v of [rect.x, rect.y, rect.width, rect.height]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('returns null for invalid input', () => {
    expect(cropRect(0, 100, '1:1')).toBeNull();
    expect(cropRect(100, 100, 'square')).toBeNull();
    expect(cropRect(100, 100, -2)).toBeNull();
    expect(cropRect(NaN, 100, '1:1')).toBeNull();
  });
});

describe('failedPlatforms (feature 147)', () => {
  it('returns only ok:false platforms', () => {
    const results = [
      { platform: 'facebook', ok: true, id: '1' },
      { platform: 'twitter', ok: false, error: 'rate limit' },
      { platform: 'linkedin', ok: false, error: 'token' },
      { platform: 'whatsapp', ok: true },
    ];
    expect(failedPlatforms(results)).toEqual(['twitter', 'linkedin']);
    expect(failedPlatforms([])).toEqual([]);
  });
});

describe('validateScheduleTime (feature 106)', () => {
  const now = new Date('2026-07-25T10:00:00Z');

  it('rejects a past datetime', () => {
    const res = validateScheduleTime('2026-07-25T09:00:00Z', now);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('rejects less than 60 seconds ahead and unparseable input', () => {
    expect(validateScheduleTime('2026-07-25T10:00:30Z', now).ok).toBe(false);
    expect(validateScheduleTime('not-a-date', now).ok).toBe(false);
  });

  it('accepts +1 hour', () => {
    expect(validateScheduleTime('2026-07-25T11:00:00Z', now)).toEqual({ ok: true });
  });
});

describe('compose_config loaders (features 110/135)', () => {
  const tmpFiles = [];
  afterAll(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
  });

  it('loadHashtagPacks throws naming the pack id when a pack has >30 tags', () => {
    const tmp = path.join(os.tmpdir(), `hashtag-packs-over30-${Date.now()}.json`);
    tmpFiles.push(tmp);
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        packs: [
          {
            id: 'toomany',
            name: 'Too many',
            tags: Array.from({ length: 31 }, (_, i) => `#tag${i}`),
          },
        ],
      })
    );
    expect(() => loadHashtagPacks(tmp)).toThrow(/toomany/);
  });

  it('loads the real hashtag packs config fine', () => {
    const packs = loadHashtagPacks();
    expect(packs.map((p) => p.id)).toEqual(['internships', 'freelance', 'career']);
    for (const pack of packs) {
      expect(pack.tags.length).toBeGreaterThanOrEqual(6);
      expect(pack.tags.length).toBeLessThanOrEqual(30);
      expect(pack.perPlatformMax).toEqual({ twitter: 3, linkedin: 5 });
    }
  });

  it('loadBestTimes has an entry for all five platforms', () => {
    const hints = loadBestTimes();
    for (const platform of ['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp']) {
      expect(typeof hints[platform]).toBe('string');
      expect(hints[platform].length).toBeGreaterThan(0);
    }
  });

  it('loaders tolerate missing files with sane defaults', () => {
    const missing = path.join(os.tmpdir(), `definitely-missing-${Date.now()}.json`);
    expect(loadHashtagPacks(missing)).toEqual([]);
    expect(loadContentLintConfig(missing)).toEqual({ bannedWords: [], handleAllowlist: [] });
    expect(loadLinkSlugs(missing)).toEqual({});
    expect(Object.keys(loadBestTimes(missing))).toEqual(
      expect.arrayContaining(['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp'])
    );
  });

  it('real content lint / link slug configs load with expected shapes', () => {
    const lint = loadContentLintConfig();
    expect(lint.bannedWords).toContain('lottery');
    expect(lint.handleAllowlist).toContain('@airepro');
    const slugs = loadLinkSlugs();
    expect(slugs.intern).toBe('https://airepro.in/view/internships');
  });
});

describe('PLATFORM_LIMITS contract', () => {
  it('exposes the agreed limits', () => {
    expect(PLATFORM_LIMITS).toEqual({
      facebook: 63206,
      twitter: 280,
      linkedin: 3000,
      whatsapp: 900,
      youtubeTitle: 100,
      youtubeDescription: 5000,
    });
  });
});
