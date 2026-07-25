// @ts-nocheck
/**
 * Crash-safe JSONL append + size-based rotation (features 185, 186, 215).
 */
import fs from 'fs';
import path from 'path';
import { now } from './clock.js';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;

/**
 * @param {string} [filePath]
 * @returns {{ maxBytes: number, keep: number }}
 */
export function loadRotationSettings(filePath) {
  const defaults = { maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP };
  if (!filePath) return { ...defaults };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      maxBytes:
        Number.isFinite(data?.maxBytes) && data.maxBytes > 0 ? data.maxBytes : defaults.maxBytes,
      keep: Number.isFinite(data?.keep) && data.keep >= 0 ? data.keep : defaults.keep,
    };
  } catch {
    return { ...defaults };
  }
}

/**
 * Append one JSON object as a line. Prefers temp+fsync, falls back to append
 * when the platform blocks fsync (common on Windows temp/AV locks).
 * @param {string} filePath
 * @param {unknown} record
 * @param {{ maxBytes?: number, keep?: number, rotate?: boolean }} [opts]
 */
export function appendJsonl(filePath, record, opts = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${now()}.tmp`
  );
  try {
    fs.writeFileSync(tmp, line, 'utf8');
    try {
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.fsyncSync(fd);
      } catch {
        // EPERM on some Windows setups — line is still fully written
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // ignore open/fsync issues
    }
    fs.appendFileSync(filePath, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  } catch {
    fs.appendFileSync(filePath, line, 'utf8');
    fs.rmSync(tmp, { force: true });
  }

  if (opts.rotate !== false) {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const keep = opts.keep ?? DEFAULT_KEEP;
    maybeRotate(filePath, maxBytes, keep);
  }
}

/**
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {number} keep
 */
export function maybeRotate(filePath, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP) {
  if (!fs.existsSync(filePath)) return false;
  const st = fs.statSync(filePath);
  if (st.size < maxBytes) return false;

  for (let i = keep; i >= 1; i--) {
    const src = i === 1 ? filePath : `${filePath}.${i - 1}`;
    const dest = `${filePath}.${i}`;
    if (i === keep && fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    if (fs.existsSync(src)) fs.renameSync(src, dest);
  }
  fs.writeFileSync(filePath, '', 'utf8');
  return true;
}
