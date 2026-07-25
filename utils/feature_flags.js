// @ts-nocheck
/**
 * Feature flags file (features 234, 235).
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';

const flagsPath = path.join(config.rootDir, 'config', 'feature_flags.json');

/** @returns {Record<string, boolean>} */
export function loadFeatureFlags() {
  try {
    const data = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
    /** @type {Record<string, boolean>} */
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (k.startsWith('_')) continue;
      out[k] = v === true;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {string} name
 * @param {boolean} [defaultValue]
 * @returns {boolean}
 */
export function isFeatureEnabled(name, defaultValue = true) {
  const flags = loadFeatureFlags();
  if (!(name in flags)) return defaultValue;
  return flags[name] === true;
}

export { flagsPath };
