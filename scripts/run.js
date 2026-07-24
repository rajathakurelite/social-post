#!/usr/bin/env node
/**
 * Entry script: topic from CLI → Ollama multi-platform copy → post to selected networks.
 *
 * Usage:
 *   node scripts/run.js "Indian history"
 *   npm start -- "Indian history"
 *   node scripts/run.js --only=facebook,linkedin "Topic here"
 *   node scripts/run.js --dry-run "Topic here"
 *
 * Platforms default from env PLATFORMS=facebook,twitter,linkedin,youtube,whatsapp
 * Dry-run: --dry-run and/or DRY_RUN=1 (generate only; no publish API calls)
 */
import { generateMultiPlatformPack } from '../skills/generate_post.js';
import { postToFacebook } from '../skills/post_facebook.js';
import { postToTwitter } from '../skills/post_twitter.js';
import { postToLinkedIn } from '../skills/post_linkedin.js';
import { postToYouTube } from '../skills/post_youtube.js';
import { postToWhatsApp } from '../skills/post_whatsapp.js';
import {
  config,
  filterEnabledPlatforms,
  hasTwitterConfig,
  assertFacebookConfig,
  assertTwitterConfig,
  assertLinkedInConfig,
  assertYouTubeConfig,
  assertWhatsAppConfig,
} from '../config/config.js';
import { logger } from '../utils/logger.js';

/** @type {Record<string, string>} */
const ENABLED_ENV = {
  facebook: 'FACEBOOK_ENABLED',
  twitter: 'TWITTER_ENABLED',
  linkedin: 'LINKEDIN_ENABLED',
  youtube: 'YOUTUBE_ENABLED',
  whatsapp: 'WHATSAPP_ENABLED',
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const topicParts = [];
  let only = null;
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith('--only=')) {
      only = a.slice('--only='.length);
    } else if (a === '--dry-run' || a === '--dryrun') {
      dryRun = true;
    } else {
      topicParts.push(a);
    }
  }
  return {
    topic: topicParts.join(' ').trim(),
    only: only
      ? only
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : null,
    dryRun: dryRun || config.dryRun,
  };
}

/**
 * @param {string} name
 * @param {() => Promise<string>} fn
 */
async function runPlatform(name, fn) {
  try {
    const id = await fn();
    logger.success(`${name}`, { id });
    return true;
  } catch (e) {
    logger.error(`${name} failed`, e.message || e);
    return false;
  }
}

/**
 * @param {string} text
 * @param {number} max
 */
function preview(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function main() {
  const { topic, only, dryRun } = parseArgs(process.argv.slice(2));
  if (!topic) {
    logger.error('Missing topic. Example: node scripts/run.js "Indian history"');
    logger.info('Optional: --only=facebook,twitter,linkedin,youtube,whatsapp');
    logger.info('Optional: --dry-run (or DRY_RUN=1) to generate without publishing');
    logger.info('Or: npm start -- "your topic here"');
    process.exitCode = 1;
    return;
  }

  const platforms = only?.length ? only : config.platforms;
  const allowed = new Set(['facebook', 'twitter', 'linkedin', 'youtube', 'whatsapp']);
  const candidates = platforms.filter((p) => {
    if (!allowed.has(p)) {
      logger.info(`Ignoring unknown platform: ${p}`);
      return false;
    }
    return true;
  });

  if (!candidates.length) {
    logger.error('No valid platforms selected.');
    process.exitCode = 1;
    return;
  }

  for (const p of candidates) {
    if (config.platformEnabled[p] === false) {
      logger.info(`Skipping ${p}: ${ENABLED_ENV[p]}=false`);
    }
  }

  const selected = filterEnabledPlatforms(candidates);

  if (!selected.length) {
    logger.info('No platforms enabled for this run (all selected networks disabled via *_ENABLED).');
    return;
  }

  logger.info('Starting ai-social-agent run', {
    topic,
    model: config.ollama.model,
    platforms: selected,
    dryRun,
  });

  let pack;
  try {
    pack = await generateMultiPlatformPack(topic);
    logger.success('Generated multi-platform pack', {
      facebookChars: pack.facebook.length,
      twitterChars: pack.twitter.length,
      linkedinChars: pack.linkedin.length,
      whatsappChars: pack.whatsapp.length,
    });
    logger.info('Twitter preview', pack.twitter);
  } catch (e) {
    logger.error('Generation failed', e.message || e);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    logger.info('Dry-run: skipping all publish API calls. Would post:');
    if (selected.includes('facebook')) {
      logger.info('  facebook', { chars: pack.facebook.length, preview: preview(pack.facebook) });
    }
    if (selected.includes('twitter')) {
      logger.info('  twitter', { chars: pack.twitter.length, preview: preview(pack.twitter, 280) });
    }
    if (selected.includes('linkedin')) {
      logger.info('  linkedin', { chars: pack.linkedin.length, preview: preview(pack.linkedin) });
    }
    if (selected.includes('youtube')) {
      logger.info('  youtube', {
        title: pack.youtubeTitle,
        descriptionPreview: preview(pack.youtubeDescription),
      });
    }
    if (selected.includes('whatsapp')) {
      logger.info('  whatsapp', { chars: pack.whatsapp.length, preview: preview(pack.whatsapp) });
    }
    logger.success('Dry-run complete (nothing published)');
    return;
  }

  let anyFailed = false;

  if (selected.includes('facebook')) {
    try {
      assertFacebookConfig();
      const ok = await runPlatform('Facebook Page', () => postToFacebook(pack.facebook));
      if (!ok) anyFailed = true;
    } catch (e) {
      logger.info(`Skipping Facebook: ${e.message}`);
    }
  }

  if (selected.includes('twitter')) {
    if (!hasTwitterConfig()) {
      logger.info('Skipping Twitter: no OAuth credentials (TWITTER_OAUTH2_ACCESS_TOKEN or OAuth 1.0a quartet).');
    } else {
      try {
        assertTwitterConfig();
        const ok = await runPlatform('Twitter / X', () => postToTwitter(pack.twitter));
        if (!ok) anyFailed = true;
      } catch (e) {
        logger.error('Twitter configuration error', e.message || e);
        anyFailed = true;
      }
    }
  }

  if (selected.includes('linkedin')) {
    try {
      assertLinkedInConfig();
      const ok = await runPlatform('LinkedIn', () => postToLinkedIn(pack.linkedin));
      if (!ok) anyFailed = true;
    } catch (e) {
      logger.info(`Skipping LinkedIn: ${e.message}`);
    }
  }

  if (selected.includes('youtube')) {
    try {
      assertYouTubeConfig();
      const ok = await runPlatform('YouTube (video metadata)', () =>
        postToYouTube({
          title: pack.youtubeTitle,
          description: pack.youtubeDescription,
        })
      );
      if (!ok) anyFailed = true;
    } catch (e) {
      logger.info(`Skipping YouTube: ${e.message}`);
    }
  }

  if (selected.includes('whatsapp')) {
    try {
      assertWhatsAppConfig();
      const ok = await runPlatform('WhatsApp', () => postToWhatsApp(pack.whatsapp));
      if (!ok) anyFailed = true;
    } catch (e) {
      logger.info(`Skipping WhatsApp: ${e.message}`);
    }
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

main();
