import { ApiClient } from '../core/types.js';
import { VerifiedTokenClaims } from './context.js';

export interface JwtPrincipal {
  readonly type: 'jwt';
  readonly token: VerifiedTokenClaims;
}

export interface ApiKeyPrincipal {
  readonly type: 'api-key';
  readonly client: ApiClient;
}

export type AuthPrincipal = JwtPrincipal | ApiKeyPrincipal;
