/**
 * Skill: generate social copy via Ollama (Gemma).
 * - Single-platform: generatePost(topic, { platform })
 * - Multi-platform pack: one /api/generate call with section markers, parsed for FB / X / LinkedIn / YouTube.
 * - Facebook visual mode: structured creative fields (caption + template slots).
 * Brand brief from config.brand is injected so topics are angles within the brand (default: Airepro).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/http_fetch.js';

/** @typedef {'facebook' | 'twitter' | 'linkedin' | 'youtube' | 'whatsapp'} Platform */

/**
 * @typedef {{
 *   caption: string,
 *   headline: string,
 *   accentWord: string,
 *   subhead: string,
 *   body: string,
 *   ctaLabel: string,
 * }} FacebookCreativeFields
 */

/**
 * Shared brand + topic-angle block prepended to every prompt.
 * @param {string} topic
 */
function brandContextBlock(topic) {
  const b = config.brand;
  return `BRAND CONTEXT (follow strictly):
${b.briefText}

Website / primary CTA: ${b.website}
Internships CTA: ${b.internshipsUrl}
Brand name: ${b.name}

The CLI topic below is an ANGLE within this brand — write copy for ${b.name}, not a generic post about an unrelated subject.

Topic angle: "${topic}"`;
}

function isFacebookVisualMode() {
  return config.facebook.postMode !== 'text';
}

/**
 * Default creative fields when the model omits sections.
 * @param {string} topic
 * @returns {FacebookCreativeFields}
 */
export function defaultFacebookCreative(topic) {
  const site = config.brand.website.replace(/\/$/, '');
  return {
    caption: [
      'Find Your Dream Internship 🚀',
      `Start Building Your Career Today with ${config.brand.name}`,
      `Visit: ${site}`,
    ].join('\n'),
    headline: 'FIND YOUR DREAM INTERNSHIP',
    accentWord: 'DREAM',
    subhead: `Start Building Your Career Today with ${config.brand.name}`,
    body: 'Explore verified internships and opportunities that help you learn, grow and take the next step in your career.',
    ctaLabel: 'Explore Internships Now',
  };
}

/**
 * @param {string} topic
 * @param {Platform} platform
 */
function buildPromptForPlatform(topic, platform) {
  const brand = brandContextBlock(topic);
  const brandName = config.brand.name;
  const site = config.brand.website;
  const outputOnly = `Output ONLY the post text. No JSON, no markdown fences, no preamble.`;

  switch (platform) {
    case 'twitter':
      return `You write social copy for ${brandName} on X (Twitter).

${brand}

Write ONE post (max 280 characters). Must be clearly about ${brandName} (internships/freelance). Include ${site} if space allows; otherwise still name ${brandName}. Hook first, 1–2 emojis max, optional short CTA. Stay under 280 characters.

${outputOnly}`;

    case 'linkedin':
      return `You write professional LinkedIn copy for ${brandName}.

${brand}

Write ONE LinkedIn post. Always name ${brandName}; include ${site} as a CTA. Stay on internships/freelance/career opportunities. Use short paragraphs, one clear insight, light emoji (optional), end with a question or CTA. Roughly 150–350 words.

${outputOnly}`;

    case 'youtube':
      return `You write YouTube metadata for ${brandName}.

${brand}

Return exactly two lines in this format (no other text):
TITLE: [compelling title mentioning ${brandName} when natural, max 100 characters]
DESCRIPTION: [2–5 sentences about the angle for ${brandName}, include ${site}, keywords, 2–4 hashtags at end]`;

    case 'whatsapp':
      return `You write WhatsApp Business broadcast-style messages for ${brandName}.

${brand}

Write ONE message. Always name ${brandName}; include ${site}. Friendly, conversational, short paragraphs or line breaks for mobile reading. Include 2–4 tasteful emojis, one clear CTA. Stay under 900 characters. No markdown headings.

${outputOnly}`;

    case 'facebook':
    default:
      if (isFacebookVisualMode()) {
        return `You write Facebook VISUAL post fields for ${brandName} (short caption + image creative).

${brand}

Produce EXACTLY these sections in order. Use the ===MARKER=== format EXACTLY (three equals signs). Do NOT use markdown headings like ###. No JSON, no code fences, no extra commentary.

===FB_CAPTION===
Exactly 3 short lines only:
Line1: hook about the topic angle (optional 1 emoji)
Line2: brand line that names ${brandName}
Line3: Visit: ${site.replace(/\/$/, '')}

===FB_HEADLINE===
Short uppercase headline for the image, e.g. FIND YOUR DREAM INTERNSHIP. Max 6 words.

===FB_ACCENT_WORD===
ONE word from the headline to highlight in magenta, e.g. DREAM

===FB_SUBHEAD===
One short purple-bar line naming ${brandName}, max 12 words

===FB_BODY===
One sentence under the subhead, max 30 words, about verified internships / career growth

===FB_CTA_LABEL===
Button label, e.g. Explore Internships Now`;
      }

      return `You write social media copy for ${brandName} on Facebook.

${brand}

Write ONE Facebook post. Always name ${brandName}; include ${site} as a clear CTA. Stay on internships/freelance/career opportunities for this brand.

Requirements:
- Start with a strong hook (first line must grab attention).
- Use short paragraphs and natural storytelling (relatable, vivid).
- Include a few relevant emojis (not excessive).
- End with a clear call-to-action that includes ${site}.
- Tone: authentic, positive, scroll-stopping, opportunity-focused.
- Length: roughly 80–200 words unless the topic needs slightly more.

${outputOnly}`;
  }
}

