import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark an endpoint or controller as publicly accessible,
 * bypassing authentication checks in AuthGuard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
