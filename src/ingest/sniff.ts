import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIME_TO_EXT } from '../core/storage-key.service.js';
import { MimeMismatchError } from '../core/errors/app-error.js';

export interface DetectedType {
  readonly mime: string;
  readonly ext: string;
}

/**
 * Sniffs the real MIME type and canonical extension from file magic bytes on disk.
 * Follows ARCH §4.4 and ADR-16.
 */
export async function detectFileType(
  filePath: string,
  declaredMime?: string,
  originalName?: string,
): Promise<DetectedType | null> {
  let fd: fs.promises.FileHandle | undefined;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);

    if (bytesRead === 0) {
      return null;
    }

    const buf = buffer.subarray(0, bytesRead);
    return sniffMagicBytes(buf, declaredMime, originalName);
  } catch {
    return null;
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}

/**
 * Inspects a header byte buffer against known file signatures.
 */
export function sniffMagicBytes(
  buf: Buffer,
  declaredMime?: string,
  originalName?: string,
): DetectedType | null {
  const ext = originalName ? path.extname(originalName).toLowerCase() : '';
  const normDeclared = declaredMime?.toLowerCase().trim();

  // 1. Dangerous format detection (fast reject)
  // Windows PE Executable (MZ)
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    return { mime: 'application/x-msdownload', ext: '.exe' };
  }
  // Linux ELF
  if (
    buf.length >= 4 &&
    buf[0] === 0x7f &&
    buf.subarray(1, 4).toString('ascii') === 'ELF'
  ) {
    return { mime: 'application/x-executable', ext: '.elf' };
  }
  // Shell script
  if (buf.length >= 2 && buf.subarray(0, 2).toString('ascii') === '#!') {
    return { mime: 'application/x-sh', ext: '.sh' };
  }

  // 2. Standard image formats
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }

  // JPEG: FF D8 FF
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // GIF: GIF87a or GIF89a
  if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    return { mime: 'image/gif', ext: '.gif' };
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  // BMP: 42 4D
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: 'image/bmp', ext: '.bmp' };
  }

  // TIFF: II*. or MM.*
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 &&
      buf[1] === 0x49 &&
      buf[2] === 0x2a &&
      buf[3] === 0x00) ||
      (buf[0] === 0x4d &&
        buf[1] === 0x4d &&
        buf[2] === 0x00 &&
        buf[3] === 0x2a))
  ) {
    return { mime: 'image/tiff', ext: '.tiff' };
  }

  // 3. Documents
  // PDF: %PDF-
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mime: 'application/pdf', ext: '.pdf' };
  }

  // ZIP / Office OpenXML (DOCX, XLSX, PPTX): PK\x03\x04
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05)
  ) {
    // Check internal directory structure markers
    const textSample = buf.toString('latin1');
    if (
      textSample.includes('word/') ||
      ext === '.docx' ||
      normDeclared ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: '.docx',
      };
    }

    if (
      textSample.includes('xl/') ||
      ext === '.xlsx' ||
      normDeclared ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ext: '.xlsx',
      };
    }

    if (
      textSample.includes('ppt/') ||
      ext === '.pptx' ||
      normDeclared ===
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ) {
      return {
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ext: '.pptx',
      };
    }

    return { mime: 'application/zip', ext: '.zip' };
  }

  // OLE Compound Document (legacy DOC, XLS, PPT): D0 CF 11 E0 A1 B1 1A E1
  if (
    buf.length >= 8 &&
    buf[0] === 0xd0 &&
    buf[1] === 0xcf &&
    buf[2] === 0x11 &&
    buf[3] === 0xe0 &&
    buf[4] === 0xa1 &&
    buf[5] === 0xb1 &&
    buf[6] === 0x1a &&
    buf[7] === 0xe1
  ) {
    if (ext === '.xls' || normDeclared === 'application/vnd.ms-excel') {
      return { mime: 'application/vnd.ms-excel', ext: '.xls' };
    }
    if (ext === '.ppt' || normDeclared === 'application/vnd.ms-powerpoint') {
      return { mime: 'application/vnd.ms-powerpoint', ext: '.ppt' };
    }
    return { mime: 'application/msword', ext: '.doc' };
  }

  // 4. Audio / Video
  // MP3: ID3 or sync frame
  if (
    (buf.length >= 3 && buf.subarray(0, 3).toString('ascii') === 'ID3') ||
    (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
  ) {
    return { mime: 'audio/mpeg', ext: '.mp3' };
  }

  // WAV: RIFF....WAVE
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { mime: 'audio/wav', ext: '.wav' };
  }

  // OGG: OggS
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') {
    return { mime: 'audio/ogg', ext: '.ogg' };
  }

  // MP4 / QuickTime: ....ftyp or ....moov
  if (
    buf.length >= 8 &&
    (buf.subarray(4, 8).toString('ascii') === 'ftyp' ||
      buf.subarray(4, 8).toString('ascii') === 'moov')
  ) {
    if (ext === '.mov' || normDeclared === 'video/quicktime') {
      return { mime: 'video/quicktime', ext: '.mov' };
    }
    return { mime: 'video/mp4', ext: '.mp4' };
  }

  // WebM: 1A 45 DF A3
  if (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return { mime: 'video/webm', ext: '.webm' };
  }

  // 5. Text-based format inspection (JSON, CSV, Plain Text, SVG, HTML)
  // Check if buffer is valid text
  let isText = true;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
      isText = false;
      break;
    }
  }

  if (isText) {
    const textSample = buf.toString('utf8').trim().toLowerCase();

    // Check SVG or HTML (forbidden)
    if (textSample.includes('<svg') || textSample.startsWith('<?xml')) {
      if (textSample.includes('<svg')) {
        return { mime: 'image/svg+xml', ext: '.svg' };
      }
    }
    if (
      textSample.startsWith('<!doctype html') ||
      textSample.includes('<html')
    ) {
      return { mime: 'text/html', ext: '.html' };
    }

    // Check JSON
    if (
      (textSample.startsWith('{') && textSample.endsWith('}')) ||
      (textSample.startsWith('[') && textSample.endsWith(']'))
    ) {
      try {
        JSON.parse(buf.toString('utf8').trim());
        return { mime: 'application/json', ext: '.json' };
      } catch {
        // Fall through
      }
    }

    if (ext === '.csv' || normDeclared === 'text/csv') {
      return { mime: 'text/csv', ext: '.csv' };
    }

    if (ext === '.txt' || normDeclared === 'text/plain') {
      return { mime: 'text/plain', ext: '.txt' };
    }
  }

  return null;
}

