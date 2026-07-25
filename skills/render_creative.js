// @ts-nocheck
/**
 * Skill: render Airepro HTML creative template → PNG via Playwright.
 * Output: output/creatives/{timestamp}.png
 */
/* global window, document -- used inside page.evaluate (browser context) */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { headlineFontSize } from './compose_tools.js';

const VIEWPORT = { width: 1080, height: 1080 };

/** Feature 117: named creative layouts selectable pre-render. */
export const CREATIVE_TEMPLATES = ['classic', 'poster', 'minimal'];

/**
 * Feature 118: brand-safe color theme variants. Every token must resolve to a
 * concrete color string — the unit test asserts no undefined values.
 * @type {Record<string, Record<string, string>>}
 */
export const CREATIVE_THEMES = {
  magenta: {
    '--primary': '#c4007a',
    '--primary-bright': '#e6007e',
    '--deep': '#4a148c',
    '--mid': '#6a1b9a',
    '--soft': '#9c27b0',
    '--accent2': '#ef6c00',
    '--ink': '#1a1a2e',
    '--muted': '#4a4a5a',
    '--bg': '#ffffff',
    '--cta-from': '#3d0a6e',
    '--cta-to': '#7b1fa2',
  },
  violet: {
    '--primary': '#5b21b6',
    '--primary-bright': '#7c3aed',
    '--deep': '#312e81',
    '--mid': '#4c1d95',
    '--soft': '#8b5cf6',
    '--accent2': '#c4007a',
    '--ink': '#191933',
    '--muted': '#4a4a5f',
    '--bg': '#ffffff',
    '--cta-from': '#26205e',
    '--cta-to': '#5b21b6',
  },
  dark: {
    '--primary': '#e6007e',
    '--primary-bright': '#ff4fa3',
    '--deep': '#12081f',
    '--mid': '#6a1b9a',
    '--soft': '#b96be0',
    '--accent2': '#ff9e42',
    '--ink': '#f4ecff',
    '--muted': '#c6b8dd',
    '--bg': '#160b26',
    '--cta-from': '#0c0517',
    '--cta-to': '#4a148c',
  },
};

/**
 * Validate template/theme selections, falling back to the defaults.
 * @param {{ template?: string, theme?: string }} [style]
 * @returns {{ template: string, theme: string }}
 */
export function resolveCreativeStyle(style = {}) {
  const template = CREATIVE_TEMPLATES.includes(String(style.template || '').toLowerCase())
    ? String(style.template).toLowerCase()
    : 'classic';
  const theme = Object.prototype.hasOwnProperty.call(
    CREATIVE_THEMES,
    String(style.theme || '').toLowerCase()
  )
    ? String(style.theme).toLowerCase()
    : 'magenta';
  return { template, theme };
}

/**
 * @typedef {{
 *   headline?: string,
 *   accentWord?: string,
 *   subhead?: string,
 *   body?: string,
 *   ctaLabel?: string,
 *   ctaUrl?: string,
 *   template?: string,
 *   theme?: string,
 * }} CreativeFields
 */

/**
 * @param {CreativeFields} fields
 * @param {{ templatePath?: string, outDir?: string }} [options]
 * @returns {Promise<string>} Absolute path to written PNG
 */
export async function renderCreativePng(fields = {}, options = {}) {
  const templatePath =
    options.templatePath || path.join(config.rootDir, 'templates', 'airepro-internship.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Creative template missing: ${templatePath}`);
  }

  const outDir = options.outDir || path.join(config.rootDir, 'output', 'creatives');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}.png`);

  const fileUrl = pathToFileURL(templatePath).href;
  const ctaUrl =
    fields.ctaUrl || config.brand.internshipsUrl || 'https://airepro.in/view/internships';

  const style = resolveCreativeStyle(fields);
  const baseHeadlineSize =
    style.template === 'poster' ? 88 : style.template === 'minimal' ? 72 : 54;
  const headlinePx = headlineFontSize(String(fields.headline || ''), {
    base: baseHeadlineSize,
    min: 30,
  });

  logger.info('Rendering creative PNG', {
    template: path.basename(templatePath),
    layout: style.template,
    theme: style.theme,
    outPath,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });

    await page.goto(fileUrl, { waitUntil: 'networkidle' });

    await page.evaluate(
      (f) => {
        if (typeof window.__applyCreative === 'function') {
          window.__applyCreative(f);
        }
      },
      {
        headline: fields.headline,
        accent: fields.accentWord,
        accentWord: fields.accentWord,
        subhead: fields.subhead,
        body: fields.body,
        ctaLabel: fields.ctaLabel,
        ctaUrl,
        template: style.template,
        theme: style.theme,
        themeVars: CREATIVE_THEMES[style.theme],
        headlineFontPx: headlinePx,
      }
    );

    // Wait for Google Fonts / images
    await page.waitForTimeout(400);

    // Feature 169: warn when brand fonts unavailable (do not throw).
    try {
      const missing = await page.evaluate(() => {
        const wanted = ['Fraunces', 'Sora', 'Montserrat'];
        /** @type {string[]} */
        const out = [];
        for (const family of wanted) {
          try {
            if (document.fonts && !document.fonts.check(`16px "${family}"`)) out.push(family);
          } catch {
            out.push(family);
          }
        }
        return out;
      });
      for (const f of missing || []) {
        logger.warn('Creative font fallback', { font: f, warning: `Font unavailable: ${f}` });
      }
      // stash for unit tests / callers that read lastFontWarnings
      renderCreativePng.lastFontWarnings = (missing || []).map(
        (f) => `Font unavailable: ${f} — creative may use fallback`
      );
    } catch {
      renderCreativePng.lastFontWarnings = [];
    }

    const el = page.locator('#creative');
    await el.screenshot({ path: outPath, type: 'png' });
  } catch (e) {
    const tip = /Executable doesn't exist|browserType\.launch/i.test(String(e.message || e))
      ? ' Run `npx playwright install chromium` then retry.'
      : '';
    throw new Error(`Creative render failed: ${e.message || e}.${tip}`);
  } finally {
    if (browser) await browser.close();
  }

  if (!fs.existsSync(outPath)) {
    throw new Error(`PNG was not written: ${outPath}`);
  }

  logger.success('Creative PNG written', { path: outPath });
  return outPath;
}

/**
 * Feature 169: probe font availability without throwing (unit-testable).
 * @param {{ check: (q: string) => boolean } | null} fontsApi
 * @param {string[]} [families]
 * @returns {string[]} warning strings
 */
export function checkCreativeFonts(fontsApi, families = ['Fraunces', 'Sora']) {
  /** @type {string[]} */
  const warnings = [];
  for (const family of families) {
    let ok = false;
    try {
      ok = Boolean(fontsApi && fontsApi.check(`16px "${family}"`));
    } catch {
      ok = false;
    }
    if (!ok) warnings.push(`Font unavailable: ${family} — creative may use fallback`);
  }
  return warnings;
}
