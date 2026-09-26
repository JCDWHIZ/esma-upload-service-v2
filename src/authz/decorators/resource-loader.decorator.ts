import { SetMetadata, CustomDecorator, Type } from '@nestjs/common';
import { ResourceLoader } from '../resource-loader.js';

export const RESOURCE_LOADER_KEY = 'authz:resource_loader';

/**
 * Decorator to explicitly specify a custom ResourceLoader for an endpoint or controller.
 */
export const UseResourceLoader = (
  loaderType: Type<ResourceLoader>,
): CustomDecorator<string> => SetMetadata(RESOURCE_LOADER_KEY, loaderType);
