import { describe, it, expect } from 'vitest';
import {
  countEmojis,
  lintCaption,
  lintLineLength,
  lintBannedWords,
  lintHandles,
  lintUrls,
  hookScore,
  readingLevel,
  brandPresence,
  lintAll,
} from '../skills/content_lint.js';

const DEFAULT_BANNED = [
  'guaranteed placement',
  '100% job',
  'get rich',
  'no experience needed!!!',
  'lottery',
];

describe('countEmojis', () => {
  it('counts pictographs', () => {
    expect(countEmojis('No emoji here')).toBe(0);
    expect(countEmojis('🚀🚀🚀🚀🚀')).toBe(5);
  });
});

describe('lintCaption (feature 128)', () => {
  it("flags all three codes for 'GREAT!!! 🚀🚀🚀🚀🚀'", () => {
    const { warnings } = lintCaption('GREAT!!! 🚀🚀🚀🚀🚀');
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('EMOJI_OVERLOAD');
    expect(codes).toContain('ALL_CAPS');
    expect(codes).toContain('TRIPLE_EXCLAIM');
    for (const w of warnings) {
      expect(typeof w.message).toBe('string');
      expect(w.message.length).toBeGreaterThan(0);
    }
  });

  it('passes normal copy', () => {
    const { warnings } = lintCaption(
      'We just opened new internship roles at Airepro. Apply today! 🚀'
    );
    expect(warnings).toEqual([]);
  });

  it('flags three consecutive all-caps words inside a mixed sentence', () => {
    const { warnings } = lintCaption('This is APPLY RIGHT NOW territory.');
    expect(warnings.map((w) => w.code)).toContain('ALL_CAPS');
  });

  it('ignores short acronyms and the brand name', () => {
    expect(lintCaption('Add a clear CTA for AIREPRO followers.').warnings).toEqual([]);
  });
});

describe('lintLineLength (feature 139)', () => {
  it('flags a 120-char line and passes a 60-char line', () => {
    const text = ['x'.repeat(60), 'y'.repeat(120), 'z'.repeat(90)].join('\n');
    const { longLines } = lintLineLength(text);
    expect(longLines).toEqual([{ index: 1, length: 120 }]);
  });
});

describe('lintBannedWords (feature 141)', () => {
  it('matches single words on word boundaries, phrases as substrings', () => {
    expect(lintBannedWords('Win the LOTTERY today', DEFAULT_BANNED).hits).toEqual(['lottery']);
    expect(lintBannedWords('We offer Guaranteed Placement to all', DEFAULT_BANNED).hits).toEqual([
      'guaranteed placement',
    ]);
    expect(lintBannedWords('lotteryville is a town', DEFAULT_BANNED).hits).toEqual([]);
    expect(lintBannedWords('Clean honest copy about internships', DEFAULT_BANNED).hits).toEqual([]);
  });
});

describe('lintHandles (feature 142)', () => {
  it('flags @airpro and passes @airepro with the default allowlist', () => {
    expect(lintHandles('Ping @airpro for details', ['@airepro']).unknown).toEqual(['@airpro']);
    expect(lintHandles('Ping @airepro for details', ['@airepro']).unknown).toEqual([]);
  });

  it('accepts allowlist entries without a leading @, case-insensitively', () => {
    expect(lintHandles('Follow @AIREPRO now', ['airepro']).unknown).toEqual([]);
  });
});

describe('lintUrls (feature 143)', () => {
  it("flags 'htp://airepro,in'", () => {
    const { invalid } = lintUrls('Apply at htp://airepro,in today');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].url).toContain('htp://airepro,in');
    expect(invalid[0].reason).toBeTruthy();
  });

  it('passes a plain https airepro URL', () => {
    expect(lintUrls('Apply at https://airepro.in/view/internships').invalid).toEqual([]);
  });

  it('flags http as non-https', () => {
    const { invalid } = lintUrls('See http://airepro.in for more');
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toMatch(/https/);
  });

  it('flags https URLs with a comma or dotless hostname', () => {
    expect(lintUrls('Bad https://airepro,in link').invalid).toHaveLength(1);
    expect(lintUrls('Bad https://localhost link').invalid).toHaveLength(1);
  });
});

describe('hookScore (feature 144)', () => {
  it('is deterministic for a fixed input', () => {
    const input = 'Want a dream internship in 2026? 🚀';
    expect(hookScore(input)).toEqual(hookScore(input));
  });

  it('scores a strong hook higher than a weak one', () => {
    const strong = hookScore('Want a dream internship in 2026? 🚀');
    const weak = hookScore('hello');
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.factors).toEqual(
      expect.arrayContaining(['length', 'question', 'number', 'emoji', 'opener'])
    );
    expect(weak.factors).toEqual([]);
  });

  it('clamps to 0–100', () => {
    const { score } = hookScore('Want 5 offers? Ready in 2026? 🚀🚀');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('readingLevel (feature 145)', () => {
  it('simple short-word copy lands in easy', () => {
    const { band } = readingLevel('The cat sat. The dog ran. We had fun. It was a good day.');
    expect(band).toBe('easy');
  });

  it('dense academic copy lands in medium or hard', () => {
    const { band } = readingLevel(
      'The organizational implementation of multidisciplinary internship methodologies ' +
        'necessitates comprehensive institutional collaboration and administrative accountability.'
    );
    expect(['medium', 'hard']).toContain(band);
  });

  it('is deterministic', () => {
    const sample = 'Airepro helps students find internships fast.';
    expect(readingLevel(sample)).toEqual(readingLevel(sample));
  });
});

describe('brandPresence (feature 146)', () => {
  it('flags a card with neither brand name nor site URL', () => {
    expect(brandPresence('Just a generic caption about work')).toEqual({
      present: false,
      hasName: false,
      hasLink: false,
    });
  });

  it('either the name or the link passes (case-insensitive)', () => {
    expect(brandPresence('Proudly built by AIREPRO students').present).toBe(true);
    expect(brandPresence('Apply at https://AIREPRO.IN/view/internships')).toMatchObject({
      present: true,
      hasLink: true,
    });
  });
});

describe('lintAll (feature 141 publish block)', () => {
  it('a banned word sets blocked', () => {
    const res = lintAll('We offer guaranteed placement for every student!', {
      banned: DEFAULT_BANNED,
      handleAllowlist: ['@airepro'],
    });
    expect(res.bannedHits).toEqual(['guaranteed placement']);
    expect(res.blocked).toBe(true);
  });

  it('clean copy is not blocked and aggregates every lint', () => {
    const res = lintAll(
      'Fresh internship drive from @airepro: https://airepro.in/view/internships',
      {
        banned: DEFAULT_BANNED,
        handleAllowlist: ['@airepro'],
      }
    );
    expect(res.blocked).toBe(false);
    expect(res.bannedHits).toEqual([]);
    expect(res.unknownHandles).toEqual([]);
    expect(res.invalidUrls).toEqual([]);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
});
