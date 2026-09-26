import {
  evaluateBranchAccess,
  BranchAccessCheckInput,
} from '../src/authz/branch-access.js';
import {
  normalizePermission,
  normalizePermissions,
  UploadPermissions,
} from '../src/authz/permissions.js';

describe('Permissions & Normalization (snake_case)', () => {
  it('normalizes single permission to lowercase snake_case', () => {
    expect(normalizePermission('FILES_UPLOAD')).toBe('files_upload');
    expect(normalizePermission('files:upload')).toBe('files_upload');
    expect(normalizePermission('Files-Upload')).toBe('files_upload');
    expect(normalizePermission('  QUOTAS_VIEW  ')).toBe('quotas_view');
  });

  it('normalizes list of permissions, trims, and deduplicates', () => {
    const raw = [
      'FILES_UPLOAD',
      'files:upload',
      'FILES_READ',
      '  ',
      123,
      null,
      'quotas_view',
      'QUOTAS_VIEW',
    ];
    const normalized = normalizePermissions(raw);
    expect(normalized).toEqual(['files_upload', 'files_read', 'quotas_view']);
  });

  it('handles non-array inputs gracefully', () => {
    expect(normalizePermissions(null)).toEqual([]);
    expect(normalizePermissions(undefined)).toEqual([]);
    expect(normalizePermissions('FILES_UPLOAD')).toEqual([]);
  });

  it('exports canonical upload permissions constants', () => {
    expect(UploadPermissions.FILES_UPLOAD).toBe('files_upload');
    expect(UploadPermissions.FILES_READ).toBe('files_read');
    expect(UploadPermissions.FILES_DELETE).toBe('files_delete');
    expect(UploadPermissions.QUOTAS_VIEW).toBe('quotas_view');
    expect(UploadPermissions.QUOTAS_MANAGE).toBe('quotas_manage');
    expect(UploadPermissions.BRANCHES_MANAGE).toBe('branches_manage');
  });
});

describe('Branch Authority Evaluation (evaluateBranchAccess)', () => {
  it('allows platform admin unconditionally', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-xyz',
      branchGrants: [],
      isSchoolAdmin: false,
      isPlatformAdmin: true,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });

  it('allows user with matching explicit branch grant', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-north',
      branchGrants: ['branch-north', 'branch-south'],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });

  it('denies branch-scoped user when requesting ungranted branch', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-east',
      branchGrants: ['branch-north'],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    };
    const result = evaluateBranchAccess(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(
      "not authorized to access branch 'branch-east'",
    );
  });

  it('denies branch-scoped user when attempting root school scope without specifying branch', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: undefined,
      branchGrants: ['branch-north'],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    };
    const result = evaluateBranchAccess(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Actor is branch-scoped');
  });

  it('allows school admin with empty branches array to access any branch', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-custom',
      branchGrants: [],
      isSchoolAdmin: true,
      isPlatformAdmin: false,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });

  it('allows school admin with wildcard branch grant to access any branch', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-custom',
      branchGrants: ['*'],
      isSchoolAdmin: true,
      isPlatformAdmin: false,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });

  it('allows school admin to access root school scope', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: undefined,
      branchGrants: [],
      isSchoolAdmin: true,
      isPlatformAdmin: false,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });

  it('denies non-admin member with empty branches array from accessing a specific branch', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: 'branch-forbidden',
      branchGrants: [],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    };
    const result = evaluateBranchAccess(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(
      "not authorized to access branch 'branch-forbidden'",
    );
  });

  it('allows non-admin member with empty branches array to access root school scope', () => {
    const input: BranchAccessCheckInput = {
      targetBranchId: undefined,
      branchGrants: [],
      isSchoolAdmin: false,
      isPlatformAdmin: false,
    };
    expect(evaluateBranchAccess(input)).toEqual({ allowed: true });
  });
});
