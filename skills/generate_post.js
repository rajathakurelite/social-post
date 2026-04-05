/**
 * Skill: generate social copy via Ollama (Gemma).
 * - Single-platform: generatePost(topic, { platform })
 * - Multi-platform pack: one /api/generate call with section markers, parsed for FB / X / LinkedIn / YouTube.
 */
import fetch from 'node-fetch';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

/** @typedef {'facebook' | 'twitter' | 'linkedin' | 'youtube' | 'whatsapp'} Platform */

/**
 * @param {string} topic
 * @param {Platform} platform
 */
function buildPromptForPlatform(topic, platform) {
  const base = `Topic: "${topic}"\nOutput ONLY the post text. No JSON, no markdown fences, no preamble.`;

  switch (platform) {
    case 'twitter':
      return `You are a viral social copywriter for X (Twitter).

Write ONE post (max 280 characters) about ${base}
Hook first, 1–2 emojis max, optional short CTA. Stay under 280 characters.`;

    case 'linkedin':
      return `You are a professional B2B/creator copywriter for LinkedIn.

Write ONE LinkedIn post about ${base}
Use short paragraphs, one clear insight or story, light emoji (optional), end with a question or CTA. Roughly 150–350 words.`;

    case 'youtube':
      return `You are a YouTube strategist.

For ${base}

Return exactly two lines in this format (no other text):
TITLE: [compelling title, max 100 characters]
DESCRIPTION: [2–5 sentences, keywords, 2–4 hashtags at end]`;

    case 'whatsapp':
      return `You are a copywriter for WhatsApp Business broadcast-style messages.

Write ONE message about ${base}
Friendly, conversational, short paragraphs or line breaks for mobile reading.
Include 2–4 tasteful emojis, one clear CTA. Stay under 900 characters. No markdown headings.`;

    case 'facebook':
    default:
      return `You are an expert social media copywriter for Facebook.

Write ONE Facebook post about ${base}

Requirements:
- Start with a strong hook (first line must grab attention).
- Use short paragraphs and natural storytelling (relatable, vivid).
- Include a few relevant emojis (not excessive).
- End with a clear call-to-action (comment, share, follow, or question).
- Tone: authentic, positive, scroll-stopping.
- Length: roughly 80–200 words unless the topic needs slightly more.`;
  }
}

/**
 * One Ollama call → multiple sections delimited by markers (saves latency vs 4 calls).
 */
function buildMultiPlatformPrompt(topic) {
  return `You are an expert multi-platform social copywriter.

Topic: "${topic}"

Produce EXACTLY these sections in order. Each section starts on its own line with the marker in ALL CAPS exactly as shown, followed by a newline, then the content. No JSON, no markdown code blocks, no extra commentary before or after the blocks.

===FACEBOOK===
[Facebook feed post: hook, storytelling, several emojis, CTA. About 80–200 words.]

===TWITTER===
[Single X/Twitter post, MAXIMUM 280 characters including spaces. Punchy hook + CTA.]

===LINKEDIN===
[Professional LinkedIn post: 2–4 short paragraphs, optional light emoji, end with question or CTA. About 150–350 words.]

===YOUTUBE_TITLE===
[One line, max 100 characters, compelling click-worthy title]

===YOUTUBE_DESCRIPTION===
[YouTube description: 2–5 sentences, SEO keywords, end with 2–4 hashtags]

===WHATSAPP===
[WhatsApp text: conversational, mobile-friendly line breaks, 2–4 emojis, CTA. Max ~900 characters.]`;
}

/**
 * Parse ===SECTION=== ... blocks from model output.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseMultiPlatformOutput(raw) {
  const text = String(raw || '').trim();
  const out = {};
  const re = /===\s*([A-Z_]+)\s*===\s*([\s\S]*?)(?=\n===\s*[A-Z_]+\s*===|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    out[key] = m[2].trim();
  }
  return out;
}

function fallbackPack(topic, singleFacebook) {
  const fb = singleFacebook.trim();
  const tw = fb.length > 280 ? `${fb.slice(0, 277)}…` : fb;
  const wa = fb.length > 900 ? `${fb.slice(0, 897)}…` : fb;
  return {
    facebook: fb,
    twitter: tw,
    linkedin: fb,
    youtubeTitle: topic.slice(0, 100),
    youtubeDescription: `${fb}\n\n#content #video`,
    whatsapp: wa,
  };
}

/**
 * @returns {Promise<{ facebook: string, twitter: string, linkedin: string, youtubeTitle: string, youtubeDescription: string, whatsapp: string }>}
 */