/**
 * Checks for contradictions between detected MIME and client-declared MIME / filename extension.
 * Throws MimeMismatchError if a contradiction is detected (ARCH §4.4).
 */
export function assertMimeCompatibility(
  detectedMime: string,
  declaredMime?: string,
  originalName?: string,
): void {
  const normDetected = detectedMime.toLowerCase().trim();

  // 1. Check client-declared MIME header
  if (declaredMime && declaredMime.trim().length > 0) {
    const normDeclared = declaredMime.toLowerCase().trim();

    // Allow generic fallback octet-stream
    if (normDeclared !== 'application/octet-stream') {
      // JPEG alias compatibility
      const isJpegAlias =
        (normDetected === 'image/jpeg' && normDeclared === 'image/jpg') ||
        (normDetected === 'image/jpg' && normDeclared === 'image/jpeg');

      if (normDetected !== normDeclared && !isJpegAlias) {
        throw new MimeMismatchError(
          `Declared MIME type "${declaredMime}" contradicts detected content type "${detectedMime}"`,
          {
            detail: `Detected "${detectedMime}", client claimed "${declaredMime}"`,
          },
        );
      }
    }
  }

  // 2. Check filename extension if originalName is provided
  if (originalName) {
    const ext = path.extname(originalName).toLowerCase();
    if (ext.length > 0) {
      // Find what extension the detected MIME should map to
      const expectedExt = MIME_TO_EXT[normDetected];
      if (expectedExt) {
        // Handle common extension aliases (e.g. .jpeg and .jpg)
        const isJpgMatch =
          expectedExt === '.jpg' && (ext === '.jpg' || ext === '.jpeg');
        const isTiffMatch =
          expectedExt === '.tiff' && (ext === '.tiff' || ext === '.tif');

        if (ext !== expectedExt && !isJpgMatch && !isTiffMatch) {
          // Check if ext belongs to a different mapped MIME type entirely
          const conflictingMime = Object.entries(MIME_TO_EXT).find(
            ([, e]) => e === ext,
          )?.[0];
          if (conflictingMime && conflictingMime !== normDetected) {
            throw new MimeMismatchError(
              `Filename extension "${ext}" contradicts detected content type "${detectedMime}"`,
              {
                detail: `Detected "${detectedMime}", filename extension is "${ext}"`,
              },
            );
          }
        }
      }
    }
  }
}