/**
 * One Ollama call → multiple sections delimited by markers (saves latency vs 4 calls).
 */
function buildMultiPlatformPrompt(topic) {
  const brand = brandContextBlock(topic);
  const brandName = config.brand.name;
  const site = config.brand.website;
  const siteBare = site.replace(/\/$/, '');
  const visual = isFacebookVisualMode();

  const facebookBlock = visual
    ? `===FB_CAPTION===
[Exactly 3 short lines for the Facebook caption with image:
Line1 hook (optional 1 emoji); Line2 names ${brandName}; Line3 Visit: ${siteBare}]

===FB_HEADLINE===
[Image headline, ~4–6 words, e.g. FIND YOUR DREAM INTERNSHIP]

===FB_ACCENT_WORD===
[One accent word from headline, e.g. DREAM]

===FB_SUBHEAD===
[Purple bar line naming ${brandName}]

===FB_BODY===
[One short sentence for the creative body]

===FB_CTA_LABEL===
[CTA button label, e.g. Explore Internships Now]`
    : `===FACEBOOK===
[Facebook feed post: hook, storytelling, several emojis, CTA with ${site}. About 80–200 words. Name ${brandName}.]`;

  return `You write multi-platform social copy for ${brandName}.

${brand}

Produce EXACTLY these sections in order. Each section starts on its own line with the marker in ALL CAPS exactly as shown, followed by a newline, then the content. No JSON, no markdown code blocks, no extra commentary before or after the blocks.

Every section must be about ${brandName} (internships / freelance / career opportunities). Always name ${brandName}. Include ${site} in Facebook, LinkedIn, and WhatsApp. On Twitter include ${site} if character budget allows.

${facebookBlock}

===TWITTER===
[Single X/Twitter post, MAXIMUM 280 characters including spaces. Punchy hook + CTA. About ${brandName}; URL if space allows.]

===LINKEDIN===
[Professional LinkedIn post: 2–4 short paragraphs, optional light emoji, end with question or CTA including ${site}. About 150–350 words. Name ${brandName}.]

===YOUTUBE_TITLE===
[One line, max 100 characters, compelling click-worthy title for ${brandName} angle]

===YOUTUBE_DESCRIPTION===
[YouTube description: 2–5 sentences, include ${site}, SEO keywords, end with 2–4 hashtags]

===WHATSAPP===
[WhatsApp text: conversational, mobile-friendly line breaks, 2–4 emojis, CTA with ${site}. Name ${brandName}. Max ~900 characters.]`;
}

const KNOWN_SECTION_KEYS = [
  'facebook',
  'twitter',
  'linkedin',
  'youtube_title',
  'youtube_description',
  'whatsapp',
  'fb_caption',
  'fb_headline',
  'fb_accent_word',
  'fb_subhead',
  'fb_body',
  'fb_cta_label',
];

