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

/**
 * Sanitizes an SVG file on disk (UR-15 & UR-31):
 * - Validates SVG structure (must contain <svg>)
 * - Strips <script> elements
 * - Strips on* event handlers (onload, onerror, etc.)
 * - Strips <foreignObject> elements
 * - Strips external references (http:, https:, //, javascript:, data: in href/xlink:href/@import)
 * - Writes sanitized content back to disk
 */
export async function sanitizeSvgFile(filePath: string): Promise<void> {
  const fs = await import('node:fs');
  const { ValidationError } = await import('../core/errors/app-error.js');
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lower = content.toLowerCase();

  // Basic well-formedness check
  if (!lower.includes('<svg')) {
    throw new ValidationError('Malformed SVG: Missing <svg> root element', {
      code: 'validation_failed',
    });
  }

  let sanitized = content;

  // 1. Strip <script>...</script>
  sanitized = sanitized.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    '',
  );
  sanitized = sanitized.replace(/<script\b[^>]*\/>/gi, '');

  // 2. Strip <foreignObject>...</foreignObject>
  sanitized = sanitized.replace(
    /<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi,
    '',
  );
  sanitized = sanitized.replace(/<foreignObject\b[^>]*\/>/gi, '');

  // 3. Strip inline event handlers: on\w+="...", on\w+='...'
  sanitized = sanitized.replace(/\s+on[a-z0-9_-]+\s*=\s*(['"]).*?\1/gi, '');
  sanitized = sanitized.replace(/\s+on[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '');

  // 4. Strip dangerous / external URIs in href and xlink:href
  sanitized = sanitized.replace(
    /\s+(?:xlink:)?href\s*=\s*(['"])\s*(?:javascript:|data:text\/html|https?:\/\/|\/\/)[^'"]*?\1/gi,
    '',
  );

  // 5. Strip @import in <style>
  sanitized = sanitized.replace(
    /@import\s+(?:url\([^)]+\)|['"][^'"]+['"])/gi,
    '',
  );

  await fs.promises.writeFile(filePath, sanitized, 'utf8');
}
