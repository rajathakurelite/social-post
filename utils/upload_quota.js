// @ts-nocheck
/**
 * Uploads directory size cap + oldest-first purge (feature 193).
 */
import fs from 'fs';
import path from 'path';

/**
 * @param {string} dir
 * @returns {Array<{ path: string, mtimeMs: number, size: number }>}
 */
export function listUploadFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  /** @type {Array<{ path: string, mtimeMs: number, size: number }>} */
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/**
 * @param {string} dir
 * @param {number} maxBytes
 * @returns {{ totalBytes: number, reclaimed: number, deleted: string[] }}
 */
export function purgeUploadsToCap(dir, maxBytes) {
  const files = listUploadFiles(dir);
  let totalBytes = files.reduce((s, f) => s + f.size, 0);
  /** @type {string[]} */
  const deleted = [];
  let reclaimed = 0;
  const cap = Math.max(0, Number(maxBytes) || 0);
  if (!cap) return { totalBytes, reclaimed: 0, deleted };

  for (const f of files) {
    if (totalBytes <= cap) break;
    try {
      fs.rmSync(f.path, { force: true });
      // also drop sidecar meta if present
      const meta = `${f.path}.meta.json`;
      if (fs.existsSync(meta)) {
        const st = fs.statSync(meta);
        fs.rmSync(meta, { force: true });
        totalBytes -= st.size;
        reclaimed += st.size;
        deleted.push(meta);
      }
      totalBytes -= f.size;
      reclaimed += f.size;
      deleted.push(f.path);
    } catch {
      // continue
    }
  }
  return { totalBytes, reclaimed, deleted };
}
