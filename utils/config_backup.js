// @ts-nocheck
/**
 * Config backups + restore (features 179, 180, 210).
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';
import { logger } from './logger.js';

const backupsDir = path.join(config.rootDir, 'config', 'backups');

/** @returns {string} */
export function getBackupsDir() {
  return backupsDir;
}

/**
 * Copy existing file to config/backups/<basename>.<timestamp> before overwrite.
 * @param {string} filePath
 * @returns {string | null} backup path or null if source missing
 */
export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  fs.mkdirSync(backupsDir, { recursive: true });
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `${base}.${stamp}`);
  fs.copyFileSync(filePath, dest);
  return dest;
}

/**
 * @returns {Array<{ name: string, path: string, mtimeMs: number, size: number }>}
 */
export function listBackups() {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((n) => !n.startsWith('.'))
    .map((name) => {
      const p = path.join(backupsDir, name);
      const st = fs.statSync(p);
      return { name, path: p, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Restore a named backup over its original config file.
 * Backup names look like `auto_reply_rules.json.2026-…`.
 * @param {string} backupName
 * @returns {{ ok: true, restoredTo: string } | { ok: false, error: string }}
 */
export function restoreBackup(backupName) {
  const name = path.basename(String(backupName || ''));
  if (!name || name.includes('..')) return { ok: false, error: 'invalid backup name' };
  const src = path.join(backupsDir, name);
  if (!fs.existsSync(src)) return { ok: false, error: 'backup not found' };

  // Strip trailing .ISO-like stamp to recover original basename.
  const match = name.match(/^(auto_reply_rules\.json|auto_reply_settings\.json|.*\.json)\./);
  let targetName = match ? match[1] : null;
  if (!targetName) {
    // fallback: everything before the first ISO-ish segment
    const parts = name.split('.');
    if (parts.length >= 3 && parts[parts.length - 1].includes('-')) {
      targetName = parts.slice(0, -1).join('.');
      // if last segment before stamp was extension piece, rebuild
      if (!targetName.endsWith('.json')) {
        const idx = name.indexOf('.json.');
        targetName = idx >= 0 ? name.slice(0, idx + 5) : null;
      }
    }
  }
  if (!targetName) return { ok: false, error: 'cannot infer restore target' };

  const dest = path.join(config.rootDir, 'config', targetName);
  backupFile(dest); // backup current before restore
  fs.copyFileSync(src, dest);
  return { ok: true, restoredTo: dest };
}

/**
 * Load JSON with corrupt recovery from latest matching backup (feature 210).
 * @param {string} filePath
 * @param {unknown} fallback
 * @returns {{ data: unknown, recovered: boolean }}
 */
export function loadJsonWithBackup(filePath, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { data, recovered: false };
  } catch (e) {
    const base = path.basename(filePath);
    const candidates = listBackups().filter((b) => b.name.startsWith(`${base}.`));
    if (candidates.length) {
      try {
        const data = JSON.parse(fs.readFileSync(candidates[0].path, 'utf8'));
        logger.warn(`Corrupt ${base} — loaded from backup ${candidates[0].name}`);
        return { data, recovered: true };
      } catch {
        // fall through
      }
    }
    logger.error(`Failed to parse ${base}`, e.message || e);
    return { data: fallback, recovered: false };
  }
}
