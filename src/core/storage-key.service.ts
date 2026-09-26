import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { ValidationError } from './errors/app-error.js';

export interface StorageKeyContext {
  namespace: string;
  tenantId: string;
  subTenantId?: string | null;
}

export interface StorageKeyOptions {
  folder?: string;
  fieldname?: string;
}

export interface LegacyPublicIdPolicy {
  namespace: string;
  cloudinaryRootFolder?: string;
}

/**
 * Strict allowlist map of MIME types to canonical file extensions.
 * Follows ARCH §3.3 (extensions come strictly from detected MIME, never client input).
 */
export const MIME_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
});

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validates that a path segment is safe according to ARCH §3.3.
 *
 * Rules:
 * - Must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$
 * - Must not be '.' or '..'
 * - Maximum length 128 characters
 * - Rejects slashes, backslashes, control characters, null bytes
 */
export function assertSafeSegment(
  segment: unknown,
  fieldName = 'Path segment',
): asserts segment is string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new ValidationError(`${fieldName} must be a non-empty string`, {
      detail: `Received ${typeof segment === 'string' ? 'empty string' : typeof segment}`,
    });
  }

  if (segment.length > 128) {
    throw new ValidationError(
      `${fieldName} exceeds maximum allowable length of 128 characters`,
      {
        detail: `Segment length is ${segment.length}`,
      },
    );
  }

  if (segment === '.' || segment === '..') {
    throw new ValidationError(
      `${fieldName} cannot be a relative dot reference (${segment})`,
    );
  }

  if (segment.includes('\0')) {
    throw new ValidationError(
      `${fieldName} contains forbidden null byte character`,
    );
  }

  if (!SAFE_SEGMENT_REGEX.test(segment)) {
    throw new ValidationError(
      `${fieldName} contains invalid characters or does not start with an alphanumeric character: "${segment}"`,
      {
        detail: `Must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`,
      },
    );
  }
}

/**
 * Gets the canonical extension for a detected MIME type.
 * Throws ValidationError if the MIME type is unmapped.
 */
export function getExtForMime(detectedMime: string): string {
  const normalized = detectedMime.toLowerCase().trim();
  const ext = MIME_TO_EXT[normalized];
  if (!ext) {
    throw new ValidationError(
      `Unsupported or unmapped MIME type: "${detectedMime}"`,
      {
        detail: `Detected MIME type must be registered in the allowlist`,
      },
    );
  }
  return ext;
}

/**
 * Resolves a relative path inside a root directory safely, guarding against
 * path traversal and symlink/escape attacks (used by LocalStorageDriver).
 */
export function resolveInside(root: string, relative: string): string {
  if (root.includes('\0') || relative.includes('\0')) {
    throw new ValidationError('Path contains forbidden null byte character');
  }

  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relative);

  const rel = path.relative(resolvedRoot, resolvedTarget);

  // If path.relative starts with '..' or is absolute, it resolved outside resolvedRoot
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError(
      'Path traversal detected: resolves outside root',
      {
        detail: `Attempted access outside root directory`,
      },
    );
  }

  // Windows safety check: ensure target begins with root + separator or matches root
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(resolvedRoot + path.sep)
  ) {
    throw new ValidationError('Path traversal detected: root boundary escaped');
  }

  return resolvedTarget;
}

/**
 * KeyService provides deterministic, safe, driver-agnostic storage keys.
 * Conforms to ARCH §3.3.
 */
@Injectable()
export class KeyService {
  /**
   * Builds a driver-agnostic storage key from context and file metadata.
   */
  static build(
    ctx: StorageKeyContext,
    options: StorageKeyOptions,
    fileId: string,
    detectedMime: string,
  ): string {
    assertSafeSegment(fileId, 'fileId');
    const ext = getExtForMime(detectedMime);
    const fileWithExt = `${fileId}${ext}`;

    // Parse folder segments if provided
    const folderSegments: string[] = [];
    if (options.folder && options.folder.trim().length > 0) {
      // Allow forward or back slashes separating folder levels, validate each segment
      const rawSegments = options.folder.split(/[/\\]+/).filter(Boolean);
      for (const seg of rawSegments) {
        assertSafeSegment(seg, 'folder segment');
        folderSegments.push(seg);
      }
    }

    // Parse fieldname if provided
    if (options.fieldname && options.fieldname.trim().length > 0) {
      assertSafeSegment(options.fieldname, 'fieldname');
      folderSegments.push(options.fieldname);
    }

    const isSystemScope =
      ctx.namespace === 'esma-admin' || ctx.tenantId === 'system';

    if (isSystemScope) {
      const parts = ['system', ...folderSegments, fileWithExt];
      return parts.join('/');
    }

    // Tenant / Organization scope
    assertSafeSegment(ctx.tenantId, 'tenantId');

    // Branch scope if subTenantId is provided and non-empty
    if (ctx.subTenantId && ctx.subTenantId.trim().length > 0) {
      assertSafeSegment(ctx.subTenantId, 'subTenantId');
      const parts = [
        'tenants',
        ctx.tenantId,
        'branches',
        ctx.subTenantId,
        ...folderSegments,
        fileWithExt,
      ];
      return parts.join('/');
    }

    // School / Organization scope
    const parts = ['tenants', ctx.tenantId, ...folderSegments, fileWithExt];
    return parts.join('/');
  }

  /**
   * Instance delegate for dependency injection.
   */
  build(
    ctx: StorageKeyContext,
    options: StorageKeyOptions,
    fileId: string,
    detectedMime: string,
  ): string {
    return KeyService.build(ctx, options, fileId, detectedMime);
  }

  /**
   * Maps a storage key to the legacy public_id convention (ARCH §3.3).
   */
  static toLegacyPublicId(
    policy: LegacyPublicIdPolicy,
    key: string,
    resourceType = 'image',
  ): string {
    // Determine whether to strip the file extension (Cloudinary image/video strips extension)
    const isRaw = resourceType === 'raw';
    const parsed = path.posix.parse(key.replace(/\\/g, '/'));
    const cleanKey = isRaw
      ? key.replace(/\\/g, '/')
      : path.posix.join(parsed.dir, parsed.name);

    if (policy.namespace === 'esma-admin') {
      if (cleanKey.startsWith('system/')) {
        return cleanKey.replace(/^system\//, 'admin/');
      }
      return `admin/${cleanKey}`;
    }

    if (policy.namespace === 'esma-tenant') {
      // Check branch pattern
      const branchMatch = cleanKey.match(
        /^tenants\/([^/]+)\/branches\/([^/]+)\/(.*)$/,
      );
      if (branchMatch) {
        const [, schoolId, branchId, rest] = branchMatch;
        return `uploads/schools/${schoolId}/branches/${branchId}/${rest}`;
      }

      // Check tenant pattern
      const tenantMatch = cleanKey.match(/^tenants\/([^/]+)\/(.*)$/);
      if (tenantMatch) {
        const [, schoolId, rest] = tenantMatch;
        return `uploads/schools/${schoolId}/${rest}`;
      }

      return `uploads/schools/${cleanKey}`;
    }

    // Generic namespaces
    const root = policy.cloudinaryRootFolder ?? 'uploads';
    return `${root}/${cleanKey}`;
  }

  /**
   * Instance delegate for dependency injection.
   */
  toLegacyPublicId(
    policy: LegacyPublicIdPolicy,
    key: string,
    resourceType = 'image',
  ): string {
    return KeyService.toLegacyPublicId(policy, key, resourceType);
  }

  /**
   * Path traversal shield for local storage paths.
   */
  resolveInside(root: string, relative: string): string {
    return resolveInside(root, relative);
  }
}
