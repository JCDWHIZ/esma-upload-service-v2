import { MIME_TO_EXT, assertSafeSegment } from '../core/storage-key.service.js';

export type Visibility = 'private' | 'tenant' | 'public';
export type ProviderName = 'local' | 'seaweedfs' | 'cloudinary';
export type CloudinaryReplication = 'never' | 'public-only' | 'always';

export interface StoragePolicyConfig {
  readonly primary?: ProviderName;
  readonly replicas?: readonly ProviderName[] | 'auto';
}

export interface FieldRule {
  readonly maxCount: number;
}

export interface UploadPolicy {
  readonly namespace: string;
  readonly maxFileSizeBytes: number;
  readonly maxFilesPerRequest: number;
  readonly allowedMimeTypes: readonly string[];
  readonly defaultVisibility: Visibility;
  readonly allowedVisibilities: readonly Visibility[];
  readonly storage?: StoragePolicyConfig;
  readonly cloudinaryReplication: CloudinaryReplication;
  readonly cloudinaryRootFolder: string;
  readonly requireVirusScan: boolean;
  readonly fieldRules?: Readonly<Record<string, FieldRule>>;
}

export interface PolicyValidationIssue {
  readonly namespace: string;
  readonly field: string;
  readonly message: string;
}

export class PolicyValidationError extends Error {
  constructor(public readonly issues: readonly PolicyValidationIssue[]) {
    const formatted = issues
      .map((i) => `  - [${i.namespace}] ${i.field}: ${i.message}`)
      .join('\n');
    super(
      `Upload policy validation failed with ${issues.length} issue(s):\n${formatted}`,
    );
    this.name = 'PolicyValidationError';
  }
}

/**
 * Recursively deep-freezes an object to guarantee immutability.
 */
export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

export const VALID_VISIBILITIES: readonly Visibility[] = Object.freeze([
  'private',
  'tenant',
  'public',
]);

export const VALID_PROVIDERS: readonly ProviderName[] = Object.freeze([
  'local',
  'seaweedfs',
  'cloudinary',
]);

export const VALID_CLOUDINARY_REPLICATIONS: readonly CloudinaryReplication[] =
  Object.freeze(['never', 'public-only', 'always']);

export const FORBIDDEN_MIME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^image\/svg/i,
  /^text\/html/i,
  /^text\/xml/i,
  /^application\/xml/i,
  /^application\/x-msdownload/i,
  /^application\/x-executable/i,
  /^application\/x-sh/i,
  /^application\/javascript/i,
  /^text\/javascript/i,
]);

export const STANDARD_IMAGE_MIMES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

