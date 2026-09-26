import { RequestContext } from '../auth/context.js';
import {
  AuthzAction,
  AuthzDecision,
  AuthzEvaluationContext,
  AuthzResource,
  MATRIX_RULES,
  isEsmaAdminActor,
  isSchoolAdminActor,
  isBranchScopedActor,
} from './matrix-rules.js';

export type {
  AuthzAction,
  AuthzDecision,
  AuthzEvaluationContext,
  AuthzResource,
};

export { isEsmaAdminActor, isSchoolAdminActor, isBranchScopedActor };

/**
 * Pure evaluation function for the authorization engine.
 * Encodes the ARCH §4.2 matrix and F-42 exact tenant isolation rules
 * via a deterministic declarative rule table.
 */
export function authorize(
  ctxOrInput: RequestContext | AuthzEvaluationContext,
  action?: AuthzAction,
  resource?: AuthzResource,
  adminAllowedRoles?: string[],
): AuthzDecision {
  const input: AuthzEvaluationContext =
    'ctx' in ctxOrInput && 'action' in ctxOrInput && 'resource' in ctxOrInput
      ? ctxOrInput
      : {
          ctx: ctxOrInput,
          action: action!,
          resource: resource!,
          adminAllowedRoles,
        };

  for (const rule of MATRIX_RULES) {
    if (rule.matches(input)) {
      return rule.evaluate(input);
    }
  }

  return {
    allowed: false,
    reason: 'Action denied by default: no matching rule found',
    ruleId: 'DENY_BY_DEFAULT',
  };
}
