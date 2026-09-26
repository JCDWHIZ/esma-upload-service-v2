import * as path from 'node:path';

/**
 * Sanitizes an uploaded filename according to ARCH §4.4:
 * - Strips directory traversal sequences and separators (both POSIX and Windows).
 * - Removes null bytes and control characters ([\x00-\x1F\x7F]).
 * - Trims whitespace.
 * - Caps total UTF-8 byte length at 255 bytes while attempting to preserve the extension.
 * - Falls back to 'unnamed-file' if the sanitized string is empty or invalid.
 */
export function sanitizeFilename(rawName: string | null | undefined): string {
  if (!rawName || typeof rawName !== 'string') {
    return 'unnamed-file';
  }

  // 1. Remove null bytes and control characters (<= 31 or 127)
  let clean = '';
  for (let i = 0; i < rawName.length; i++) {
    const code = rawName.charCodeAt(i);
    if ((code >= 32 && code !== 127) || code > 127) {
      clean += rawName[i];
    }
  }
  clean = clean.trim();

  if (clean.length === 0) {
    return 'unnamed-file';
  }

  // 2. Take only the basename in case client supplied a path (handle both / and \)
  clean =
    clean
      .split(/[/\\]+/)
      .filter(Boolean)
      .pop() ?? '';

  // 3. Strip leading dots to prevent hidden/dot-file behavior and relative traversals
  clean = clean.replace(/^\.+/, '');

  if (clean.length === 0 || clean === '.' || clean === '..') {
    return 'unnamed-file';
  }

  // 4. Cap at 255 bytes in UTF-8
  const ext = path.extname(clean);
  const base = path.basename(clean, ext);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  const extBytes = encoder.encode(ext);
  const maxBaseBytes = Math.max(0, 255 - extBytes.length);

  const baseBytes = encoder.encode(base);
  if (baseBytes.length <= maxBaseBytes) {
    return clean;
  }

  // Truncate baseBytes to fit within 255 bytes
  const truncatedBase = decoder.decode(baseBytes.slice(0, maxBaseBytes));
  const result = `${truncatedBase}${ext}`.trim();

  return result.length > 0 ? result : 'unnamed-file';
}
