import { SetMetadata } from '@nestjs/common';
import { ContextNamespace } from '../context.js';

export const NAMESPACE_METADATA_KEY = 'auth:namespace';

/**
 * Decorator to parameterize route controllers or handlers with an expected ingress namespace.
 * Used by ContextGuard to pick the appropriate ContextResolver.
 *
 * @example
 * @Namespace('esma-tenant')
 * @Controller('api/v1/files')
 * export class FilesController {}
 */
export const Namespace = (namespace: ContextNamespace) =>
  SetMetadata(NAMESPACE_METADATA_KEY, namespace);
