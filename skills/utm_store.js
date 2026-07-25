/**
 * UTM settings store (feature 113): campaign slug + on/off flag applied at
 * polish time. Missing/corrupt files fall back to safe defaults.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import { slugify } from './compose_tools.js';

const MAX_CAMPAIGN_LEN = 60;

export const utmSettingsPath =
  process.env.UTM_SETTINGS_PATH || path.join(config.rootDir, 'config', 'utm_settings.json');

const DEFAULT_UTM_SETTINGS = { enabled: false, campaign: 'airepro' };

/**
 * @returns {{ enabled: boolean, campaign: string }} defaults merged with the file
 */
export function loadUtmSettings() {
  try {
    if (!fs.existsSync(utmSettingsPath)) return { ...DEFAULT_UTM_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(utmSettingsPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_UTM_SETTINGS };
    return { ...DEFAULT_UTM_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_UTM_SETTINGS };
  }
}

/**
 * Validate, persist, and return the merged settings.
 * enabled is coerced to boolean; campaign is trimmed, slugified, max 60 chars.
 * @param {{ enabled?: unknown, campaign?: unknown }} [patch]
 * @returns {{ enabled: boolean, campaign: string }}
 */
export function saveUtmSettings(patch = {}) {
  const merged = { ...loadUtmSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
  const campaign =
    slugify(String(merged.campaign || '').trim()).slice(0, MAX_CAMPAIGN_LEN) ||
    DEFAULT_UTM_SETTINGS.campaign;
  const settings = { enabled: Boolean(merged.enabled), campaign };
  fs.mkdirSync(path.dirname(utmSettingsPath), { recursive: true });
  fs.writeFileSync(utmSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settings;
}
