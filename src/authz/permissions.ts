/**
 * Canonical dot-notation permissions for ESMA upload service domain (UR-10).
 */
export const CanonicalPermissions = {
  FILE_UPLOAD: 'files.file.upload',
  FILE_READ: 'files.file.read',
  FILE_READ_ANY: 'files.file.read.any',
  FILE_LIST: 'files.file.list',
  FILE_DELETE: 'files.file.delete',
  FILE_DELETE_ANY: 'files.file.delete.any',
  FILE_ADMIN: 'files.file.admin',
  QUOTA_VIEW: 'files.quota.view',
  QUOTA_MANAGE: 'files.quota.manage',
  AUDIT_VIEW: 'files.audit.view',
  PLATFORM_ADMIN: 'platform.files.admin',
  PLATFORM_DLQ_MANAGE: 'platform.files.dlq.manage',
} as const;

export type CanonicalPermission =
  (typeof CanonicalPermissions)[keyof typeof CanonicalPermissions];

/**
 * Legacy snake_case permissions (kept as aliases until UR-25).
 */
export const UploadPermissions = {
  QUOTAS_MANAGE: 'quotas_manage',
  QUOTAS_VIEW: 'quotas_view',
  SYSTEM_FILES_UPLOAD: 'system_files_upload',
  SYSTEM_FILES_DELETE: 'system_files_delete',
  SYSTEM_FILES_READ: 'system_files_read',
  SYSTEM_FILES_LIST: 'system_files_list',
  TENANTS_USAGE_VIEW: 'tenants_usage_view',
  AUDIT_VIEW: 'audit_view',
  FILES_BULK_DELETE: 'files_bulk_delete',

  FILES_UPLOAD: 'files_upload',
  FILES_READ: 'files_read',
  FILES_LIST: 'files_list',
  FILES_DELETE: 'files_delete',
  FILES_ADMIN: 'files_admin',
  BRANCHES_MANAGE: 'branches_manage',
} as const;

export type UploadPermission =
  (typeof UploadPermissions)[keyof typeof UploadPermissions];

/**
 * Mapping between aliases and canonical permissions.
 */
