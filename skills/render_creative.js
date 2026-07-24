/**
 * Skill: render Airepro HTML creative template → PNG via Playwright.
 * Output: output/creatives/{timestamp}.png
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const VIEWPORT = { width: 1080, height: 1080 };

/**
 * @typedef {{
 *   headline?: string,
 *   accentWord?: string,
 *   subhead?: string,
 *   body?: string,
 *   ctaLabel?: string,
 *   ctaUrl?: string,
 * }} CreativeFields
 */

/**
 * @param {CreativeFields} fields
 * @param {{ templatePath?: string, outDir?: string }} [options]
 * @returns {Promise<string>} Absolute path to written PNG
 */
export async function renderCreativePng(fields = {}, options = {}) {
  const templatePath =
    options.templatePath ||
    path.join(config.rootDir, 'templates', 'airepro-internship.html');

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Creative template missing: ${templatePath}`);
  }

  const outDir = options.outDir || path.join(config.rootDir, 'output', 'creatives');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `${stamp}.png`);

  const fileUrl = pathToFileURL(templatePath).href;
  const ctaUrl =
    fields.ctaUrl ||
    config.brand.internshipsUrl ||
    'https://airepro.in/view/internships';

  logger.info('Rendering creative PNG', { template: path.basename(templatePath), outPath });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
    });

    await page.goto(fileUrl, { waitUntil: 'networkidle' });

    await page.evaluate((f) => {
      if (typeof window.__applyCreative === 'function') {
        window.__applyCreative(f);
      }
    }, {
      headline: fields.headline,
      accent: fields.accentWord,
      accentWord: fields.accentWord,
      subhead: fields.subhead,
      body: fields.body,
      ctaLabel: fields.ctaLabel,
      ctaUrl,
    });

    // Wait for Google Fonts / images
    await page.waitForTimeout(400);

    const el = page.locator('#creative');
    await el.screenshot({ path: outPath, type: 'png' });
  } catch (e) {
    const tip =
      /Executable doesn't exist|browserType\.launch/i.test(String(e.message || e))
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
