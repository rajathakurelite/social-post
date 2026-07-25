// @ts-nocheck
/**
 * Named disk drafts store (features 130, 131).
 * Drafts survive browser and machine restarts; the draft body is stored
 * exactly as given so a JSON round-trip is byte-identical for JSON-safe values.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';

const MAX_NAME_LEN = 60;

export const draftsPath =
  process.env.DRAFTS_PATH || path.join(config.rootDir, 'output', 'drafts.json');

/**
 * @typedef {Object} DraftEntry
 * @property {string} name
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {unknown} draft Stored exactly as given.
 */

/** @returns {{ drafts: DraftEntry[] }} */
function readStore() {
  try {
    if (!fs.existsSync(draftsPath)) return { drafts: [] };
    const raw = JSON.parse(fs.readFileSync(draftsPath, 'utf8'));
    if (raw && typeof raw === 'object' && Array.isArray(raw.drafts)) return raw;
    return { drafts: [] };
  } catch {
    return { drafts: [] };
  }
}

/** @param {{ drafts: DraftEntry[] }} store */
function writeStore(store) {
  fs.mkdirSync(path.dirname(draftsPath), { recursive: true });
  fs.writeFileSync(draftsPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/**
 * @returns {Array<{ name: string, createdAt: string, updatedAt: string }>} no draft bodies
 */
export function listDrafts() {
  return readStore().drafts.map(({ name, createdAt, updatedAt }) => ({
    name,
    createdAt,
    updatedAt,
  }));
}

/**
 * Feature 130/131: persist a named draft. Duplicate names (case-insensitive)
 * are rejected unless overwrite is passed.
 * @param {string} name
 * @param {unknown} draft
 * @param {{ overwrite?: boolean }} [opts]
 * @returns {DraftEntry}
 */
export function saveDraft(name, draft, { overwrite = false } = {}) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Draft name is required');
  if (trimmed.length > MAX_NAME_LEN) {
    throw new Error(`Draft name max length is ${MAX_NAME_LEN}`);
  }
  const store = readStore();
  const existing = store.drafts.find((d) => d.name.toLowerCase() === trimmed.toLowerCase());
  if (existing && !overwrite) {
    throw new Error('Draft name already exists — pass overwrite or pick another name');
  }
  const now = new Date().toISOString();
  let entry;
  if (existing) {
    existing.name = trimmed;
    existing.updatedAt = now;
    existing.draft = draft;
    entry = existing;
  } else {
    entry = { name: trimmed, createdAt: now, updatedAt: now, draft };
    store.drafts.push(entry);
  }
  writeStore(store);
  return entry;
}

/**
 * @param {string} name case-insensitive lookup
 * @returns {DraftEntry | null}
 */
export function getDraft(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  if (!key) return null;
  return readStore().drafts.find((d) => d.name.toLowerCase() === key) || null;
}

/**
 * @param {string} name case-insensitive
 * @returns {boolean} true when a draft was deleted
 */
export function deleteDraft(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  if (!key) return false;
  const store = readStore();
  const before = store.drafts.length;
  store.drafts = store.drafts.filter((d) => d.name.toLowerCase() !== key);
  if (store.drafts.length === before) return false;
  writeStore(store);
  return true;
}
