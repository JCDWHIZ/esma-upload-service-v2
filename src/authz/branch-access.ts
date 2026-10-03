export interface BranchAccessCheckInput {
  targetBranchId?: string;
  branchGrants: readonly string[];
  isSchoolAdmin: boolean;
  isPlatformAdmin: boolean;
}

export interface BranchAccessDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Pure evaluation of branch authority:
 * - Platform Admin: allowed for any branch or root.
 * - When no targetBranchId is requested (school root operation):
 *     - If user is branch-scoped (has branch grants) and is NOT a school admin -> DENIED (must specify their assigned branch).
 *     - Otherwise -> ALLOWED.
 * - When a targetBranchId is requested:
 *     - If targetBranchId is in user's branchGrants -> ALLOWED.
 *     - If user is school admin with unrestricted branch access (branchGrants is empty or includes '*') -> ALLOWED.
 *     - Otherwise -> DENIED.
 */
export function evaluateBranchAccess(
  input: BranchAccessCheckInput,
): BranchAccessDecision {
  if (input.isPlatformAdmin) {
    return { allowed: true };
  }

  const targetBranch =
    typeof input.targetBranchId === 'string' &&
    input.targetBranchId.trim().length > 0
      ? input.targetBranchId.trim()
      : undefined;

  // 1. Root school scope request (no branchId specified)
  if (!targetBranch) {
    if (input.branchGrants.length > 0 && !input.isSchoolAdmin) {
      return {
        allowed: false,
        reason: 'Actor is branch-scoped and must specify a permitted branch',
      };
    }
    return { allowed: true };
  }

  // 2. Specific branch requested: user has explicit grant
  if (input.branchGrants.includes(targetBranch)) {
    return { allowed: true };
  }

  // 3. School admin with unrestricted branch access
  if (
    input.isSchoolAdmin &&
    (input.branchGrants.length === 0 || input.branchGrants.includes('*'))
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Actor is not authorized to access branch '${targetBranch}'`,
  };
}