export const STANDARD_DOC_MIMES: readonly string[] = Object.freeze([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const ESMA_TENANT_ALLOWED_MIMES: readonly string[] = Object.freeze([
  ...STANDARD_IMAGE_MIMES,
  ...STANDARD_DOC_MIMES,
]);

export const ESMA_ADMIN_ALLOWED_MIMES: readonly string[] = Object.freeze([
  ...STANDARD_IMAGE_MIMES,
  ...STANDARD_DOC_MIMES,
]);

/**
 * All safe MIME types registered in MIME_TO_EXT (excluding non-canonical aliases like image/jpg).
 */
export const GENERIC_DEFAULT_ALLOWED_MIMES: readonly string[] = Object.freeze(
  Object.keys(MIME_TO_EXT).filter((mime) => mime !== 'image/jpg'),
);

/**
 * Validates a single upload policy against system invariants.
 * Returns any validation issues found.
 */
export function validatePolicy(policy: UploadPolicy): PolicyValidationIssue[] {
  const issues: PolicyValidationIssue[] = [];
  const ns = policy.namespace || '<empty>';

  // Namespace check
  try {
    assertSafeSegment(policy.namespace, 'namespace');
  } catch (err: unknown) {
    issues.push({
      namespace: ns,
      field: 'namespace',
      message: err instanceof Error ? err.message : 'Invalid namespace segment',
    });
  }

  // Size limit check
  if (
    typeof policy.maxFileSizeBytes !== 'number' ||
    !Number.isInteger(policy.maxFileSizeBytes) ||
    policy.maxFileSizeBytes <= 0
  ) {
    issues.push({
      namespace: ns,
      field: 'maxFileSizeBytes',
      message: 'maxFileSizeBytes must be a positive integer',
    });
  }

  // Files per request check
  if (
    typeof policy.maxFilesPerRequest !== 'number' ||
    !Number.isInteger(policy.maxFilesPerRequest) ||
    policy.maxFilesPerRequest <= 0
  ) {
    issues.push({
      namespace: ns,
      field: 'maxFilesPerRequest',
      message: 'maxFilesPerRequest must be a positive integer',
    });
  }

  // Allowed MIME types checks
  if (
    !Array.isArray(policy.allowedMimeTypes) ||
    policy.allowedMimeTypes.length === 0
  ) {
    issues.push({
      namespace: ns,
      field: 'allowedMimeTypes',
      message: 'allowedMimeTypes must be a non-empty array of MIME strings',
    });
  } else {
    for (const mime of policy.allowedMimeTypes) {
      if (typeof mime !== 'string' || mime.trim().length === 0) {
        issues.push({
          namespace: ns,
          field: 'allowedMimeTypes',
          message: 'MIME types in allowlist must be non-empty strings',
        });
        continue;
      }

      // Check forbidden dangerous types (SVG, HTML, Executables)
      if (FORBIDDEN_MIME_PATTERNS.some((pat) => pat.test(mime))) {
        issues.push({
          namespace: ns,
          field: 'allowedMimeTypes',
          message: `Dangerous MIME type is forbidden: "${mime}"`,
        });
        continue;
      }

      // Check against MIME_TO_EXT mapping
      if (!(mime in MIME_TO_EXT)) {
        issues.push({
          namespace: ns,
          field: 'allowedMimeTypes',
          message: `MIME type "${mime}" has no extension mapping in MIME_TO_EXT`,
        });
      }
    }
  }

  // Visibilities check
  if (
    !Array.isArray(policy.allowedVisibilities) ||
    policy.allowedVisibilities.length === 0
  ) {
    issues.push({
      namespace: ns,
      field: 'allowedVisibilities',
      message: 'allowedVisibilities must be a non-empty array of Visibilities',
    });
  } else {
    for (const vis of policy.allowedVisibilities) {
      if (!(VALID_VISIBILITIES as readonly string[]).includes(String(vis))) {
        issues.push({
          namespace: ns,
          field: 'allowedVisibilities',
          message: `Invalid visibility "${String(vis)}". Must be one of: ${VALID_VISIBILITIES.join(', ')}`,
        });
      }
    }
  }

  if (
    !policy.defaultVisibility ||
    !(VALID_VISIBILITIES as readonly string[]).includes(
      policy.defaultVisibility,
    )
  ) {
    issues.push({
      namespace: ns,
      field: 'defaultVisibility',
      message: `Invalid defaultVisibility "${String(policy.defaultVisibility)}". Must be one of: ${VALID_VISIBILITIES.join(', ')}`,
    });
  } else if (
    Array.isArray(policy.allowedVisibilities) &&
    !(policy.allowedVisibilities as readonly string[]).includes(
      policy.defaultVisibility,
    )
  ) {
    issues.push({
      namespace: ns,
      field: 'defaultVisibility',
      message: `defaultVisibility "${policy.defaultVisibility}" must be included in allowedVisibilities [${policy.allowedVisibilities.join(', ')}]`,
    });
  }

  // Cloudinary replication
  if (
    !policy.cloudinaryReplication ||
    !(VALID_CLOUDINARY_REPLICATIONS as readonly string[]).includes(
      policy.cloudinaryReplication,
    )
  ) {
    issues.push({
      namespace: ns,
      field: 'cloudinaryReplication',
      message: `Invalid cloudinaryReplication "${String(policy.cloudinaryReplication)}". Must be one of: ${VALID_CLOUDINARY_REPLICATIONS.join(', ')}`,
    });
  }

  // Cloudinary root folder
  if (
    typeof policy.cloudinaryRootFolder !== 'string' ||
    policy.cloudinaryRootFolder.trim().length === 0
  ) {
    issues.push({
      namespace: ns,
      field: 'cloudinaryRootFolder',
      message: 'cloudinaryRootFolder must be a non-empty string',
    });
  }

  // Storage configuration (optional)
  if (policy.storage) {
    if (
      policy.storage.primary &&
      !(VALID_PROVIDERS as readonly string[]).includes(policy.storage.primary)
    ) {
      issues.push({
        namespace: ns,
        field: 'storage.primary',
        message: `Invalid primary storage provider "${String(policy.storage.primary)}". Must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    if (
      policy.storage.replicas &&
      policy.storage.replicas !== 'auto' &&
      Array.isArray(policy.storage.replicas)
    ) {
      for (const rep of policy.storage.replicas) {
        if (!(VALID_PROVIDERS as readonly string[]).includes(String(rep))) {
          issues.push({
            namespace: ns,
            field: 'storage.replicas',
            message: `Invalid replica storage provider "${String(rep)}". Must be one of: ${VALID_PROVIDERS.join(', ')}`,
          });
        }
      }
    }
  }

  // Field rules (optional)
  if (policy.fieldRules) {
    for (const [field, rule] of Object.entries(policy.fieldRules)) {
      try {
        assertSafeSegment(field, `fieldRules[${field}]`);
      } catch (err: unknown) {
        issues.push({
          namespace: ns,
          field: `fieldRules.${field}`,
          message:
            err instanceof Error ? err.message : 'Invalid field name segment',
        });
      }

      if (
        !rule ||
        typeof rule.maxCount !== 'number' ||
        !Number.isInteger(rule.maxCount) ||
        rule.maxCount <= 0
      ) {
        issues.push({
          namespace: ns,
          field: `fieldRules.${field}.maxCount`,
          message: 'maxCount must be a positive integer',
        });
      }
    }
  }

  return issues;
}

/**
 * Built-in default policies for ESMA upload services.
 */
export const DEFAULT_POLICIES: Readonly<Record<string, UploadPolicy>> =
  Object.freeze({
    'esma-tenant': deepFreeze<UploadPolicy>({
      namespace: 'esma-tenant',
      maxFileSizeBytes: 20 * 1024 * 1024,
      maxFilesPerRequest: 10,
      allowedMimeTypes: ESMA_TENANT_ALLOWED_MIMES,
      defaultVisibility: 'tenant',
      allowedVisibilities: ['private', 'tenant', 'public'],
      cloudinaryReplication: 'public-only',
      cloudinaryRootFolder: 'uploads/schools',
      requireVirusScan: false,
      fieldRules: {
        avatar: { maxCount: 1 },
        gallery: { maxCount: 5 },
        documents: { maxCount: 10 },
      },
    }),
    'esma-admin': deepFreeze<UploadPolicy>({
      namespace: 'esma-admin',
      maxFileSizeBytes: 20 * 1024 * 1024,
      maxFilesPerRequest: 10,
      allowedMimeTypes: ESMA_ADMIN_ALLOWED_MIMES,
      defaultVisibility: 'public',
      allowedVisibilities: ['public', 'tenant', 'private'],
      cloudinaryReplication: 'public-only',
      cloudinaryRootFolder: 'admin',
      requireVirusScan: false,
      fieldRules: {
        profile_image: { maxCount: 1 },
        gallery_images: { maxCount: 5 },
        documents: { maxCount: 3 },
      },
    }),
    'generic-default': deepFreeze<UploadPolicy>({
      namespace: 'generic-default',
      maxFileSizeBytes: 20 * 1024 * 1024,
      maxFilesPerRequest: 10,
      allowedMimeTypes: GENERIC_DEFAULT_ALLOWED_MIMES,
      defaultVisibility: 'private',
      allowedVisibilities: ['private', 'tenant', 'public'],
      cloudinaryReplication: 'public-only',
      cloudinaryRootFolder: 'uploads',
      requireVirusScan: false,
      fieldRules: {},
    }),
  });
