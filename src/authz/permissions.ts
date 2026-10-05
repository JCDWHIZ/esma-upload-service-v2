/**
 * Canonical snake_case permissions for the upload service domain.
 */
export const UploadPermissions = {
  // --- Platform / ESMA Admin (system namespace) ---
  QUOTAS_MANAGE: 'quotas_manage',
  QUOTAS_VIEW: 'quotas_view',
  SYSTEM_FILES_UPLOAD: 'system_files_upload',
  SYSTEM_FILES_DELETE: 'system_files_delete',
  SYSTEM_FILES_READ: 'system_files_read',
  SYSTEM_FILES_LIST: 'system_files_list',
  TENANTS_USAGE_VIEW: 'tenants_usage_view',
  AUDIT_VIEW: 'audit_view',
  FILES_BULK_DELETE: 'files_bulk_delete',

  // --- School / Organization Scope (esma-tenant namespace) ---
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
 * Domain-prefixed and action alias mappings to canonical snake_case permissions.
 */
const PERMISSION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Quotas & Storage limits (supports upload.quoatas.view, upload.quotas.view, etc.)
  upload_quotas_view: UploadPermissions.QUOTAS_VIEW,
  upload_quoatas_view: UploadPermissions.QUOTAS_VIEW,
  upload_quota_view: UploadPermissions.QUOTAS_VIEW,
  upload_quoata_view: UploadPermissions.QUOTAS_VIEW,
  upload_quotas_manage: UploadPermissions.QUOTAS_MANAGE,
  upload_quoatas_manage: UploadPermissions.QUOTAS_MANAGE,
  upload_quota_manage: UploadPermissions.QUOTAS_MANAGE,
  upload_quoata_manage: UploadPermissions.QUOTAS_MANAGE,
  upload_quotas_edit: UploadPermissions.QUOTAS_MANAGE,
  upload_quoatas_edit: UploadPermissions.QUOTAS_MANAGE,
  upload_quota_edit: UploadPermissions.QUOTAS_MANAGE,
  upload_quoata_edit: UploadPermissions.QUOTAS_MANAGE,
  quotas_view: UploadPermissions.QUOTAS_VIEW,
  quoatas_view: UploadPermissions.QUOTAS_VIEW,
  quota_view: UploadPermissions.QUOTAS_VIEW,
  quoata_view: UploadPermissions.QUOTAS_VIEW,
  quotas_manage: UploadPermissions.QUOTAS_MANAGE,
  quoatas_manage: UploadPermissions.QUOTAS_MANAGE,
  quota_manage: UploadPermissions.QUOTAS_MANAGE,
  quoata_manage: UploadPermissions.QUOTAS_MANAGE,
  quotas_edit: UploadPermissions.QUOTAS_MANAGE,
  quoatas_edit: UploadPermissions.QUOTAS_MANAGE,
  quota_edit: UploadPermissions.QUOTAS_MANAGE,
  quoata_edit: UploadPermissions.QUOTAS_MANAGE,

  // Tenant / Files
  upload_files_upload: UploadPermissions.FILES_UPLOAD,
  upload_file_upload: UploadPermissions.FILES_UPLOAD,
  upload_files_read: UploadPermissions.FILES_READ,
  upload_file_read: UploadPermissions.FILES_READ,
  upload_files_view: UploadPermissions.FILES_READ,
  upload_file_view: UploadPermissions.FILES_READ,
  upload_files_list: UploadPermissions.FILES_LIST,
  upload_file_list: UploadPermissions.FILES_LIST,
  upload_files_delete: UploadPermissions.FILES_DELETE,
  upload_file_delete: UploadPermissions.FILES_DELETE,
  upload_files_admin: UploadPermissions.FILES_ADMIN,
  upload_files_manage: UploadPermissions.FILES_ADMIN,
  upload_file_admin: UploadPermissions.FILES_ADMIN,
  upload_file_manage: UploadPermissions.FILES_ADMIN,
  upload_branches_manage: UploadPermissions.BRANCHES_MANAGE,
  upload_branch_manage: UploadPermissions.BRANCHES_MANAGE,
  branch_manage: UploadPermissions.BRANCHES_MANAGE,

  // System files & audit
  upload_system_files_upload: UploadPermissions.SYSTEM_FILES_UPLOAD,
  upload_system_files_delete: UploadPermissions.SYSTEM_FILES_DELETE,
  upload_system_files_read: UploadPermissions.SYSTEM_FILES_READ,
  upload_system_files_list: UploadPermissions.SYSTEM_FILES_LIST,
  upload_tenants_usage_view: UploadPermissions.TENANTS_USAGE_VIEW,
  upload_usage_view: UploadPermissions.TENANTS_USAGE_VIEW,
  upload_audit_view: UploadPermissions.AUDIT_VIEW,
  upload_files_bulk_delete: UploadPermissions.FILES_BULK_DELETE,
});

/**
 * Normalizes a permission string from any casing/separator format
 * (e.g. "FILES_UPLOAD", "files:upload", "Files_Upload", "upload.quoatas.view") into canonical lowercase snake_case.
 */
export function normalizePermission(raw: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/quoat[a]?/g, 'quot')
    .replace(/[:.-]/g, '_');

  if (sanitized in PERMISSION_ALIASES) {
    return PERMISSION_ALIASES[sanitized];
  }

  // Also test raw snake before replacement
  const rawSnake = raw.trim().toLowerCase().replace(/[:.-]/g, '_');
  if (rawSnake in PERMISSION_ALIASES) {
    return PERMISSION_ALIASES[rawSnake];
  }

  // If prefixed with upload_ and remainder matches a known canonical permission, strip prefix
  if (sanitized.startsWith('upload_')) {
    const stripped = sanitized.slice(7);
    if (stripped in PERMISSION_ALIASES) {
      return PERMISSION_ALIASES[stripped];
    }
    const canonicalValues: readonly string[] = Object.values(UploadPermissions);
    if (canonicalValues.includes(stripped)) {
      return stripped;
    }
  }

  return sanitized;
}

/**
 * Normalizes a list of raw permission strings, discarding non-strings and empty values,
 * and returning a unique array of canonical snake_case permissions including aliases.
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
        const canonical = normalizePermission(trimmed);
        result.add(canonical);

        // Also add the snake_cased version if different (e.g. upload_quotas_view)
        const snake = trimmed
          .toLowerCase()
          .replace(/quoata/g, 'quota')
          .replace(/[:.-]/g, '_');
        if (snake !== canonical) {
          result.add(snake);
        }
        // Also add raw snake if it had typo variations (e.g. upload_quoatas_view)
        const rawSnake = trimmed.toLowerCase().replace(/[:.-]/g, '_');
        if (rawSnake !== canonical && rawSnake !== snake) {
          result.add(rawSnake);
        }
      }
    }
  }
  return Array.from(result);
}