const CANONICAL_MAPPINGS: Readonly<Record<string, { canonical: string; legacy: string }>> = Object.freeze({
  'files.file.upload': { canonical: CanonicalPermissions.FILE_UPLOAD, legacy: UploadPermissions.FILES_UPLOAD },
  'files_upload': { canonical: CanonicalPermissions.FILE_UPLOAD, legacy: UploadPermissions.FILES_UPLOAD },
  'upload_files_upload': { canonical: CanonicalPermissions.FILE_UPLOAD, legacy: UploadPermissions.FILES_UPLOAD },
  'upload_file_upload': { canonical: CanonicalPermissions.FILE_UPLOAD, legacy: UploadPermissions.FILES_UPLOAD },

  'files.file.read': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },
  'files_read': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },
  'upload_files_read': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },
  'upload_file_read': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },
  'upload_files_view': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },
  'upload_file_view': { canonical: CanonicalPermissions.FILE_READ, legacy: UploadPermissions.FILES_READ },

  'files.file.read.any': { canonical: CanonicalPermissions.FILE_READ_ANY, legacy: 'files_read_any' },
  'files_read_any': { canonical: CanonicalPermissions.FILE_READ_ANY, legacy: 'files_read_any' },

  'files.file.list': { canonical: CanonicalPermissions.FILE_LIST, legacy: UploadPermissions.FILES_LIST },
  'files_list': { canonical: CanonicalPermissions.FILE_LIST, legacy: UploadPermissions.FILES_LIST },
  'upload_files_list': { canonical: CanonicalPermissions.FILE_LIST, legacy: UploadPermissions.FILES_LIST },
  'upload_file_list': { canonical: CanonicalPermissions.FILE_LIST, legacy: UploadPermissions.FILES_LIST },

  'files.file.delete': { canonical: CanonicalPermissions.FILE_DELETE, legacy: UploadPermissions.FILES_DELETE },
  'files_delete': { canonical: CanonicalPermissions.FILE_DELETE, legacy: UploadPermissions.FILES_DELETE },
  'upload_files_delete': { canonical: CanonicalPermissions.FILE_DELETE, legacy: UploadPermissions.FILES_DELETE },
  'upload_file_delete': { canonical: CanonicalPermissions.FILE_DELETE, legacy: UploadPermissions.FILES_DELETE },

  'files.file.delete.any': { canonical: CanonicalPermissions.FILE_DELETE_ANY, legacy: 'files_delete_any' },
  'files_delete_any': { canonical: CanonicalPermissions.FILE_DELETE_ANY, legacy: 'files_delete_any' },

  'files.file.admin': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },
  'files_admin': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },
  'upload_files_admin': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },
  'upload_files_manage': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },
  'upload_file_admin': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },
  'upload_file_manage': { canonical: CanonicalPermissions.FILE_ADMIN, legacy: UploadPermissions.FILES_ADMIN },

  'files.quota.view': { canonical: CanonicalPermissions.QUOTA_VIEW, legacy: UploadPermissions.QUOTAS_VIEW },
  'quotas_view': { canonical: CanonicalPermissions.QUOTA_VIEW, legacy: UploadPermissions.QUOTAS_VIEW },
  'quota_view': { canonical: CanonicalPermissions.QUOTA_VIEW, legacy: UploadPermissions.QUOTAS_VIEW },
  'upload_quotas_view': { canonical: CanonicalPermissions.QUOTA_VIEW, legacy: UploadPermissions.QUOTAS_VIEW },
  'upload_quota_view': { canonical: CanonicalPermissions.QUOTA_VIEW, legacy: UploadPermissions.QUOTAS_VIEW },

  'files.quota.manage': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'quotas_manage': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'quota_manage': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'quotas_edit': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'quota_edit': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'upload_quotas_manage': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'upload_quota_manage': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'upload_quotas_edit': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },
  'upload_quota_edit': { canonical: CanonicalPermissions.QUOTA_MANAGE, legacy: UploadPermissions.QUOTAS_MANAGE },

  'files.audit.view': { canonical: CanonicalPermissions.AUDIT_VIEW, legacy: UploadPermissions.AUDIT_VIEW },
  'audit_view': { canonical: CanonicalPermissions.AUDIT_VIEW, legacy: UploadPermissions.AUDIT_VIEW },
  'upload_audit_view': { canonical: CanonicalPermissions.AUDIT_VIEW, legacy: UploadPermissions.AUDIT_VIEW },

  'platform.files.admin': { canonical: CanonicalPermissions.PLATFORM_ADMIN, legacy: 'platform_files_admin' },
  'platform_files_admin': { canonical: CanonicalPermissions.PLATFORM_ADMIN, legacy: 'platform_files_admin' },

  'platform.files.dlq.manage': { canonical: CanonicalPermissions.PLATFORM_DLQ_MANAGE, legacy: 'platform_dlq_manage' },
  'platform_dlq_manage': { canonical: CanonicalPermissions.PLATFORM_DLQ_MANAGE, legacy: 'platform_dlq_manage' },

  'upload_branches_manage': { canonical: 'upload_branches_manage', legacy: UploadPermissions.BRANCHES_MANAGE },
  'branches_manage': { canonical: 'branches_manage', legacy: UploadPermissions.BRANCHES_MANAGE },
});

/**
 * Normalizes a permission string to canonical dot-notation form (UR-10),
 * supporting legacy uppercase, snake_case, and typo aliases.
 */
export function normalizePermission(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed in CANONICAL_MAPPINGS) {
    return CANONICAL_MAPPINGS[trimmed].canonical;
  }

  // Handle quoata typo normalization
  const sanitized = trimmed.replace(/quoat[a]?/g, 'quot').replace(/[:.-]/g, '_');
  if (sanitized in CANONICAL_MAPPINGS) {
    return CANONICAL_MAPPINGS[sanitized].canonical;
  }

  // If already standard dot notation or unknown permission, return as trimmed lowercase
  return trimmed;
}

/**
 * Normalizes a list of raw permission strings, ensuring both canonical dot-notation
 * and backward-compatible aliases are preserved in the returned set.
 */
export function normalizePermissions(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) {
    return [];
  }
  const result = new Set<string>();
  for (const item of rawList) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        const lower = trimmed.toLowerCase();
        result.add(lower);

        const canonical = normalizePermission(lower);
        result.add(canonical);

        const mapping = CANONICAL_MAPPINGS[lower] ?? CANONICAL_MAPPINGS[canonical];
        if (mapping) {
          result.add(mapping.canonical);
          result.add(mapping.legacy);
        }

        const snake = lower.replace(/[:.-]/g, '_');
        result.add(snake);
      }
    }
  }
  return Array.from(result);
}