export async function generateMultiPlatformPack(topic) {
  if (!topic || !String(topic).trim()) {
    throw new Error('Topic is required for generateMultiPlatformPack()');
  }

  const base = config.ollama.url.replace(/\/$/, '');
  const url = `${base}/api/generate`;

  const body = {
    model: config.ollama.model,
    prompt: buildMultiPlatformPrompt(topic.trim()),
    stream: false,
  };

  logger.info('Calling Ollama /api/generate (multi-platform)', { model: body.model });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Ollama request failed (is Ollama running at ${base}?): ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ollama returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${data?.error || text}`);
  }

  const raw = typeof data.response === 'string' ? data.response : '';
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new Error('Ollama returned an empty response.');
  }

  const sections = parseMultiPlatformOutput(cleaned);
  const facebook = sections.facebook || '';
  const twitter = (sections.twitter || '').replace(/\s+/g, ' ').trim();
  const linkedin = sections.linkedin || '';
  let youtubeTitle = (sections.youtube_title || '').replace(/\n/g, ' ').trim();
  let youtubeDescription = (sections.youtube_description || '').trim();

  if (!facebook || !twitter || !linkedin) {
    logger.info('Multi-platform parse incomplete; running Facebook-only prompt as fallback base');
    const fbOnly = await generatePost(topic, { platform: 'facebook' });
    return fallbackPack(topic, fbOnly);
  }

  if (!youtubeTitle || !youtubeDescription) {
    const yt = await generatePost(topic, { platform: 'youtube' });
    const titleLine = yt.match(/TITLE:\s*(.+)/i);
    const descLine = yt.match(/DESCRIPTION:\s*([\s\S]+)/i);
    youtubeTitle = titleLine ? titleLine[1].trim().slice(0, 100) : topic.slice(0, 100);
    youtubeDescription = descLine ? descLine[1].trim() : `${facebook}\n\n#shorts #video`;
  }

  const twFinal = twitter.length > (config.twitter.maxChars || 280)
    ? `${twitter.slice(0, (config.twitter.maxChars || 280) - 1)}…`
    : twitter;

  let whatsapp = (sections.whatsapp || '').trim();
  if (!whatsapp) {
    whatsapp = facebook.length > 900 ? `${facebook.slice(0, 897)}…` : facebook;
  } else if (whatsapp.length > 4096) {
    whatsapp = `${whatsapp.slice(0, 4093)}…`;
  }

  return {
    facebook,
    twitter: twFinal,
    linkedin,
    youtubeTitle,
    youtubeDescription,
    whatsapp,
  };
}

/**
 * Calls Ollama /api/generate for a single platform.
 * @param {string} topic
 * @param {{ platform?: Platform }} [options]
 * @returns {Promise<string>}
 */
export async function generatePost(topic, options = {}) {
  const platform = options.platform || 'facebook';
  if (!topic || !String(topic).trim()) {
    throw new Error('Topic is required for generatePost()');
  }

  const base = config.ollama.url.replace(/\/$/, '');
  const url = `${base}/api/generate`;

  const body = {
    model: config.ollama.model,
    prompt: buildPromptForPlatform(topic.trim(), platform),
    stream: false,
  };

  logger.info('Calling Ollama /api/generate', { model: body.model, platform });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Ollama request failed (is Ollama running at ${base}?): ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Ollama returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${data?.error || text}`);
  }

  let raw = typeof data.response === 'string' ? data.response : '';
  raw = raw.trim();
  if (!raw) {
    throw new Error('Ollama returned an empty response. Check MODEL name and server logs.');
  }

  if (platform === 'youtube') {
    return raw;
  }

  return raw;
}
