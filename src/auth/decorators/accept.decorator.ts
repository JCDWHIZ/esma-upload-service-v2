import { SetMetadata } from '@nestjs/common';

export type CredentialType =
  'school-jwt' | 'admin-jwt' | 'api-key' | 'bearer-jwt';

export const ACCEPT_CREDENTIALS_KEY = 'acceptCredentials';

/**
 * Decorator to specify which credential types are accepted by a route or controller.
 * Examples:
 *   @Accept('school-jwt')
 *   @Accept('admin-jwt')
 *   @Accept('api-key')
 *   @Accept('school-jwt', 'admin-jwt')
 */
export const Accept = (...credentials: CredentialType[]) =>
  SetMetadata(ACCEPT_CREDENTIALS_KEY, credentials);