/** Lines that are LLM scaffolding / field labels, not caption copy. */
const FIELD_MARKER_LINE_RE =
  /^\s*(?:#{1,6}\s*)?\*{0,2}\s*(?:===\s*)?(?:FB_[A-Z0-9_]+|FACEBOOK|TWITTER|LINKEDIN|YOUTUBE_TITLE|YOUTUBE_DESCRIPTION|WHATSAPP)\s*(?:===)?\*{0,2}\s*:?\s*$/i;

/** Inline label prefixes Gemma sometimes sticks on the first caption line. */
const FIELD_MARKER_PREFIX_RE =
  /^\s*(?:#{1,6}\s*)?\*{0,2}\s*(?:===\s*)?(?:FB_[A-Z0-9_]+|FACEBOOK)\s*(?:===)?\*{0,2}\s*:?\s*/i;

/**
 * Strip scaffolding markers from a caption-ish string → clean 3-line caption body.
 * Kept intentionally simple to avoid regex backtracking on long Gemma dumps.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeFacebookCaption(text) {
  const src = String(text || '');
  // Hard cap — caption should never need more than a few KB
  const clipped = src.length > 4000 ? src.slice(0, 4000) : src;
  const out = [];
  for (const rawLine of clipped.split(/\r?\n/)) {
    let l = rawLine.trim();
    if (!l) continue;
    if (FIELD_MARKER_LINE_RE.test(l)) continue;
    l = l.replace(FIELD_MARKER_PREFIX_RE, '').trim();
    if (!l || FIELD_MARKER_LINE_RE.test(l)) continue;
    l = l.replace(/^\*{1,2}\s*(.*?)\s*\*{1,2}$/, '$1').trim();
    if (!l) continue;
    out.push(l);
    if (out.length >= 3) break;
  }
  return out.join('\n');
}

/**
 * True when raw looks like structured FB fields (not a plain caption).
 * @param {string} raw
 */
function looksLikeFacebookFieldScaffolding(raw) {
  const s = String(raw || '');
  if (s.length > 8000) return true;
  return /FB_CAPTION|FB_HEADLINE|FB_ACCENT|FB_SUBHEAD|FB_BODY|FB_CTA|===\s*FB_/i.test(s);
}

/**
 * Parse ===SECTION=== ... blocks from model output.
 * Also accepts ### SECTION: / **SECTION** / SECTION: variants (common Gemma drift),
 * including same-line content after the colon.
 * Uses a linear line scan for loose markers — avoid nested regex backtracking on long Gemma dumps.
 * @param {string} raw
 * @returns {Record<string, string>}
 */
export function parseMultiPlatformOutput(raw) {
  const text = String(raw || '').trim();
  const out = {};

  // Strict ===SECTION=== blocks via linear scan (no nested regex).
  {
    const lines = text.split(/\r?\n/);
    /** @type {string | null} */
    let current = null;
    /** @type {string[]} */
    let buf = [];
    const flush = () => {
      if (!current) return;
      out[current] = buf.join('\n').trim();
      current = null;
      buf = [];
    };
    const strictHeader = /^\s*===\s*([A-Z_]+)\s*===\s*$/;
    for (const line of lines) {
      const hm = strictHeader.exec(line);
      if (hm) {
        flush();
        current = hm[1].toLowerCase();
        buf = [];
        continue;
      }
      if (current) buf.push(line);
    }
    flush();
  }

  const hasFbFields = Boolean(out.fb_caption || out.fb_headline);
  if (Object.keys(out).length === 0 || (looksLikeFacebookFieldScaffolding(text) && !hasFbFields)) {
    const headerRe =
      /^\s*(?:#{1,6}\s*)?\*{0,2}\s*([A-Z][A-Z0-9_]{2,})\s*\*{0,2}\s*:?\s*\*{0,2}\s*(.*)$/;
    const lines = text.split(/\r?\n/);
    /** @type {string | null} */
    let current = null;
    /** @type {string[]} */
    let buf = [];

    const flush = () => {
      if (!current) return;
      if (KNOWN_SECTION_KEYS.includes(current) && out[current] == null) {
        out[current] = buf.join('\n').trim();
      }
      current = null;
      buf = [];
    };

    for (const line of lines) {
      const hm = headerRe.exec(line);
      if (hm) {
        const key = hm[1].toLowerCase();
        if (KNOWN_SECTION_KEYS.includes(key)) {
          flush();
          current = key;
          const rest = String(hm[2] || '').trim();
          buf = rest ? [rest] : [];
          continue;
        }
      }
      if (current) buf.push(line);
    }
    flush();
  }

  return out;
}

/**
 * Build FacebookCreativeFields from parsed section map + defaults.
 * @param {Record<string, string>} sections
 * @param {string} topic
 * @param {string} [rawFallback] full model output — used to recover caption if section parse missed
 * @returns {FacebookCreativeFields}
 */
export function creativeFromSections(sections, topic, rawFallback = '') {
  const d = defaultFacebookCreative(topic);
  let caption = sanitizeFacebookCaption(sections.fb_caption || sections.facebook || '');
  if (!caption && rawFallback) {
    caption = sanitizeFacebookCaption(String(rawFallback).slice(0, 4000));
  }
  if (!caption) caption = d.caption;

  const siteBare = config.brand.website.replace(/\/$/, '');
  if (!/airepro\.in/i.test(caption)) {
    const lines = caption.split('\n').filter(Boolean).slice(0, 2);
    while (lines.length < 2) {
      lines.push(`Start Building Your Career Today with ${config.brand.name}`);
    }
    lines.push(`Visit: ${siteBare}`);
    caption = lines.join('\n');
  }

  const cleanField = (v, fallback) => {
    const s = sanitizeFacebookCaption(String(v || '').slice(0, 500))
      .split('\n')[0]
      ?.trim();
    return s || fallback;
  };

  return {
    caption,
    headline: cleanField(sections.fb_headline, d.headline),
    accentWord: cleanField(sections.fb_accent_word, d.accentWord).split(/\s+/)[0] || d.accentWord,
    subhead: cleanField(sections.fb_subhead, d.subhead),
    body: cleanField(sections.fb_body, d.body),
    ctaLabel: cleanField(sections.fb_cta_label, d.ctaLabel),
  };
}

function fallbackPack(topic, singleFacebook) {
  const fb = singleFacebook.trim();
  const tw = fb.length > 280 ? `${fb.slice(0, 277)}…` : fb;
  const wa = fb.length > 900 ? `${fb.slice(0, 897)}…` : fb;
  const creative = defaultFacebookCreative(topic);
  return {
    facebook: fb,
    twitter: tw,
    linkedin: fb,
    youtubeTitle: topic.slice(0, 100),
    youtubeDescription: `${fb}\n\n#content #video`,
    whatsapp: wa,
    facebookCreative: isFacebookVisualMode()
      ? { ...creative, caption: fb.includes('\n') ? fb : creative.caption }
      : null,
  };
}

function ollamaBaseUrl() {
  return config.ollama.url.replace(/\/$/, '');
}

/**
 * Fail fast with actionable guidance if Ollama is down or MODEL is not pulled.
 * @returns {Promise<void>}
 */
export async function assertOllamaReady() {
  const base = ollamaBaseUrl();
  const model = config.ollama.model;
  const tagsUrl = `${base}/api/tags`;

  let res;
  try {
    res = await fetchWithTimeout(
      tagsUrl,
      { method: 'GET', headers: { Connection: 'close' } },
      Math.min(config.http.timeoutMs, 15_000)
    );
  } catch (e) {
    throw new Error(
      `Ollama unreachable at ${base}. Start it (e.g. \`ollama serve\`), confirm OLLAMA_URL, and retry. (${e.message})`
    );
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Ollama /api/tags returned non-JSON (${res.status}) from ${base}. Check OLLAMA_URL.`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Ollama /api/tags failed (${res.status}) at ${base}: ${data?.error || text.slice(0, 200)}`
    );
  }

  const names = (Array.isArray(data.models) ? data.models : [])
    .map((m) => (typeof m?.name === 'string' ? m.name : typeof m?.model === 'string' ? m.model : ''))
    .filter(Boolean);

  const hasModel =
    names.includes(model) ||
    names.some((n) => n === `${model}:latest` || n.startsWith(`${model}:`));

  if (!hasModel) {
    const preview = names.length ? names.slice(0, 12).join(', ') : '(none — run ollama pull)';
    throw new Error(
      `Ollama model "${model}" not found at ${base}. Run \`ollama pull ${model}\` then retry. Available: ${preview}`
    );
  }
}

/**
 * @param {string} url
 * @param {object} body
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, text: string }>}
 */
/**
 * POST JSON to Ollama.
 * Uses curl.exe on Windows — undici/http.request often stall reading Docker-published
 * Ollama response bodies while an Express request is in flight.
 * @param {string} url
 * @param {object} body
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, data: any, text: string }>}
 */
async function ollamaGenerate(url, body, opts = {}) {
  const timeoutMs = config.http.ollamaTimeoutMs;
  const payload = JSON.stringify(body);
  const tmpIn = path.join(os.tmpdir(), `ollama-req-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmpIn, payload, 'utf8');

  try {
    const maxTime = Math.max(30, Math.ceil(timeoutMs / 1000));
    const args = [
      '-sS',
      '-X',
      'POST',
      '--max-time',
      String(maxTime),
      '-H',
      'Content-Type: application/json',
      '-H',
      'Connection: close',
      '--data-binary',
      `@${tmpIn}`,
      url,
    ];

    const { stdout } = await new Promise((resolve, reject) => {
      const child = execFile(
        process.platform === 'win32' ? 'curl.exe' : 'curl',
        args,
        { maxBuffer: 20 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr || err.message));
            return;
          }
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
      );
      if (opts.signal) {
        const onAbort = () => {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    const text = stdout;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Ollama returned non-JSON: ${text.slice(0, 500)}`);
    }
    const errMsg = data?.error;
    const ok = !errMsg;
    return { ok, status: ok ? 200 : 500, data, text };
  } catch (e) {
    throw new Error(`Ollama request failed (is Ollama running at ${ollamaBaseUrl()}?): ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmpIn);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Generate structured Facebook creative fields (caption + template slots).
 * @param {string} topic
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<FacebookCreativeFields>}
 */
export async function generateFacebookCreative(topic, opts = {}) {
  if (!topic || !String(topic).trim()) {
    throw new Error('Topic is required for generateFacebookCreative()');
  }

  await assertOllamaReady();

  const base = ollamaBaseUrl();
  const url = `${base}/api/generate`;
  const body = {
    model: config.ollama.model,
    prompt: buildPromptForPlatform(topic.trim(), 'facebook'),
    stream: false,
  };

  logger.info('Calling Ollama for Facebook creative fields', {
    model: body.model,
    brand: config.brand.name,
  });

  const { ok, status, data, text } = await ollamaGenerate(url, body, opts);
  if (!ok) {
    throw new Error(`Ollama error ${status}: ${data?.error || text}`);
  }

  const raw = typeof data.response === 'string' ? data.response.trim() : '';
  if (!raw) {
    return defaultFacebookCreative(topic);
  }

  const sections = parseMultiPlatformOutput(raw);
  try {
    if (sections.fb_caption || sections.fb_headline) {
      return creativeFromSections(sections, topic, raw);
    }

    // Prefer defaults over risking sanitize on unstructured scaffolding dumps.
    if (looksLikeFacebookFieldScaffolding(raw)) {
      return {
        ...defaultFacebookCreative(topic),
        caption:
          sanitizeFacebookCaption(raw).split('\n').slice(0, 3).join('\n') ||
          defaultFacebookCreative(topic).caption,
      };
    }

    const d = defaultFacebookCreative(topic);
    const caption = sanitizeFacebookCaption(raw) || d.caption;
    return { ...d, caption };
  } catch (e) {
    logger.error('Creative field build failed — using defaults', e.message || e);
    return defaultFacebookCreative(topic);
  }
}

/**
 * @param {string} topic
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{
 *   facebook: string,
 *   twitter: string,
 *   linkedin: string,
 *   youtubeTitle: string,
 *   youtubeDescription: string,
 *   whatsapp: string,
 *   facebookCreative: FacebookCreativeFields | null,
 * }>}
 */
export async function generateMultiPlatformPack(topic, opts = {}) {
  if (!topic || !String(topic).trim()) {
    throw new Error('Topic is required for generateMultiPlatformPack()');
  }

  await assertOllamaReady();

  const base = ollamaBaseUrl();
  const url = `${base}/api/generate`;

  const body = {
    model: config.ollama.model,
    prompt: buildMultiPlatformPrompt(topic.trim()),
    stream: false,
  };

  logger.info('Calling Ollama /api/generate (multi-platform)', {
    model: body.model,
    brand: config.brand.name,
    facebookMode: config.facebook.postMode,
  });

  const { ok, status, data, text } = await ollamaGenerate(url, body, opts);

  if (!ok) {
    const errMsg = data?.error || text;
    if (/not found|unknown model|pull/i.test(String(errMsg))) {
      throw new Error(
        `Ollama model error ${status}: ${errMsg}. Run \`ollama pull ${config.ollama.model}\`.`
      );
    }
    throw new Error(`Ollama error ${status}: ${errMsg}`);
  }

  const raw = typeof data.response === 'string' ? data.response : '';
  const cleaned = raw.trim();
  if (!cleaned) {
    throw new Error('Ollama returned an empty response.');
  }

  const sections = parseMultiPlatformOutput(cleaned);
  const visual = isFacebookVisualMode();

  /** @type {FacebookCreativeFields | null} */
  let facebookCreative = null;
  let facebook = '';

  if (visual) {
    facebookCreative = creativeFromSections(sections, topic, cleaned);
    facebook = facebookCreative.caption;
  } else {
    facebook = sections.facebook || '';
  }

  const twitter = (sections.twitter || '').replace(/\s+/g, ' ').trim();
  const linkedin = sections.linkedin || '';
  let youtubeTitle = (sections.youtube_title || '').replace(/\n/g, ' ').trim();
  let youtubeDescription = (sections.youtube_description || '').trim();

  const facebookOk = visual ? Boolean(facebookCreative?.caption) : Boolean(facebook);
  if (!facebookOk || !twitter || !linkedin) {
    logger.info('Multi-platform parse incomplete; running Facebook-only prompt as fallback base');
    if (visual) {
      facebookCreative = await generateFacebookCreative(topic);
      facebook = facebookCreative.caption;
      const pack = fallbackPack(topic, facebook);
      pack.facebookCreative = facebookCreative;
      // still need twitter/linkedin — generate via single calls if missing
      if (!twitter) {
        pack.twitter = (await generatePost(topic, { platform: 'twitter' }))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, config.twitter.maxChars || 280);
      } else {
        pack.twitter = twitter.length > (config.twitter.maxChars || 280)
          ? `${twitter.slice(0, (config.twitter.maxChars || 280) - 1)}…`
          : twitter;
      }
      if (!linkedin) {
        pack.linkedin = await generatePost(topic, { platform: 'linkedin' });
      } else {
        pack.linkedin = linkedin;
      }
      if (!youtubeTitle || !youtubeDescription) {
        const yt = await generatePost(topic, { platform: 'youtube' });
        const titleLine = yt.match(/TITLE:\s*(.+)/i);
        const descLine = yt.match(/DESCRIPTION:\s*([\s\S]+)/i);
        pack.youtubeTitle = titleLine ? titleLine[1].trim().slice(0, 100) : topic.slice(0, 100);
        pack.youtubeDescription = descLine ? descLine[1].trim() : `${facebook}\n\n#shorts #video`;
      } else {
        pack.youtubeTitle = youtubeTitle;
        pack.youtubeDescription = youtubeDescription;
      }
      let whatsapp = (sections.whatsapp || '').trim();
      if (!whatsapp) {
        whatsapp = facebook.length > 900 ? `${facebook.slice(0, 897)}…` : facebook;
      }
      pack.whatsapp = whatsapp;
      return pack;
    }

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
    facebookCreative,
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

  // Visual Facebook: return caption string (structured generate available via generateFacebookCreative)
  if (platform === 'facebook' && isFacebookVisualMode()) {
    const creative = await generateFacebookCreative(topic);
    return creative.caption;
  }

  const base = ollamaBaseUrl();
  const url = `${base}/api/generate`;

  const body = {
    model: config.ollama.model,
    prompt: buildPromptForPlatform(topic.trim(), platform),
    stream: false,
  };

  logger.info('Calling Ollama /api/generate', {
    model: body.model,
    platform,
    brand: config.brand.name,
  });

  const { ok, status, data, text } = await ollamaGenerate(url, body);

  if (!ok) {
    throw new Error(`Ollama error ${status}: ${data?.error || text}`);
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
