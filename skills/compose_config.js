/**
 * Node-only loaders for the Wave-3 compose config JSONs (features 110, 134,
 * 135, 141/142). Keeps fs/path out of the browser-safe compose_tools.js /
 * content_lint.js modules: the server loads these and hands plain data to
 * the pure helpers.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * Read and parse a JSON file, returning fallback when missing or unparseable.
 * @param {string} filePath
 * @param {*} fallback
 * @returns {*}
 */
function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const MAX_TAGS_PER_PACK = 30;

/**
 * @typedef {Object} HashtagPack
 * @property {string} id
 * @property {string} name
 * @property {string[]} tags
 * @property {{ twitter?: number, linkedin?: number }} [perPlatformMax]
 */

/**
 * Load named hashtag packs (feature 110). Missing file yields []; a pack with
 * more than 30 tags throws an Error naming the offending pack id.
 * @param {string} [filePath]
 * @returns {HashtagPack[]}
 */
export function loadHashtagPacks(filePath = path.join(rootDir, 'config', 'hashtag_packs.json')) {
  const data = readJson(filePath, { packs: [] });
  const packs = Array.isArray(data && data.packs) ? data.packs : [];
  for (const pack of packs) {
    const tags = Array.isArray(pack && pack.tags) ? pack.tags : [];
    if (tags.length > MAX_TAGS_PER_PACK) {
      throw new Error(
        `Hashtag pack "${pack.id}" has ${tags.length} tags (max ${MAX_TAGS_PER_PACK}).`
      );
    }
  }
  return packs;
}

/**
 * Load banned words + handle allowlist for the content lints (features 141/142).
 * Missing file yields empty arrays.
 * @param {string} [filePath]
 * @returns {{ bannedWords: string[], handleAllowlist: string[] }}
 */
export function loadContentLintConfig(
  filePath = path.join(rootDir, 'config', 'content_lint.json')
) {
  const data = readJson(filePath, {});
  return {
    bannedWords: Array.isArray(data && data.bannedWords) ? data.bannedWords : [],
    handleAllowlist: Array.isArray(data && data.handleAllowlist) ? data.handleAllowlist : [],
  };
}

/**
 * Load the local link-slug map (feature 134). Missing file yields {}.
 * @param {string} [filePath]
 * @returns {Record<string, string>}
 */
export function loadLinkSlugs(filePath = path.join(rootDir, 'config', 'link_slugs.json')) {
  const data = readJson(filePath, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

/** Built-in hints guarantee every platform key exists (feature 135). */
const DEFAULT_BEST_TIMES = {
  facebook: 'Weekdays 11:00–13:00 & 19:00–21:00 IST',
  twitter: 'Weekdays 08:00–10:00 & 18:00–20:00 IST',
  linkedin: 'Tue–Thu 09:00–11:00 IST',
  youtube: 'Fri–Sun 17:00–20:00 IST',
  whatsapp: 'Daily 10:00–12:00 & 19:00–21:00 IST',
};

/**
 * Load static per-platform best-time hints (feature 135). Always contains an
 * entry for facebook, twitter, linkedin, youtube, and whatsapp — file values
 * override the built-in defaults.
 * @param {string} [filePath]
 * @returns {Record<string, string>}
 */
export function loadBestTimes(filePath = path.join(rootDir, 'config', 'best_times.json')) {
  const data = readJson(filePath, {});
  const fromFile = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return { ...DEFAULT_BEST_TIMES, ...fromFile };
}

/**
 * Feature 152: reusable CTA/footer snippets.
 * @param {string} [filePath]
 * @returns {Array<{ id: string, label: string, text: string }>}
 */
export function loadSnippets(filePath = path.join(rootDir, 'config', 'snippets.json')) {
  const data = readJson(filePath, { snippets: [] });
  return Array.isArray(data?.snippets) ? data.snippets : [];
}

/**
 * Feature 159: WhatsApp broadcast lists.
 * @param {string} [filePath]
 * @returns {Array<{ id: string, name: string, recipients: string[], armed: boolean }>}
 */
export function loadBroadcastLists(
  filePath = path.join(rootDir, 'config', 'broadcast_lists.json')
) {
  const data = readJson(filePath, { lists: [] });
  return Array.isArray(data?.lists) ? data.lists : [];
}

/**
 * Feature 170: named compose presets.
 * @param {string} [filePath]
 * @returns {Array<object>}
 */
export function loadComposePresets(
  filePath = path.join(rootDir, 'config', 'compose_presets.json')
) {
  const data = readJson(filePath, { presets: [] });
  return Array.isArray(data?.presets) ? data.presets : [];
}
