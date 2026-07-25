/** Shared client helpers for the operator UI (used by App + lazy tabs). */

export async function api(path, options = {}) {
  const { signal, headers, body, ...rest } = options;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(path, {
    headers: isForm
      ? { ...(headers || {}) }
      : { 'Content-Type': 'application/json', ...(headers || {}) },
    body,
    signal,
    ...rest,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCheckedAgo(ts) {
  if (!ts) return '';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

/** Trigger a client-side download of `content` as `filename` (feature 150). */
export function downloadFile(filename, content, mime = 'text/markdown') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Feature 137: crop an image File to a preset aspect ratio via canvas.
 * Returns a new File (PNG) or the original file when ratio is 'original'.
 * @param {File} file
 * @param {string} ratio 'original' | '1:1' | '4:5' | '1.91:1'
 * @param {(w: number, h: number, ratio: string) => { x: number, y: number, width: number, height: number } | null} cropRectFn
 */
export async function cropImageFile(file, ratio, cropRectFn) {
  if (!ratio || ratio === 'original') return file;
  const bitmap = await createImageBitmap(file);
  const rect = cropRectFn(bitmap.width, bitmap.height, ratio);
  if (!rect) return file;
  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return file;
  const base = (file.name || 'image').replace(/\.[a-z0-9]+$/i, '');
  return new File([blob], `${base}-crop.png`, { type: 'image/png' });
}
