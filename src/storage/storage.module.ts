import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { StorageRegistry } from './registry.js';

@Global()
@Module({
  providers: [StorageService, StorageRegistry],
  exports: [StorageService, StorageRegistry],
})
export class StorageModule {}
