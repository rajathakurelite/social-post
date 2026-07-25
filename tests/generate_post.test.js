import { describe, it, expect } from 'vitest';
import {
  parseMultiPlatformOutput,
  sanitizeFacebookCaption,
  creativeFromSections,
  defaultFacebookCreative,
} from '../skills/generate_post.js';

describe('parseMultiPlatformOutput', () => {
  it('parses strict ===SECTION=== blocks', () => {
    const raw = [
      '===FACEBOOK===',
      'FB post line 1',
      'line 2',
      '===TWITTER===',
      'Short tweet',
      '===LINKEDIN===',
      'Pro post',
      '===YOUTUBE_TITLE===',
      'Title here',
      '===YOUTUBE_DESCRIPTION===',
      'Desc here',
      '===WHATSAPP===',
      'WA text',
    ].join('\n');
    const out = parseMultiPlatformOutput(raw);
    expect(out.facebook).toBe('FB post line 1\nline 2');
    expect(out.twitter).toBe('Short tweet');
    expect(out.linkedin).toBe('Pro post');
    expect(out.youtube_title).toBe('Title here');
    expect(out.youtube_description).toBe('Desc here');
    expect(out.whatsapp).toBe('WA text');
  });

  it('parses loose Gemma-drift headers (### SECTION: / **SECTION**)', () => {
    const raw = [
      '### FB_CAPTION:',
      'Line one',
      '**FB_HEADLINE** BIG NEWS',
      'TWITTER: tweet body',
    ].join('\n');
    const out = parseMultiPlatformOutput(raw);
    expect(out.fb_caption).toContain('Line one');
    expect(out.fb_headline).toBe('BIG NEWS');
    expect(out.twitter).toBe('tweet body');
  });

  it('returns empty object for empty input', () => {
    expect(parseMultiPlatformOutput('')).toEqual({});
  });
});

describe('sanitizeFacebookCaption', () => {
  it('strips marker scaffolding and caps at 3 lines', () => {
    const messy = [
      '===FB_CAPTION===',
      '**Hook line here 🚀**',
      'FB_HEADLINE: leftover',
      'Brand line for Airepro',
      'Visit: airepro.in',
      'extra line 4 should be dropped',
    ].join('\n');
    const out = sanitizeFacebookCaption(messy);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Hook line here 🚀');
    expect(out).not.toMatch(/FB_HEADLINE/);
  });

  it('handles empty and oversized input safely', () => {
    expect(sanitizeFacebookCaption('')).toBe('');
    const big = 'word '.repeat(2000);
    expect(sanitizeFacebookCaption(big).length).toBeLessThan(5000);
  });
});

describe('creativeFromSections fallbacks', () => {
  it('uses parsed sections when present', () => {
    const creative = creativeFromSections(
      {
        fb_caption: 'Hook\nAirepro line\nVisit: airepro.in',
        fb_headline: 'FIND YOUR DREAM INTERNSHIP',
        fb_accent_word: 'DREAM extra words',
        fb_subhead: 'Career with Airepro',
        fb_body: 'One sentence.',
        fb_cta_label: 'Apply Now',
      },
      'internships'
    );
    expect(creative.headline).toBe('FIND YOUR DREAM INTERNSHIP');
    expect(creative.accentWord).toBe('DREAM');
    expect(creative.ctaLabel).toBe('Apply Now');
    expect(creative.caption).toContain('airepro.in');
  });

  it('falls back to defaults for missing sections and injects the site line', () => {
    const creative = creativeFromSections({ fb_caption: 'Only a hook line' }, 'topic x');
    const d = defaultFacebookCreative('topic x');
    expect(creative.headline).toBe(d.headline);
    expect(creative.caption).toMatch(/airepro\.in/i);
    expect(creative.caption.split('\n')).toHaveLength(3);
  });

  it('defaultFacebookCreative provides all template slots', () => {
    const d = defaultFacebookCreative('anything');
    for (const key of ['caption', 'headline', 'accentWord', 'subhead', 'body', 'ctaLabel']) {
      expect(d[key]).toBeTruthy();
    }
  });
});
