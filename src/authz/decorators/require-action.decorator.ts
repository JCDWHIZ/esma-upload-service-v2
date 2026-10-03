import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { AuthzAction } from '../matrix-rules.js';

export const REQUIRE_ACTION_KEY = 'authz:require_action';

/**
 * Decorator to declare the required authorization action for an endpoint or controller.
 * Evaluated by AuthorizationGuard.
 *
 * @param action The required action: 'upload' | 'read' | 'list' | 'delete' | 'admin'
 */
export const RequireAction = (action: AuthzAction): CustomDecorator<string> =>
  SetMetadata(REQUIRE_ACTION_KEY, action);
