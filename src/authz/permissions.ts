/**
 * Canonical snake_case permissions for the upload service domain.
 */
export const UploadPermissions = {
  // --- Platform / ESMA Admin (system namespace) ---
  QUOTAS_MANAGE: 'quotas_manage',
  QUOTAS_VIEW: 'quotas_view',
  SYSTEM_FILES_UPLOAD: 'system_files_upload',
  SYSTEM_FILES_DELETE: 'system_files_delete',
  TENANTS_USAGE_VIEW: 'tenants_usage_view',
  AUDIT_VIEW: 'audit_view',
  FILES_BULK_DELETE: 'files_bulk_delete',

  // --- School / Organization Scope (esma-tenant namespace) ---
  FILES_UPLOAD: 'files_upload',
  FILES_READ: 'files_read',
  FILES_DELETE: 'files_delete',
  BRANCHES_MANAGE: 'branches_manage',
} as const;

export type UploadPermission =
  (typeof UploadPermissions)[keyof typeof UploadPermissions];

/**
 * Normalizes a permission string from any casing/separator format
 * (e.g. "FILES_UPLOAD", "files:upload", "Files_Upload") into canonical lowercase snake_case.
 */
export function normalizePermission(raw: string): string {
  return raw.trim().toLowerCase().replace(/[:-]/g, '_');
}

/**
 * Normalizes a list of raw permission strings, discarding non-strings and empty values,
 * and returning a unique array of canonical snake_case permissions.
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
        result.add(normalizePermission(trimmed));
      }
    }
  }
  return Array.from(result);
}
