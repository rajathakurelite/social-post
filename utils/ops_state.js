// @ts-nocheck
/**
 * Ops flag files: panic pause (205), PID guard helpers (196), env mtime (208).
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config/config.js';

const outputDir = process.env.OPS_OUTPUT_DIR || path.join(config.rootDir, 'output');
const pauseFlagPath = process.env.OPS_PAUSE_FLAG_PATH || path.join(outputDir, 'ops-paused.flag');
const pidFilePath = process.env.OPS_PID_PATH || path.join(outputDir, 'api.pid');

/** @returns {boolean} */
export function isPaused() {
  return fs.existsSync(pauseFlagPath);
}

/** @returns {{ paused: boolean, path: string }} */
export function pauseOutbound() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(pauseFlagPath, `${new Date().toISOString()}\n`, 'utf8');
  return { paused: true, path: pauseFlagPath };
}

/** @returns {{ paused: boolean }} */
export function resumeOutbound() {
  fs.rmSync(pauseFlagPath, { force: true });
  return { paused: false };
}

/**
 * Single-instance PID guard (feature 196).
 * @param {{ force?: boolean }} [opts]
 * @returns {{ acquired: boolean, reason?: string, pid?: number }}
 */
export function acquirePidLock(opts = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.existsSync(pidFilePath) && !opts.force) {
    try {
      const existing = Number(fs.readFileSync(pidFilePath, 'utf8').trim());
      if (Number.isFinite(existing) && existing !== process.pid) {
        try {
          process.kill(existing, 0);
          return {
            acquired: false,
            reason: `Another API server is already running (pid ${existing}). Stop it or delete output/api.pid.`,
            pid: existing,
          };
        } catch {
          // stale pid
        }
      }
    } catch {
      // unreadable — overwrite
    }
  }
  fs.writeFileSync(pidFilePath, `${process.pid}\n`, 'utf8');
  return { acquired: true, pid: process.pid };
}

export function releasePidLock() {
  try {
    if (!fs.existsSync(pidFilePath)) return;
    const existing = Number(fs.readFileSync(pidFilePath, 'utf8').trim());
    if (existing === process.pid) fs.rmSync(pidFilePath, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Watch .env mtime (never contents) — feature 208.
 * @param {string} envPath
 * @param {number} bootMtimeMs
 * @returns {boolean} true when file is newer than boot
 */
export function isEnvStale(envPath, bootMtimeMs) {
  try {
    const st = fs.statSync(envPath);
    return st.mtimeMs > bootMtimeMs;
  } catch {
    return false;
  }
}

export { pauseFlagPath, pidFilePath };
