import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service.js';
import { StorageRegistry } from './registry.js';
import { StoragePlacementService } from './placement.service.js';

@Global()
@Module({
  providers: [StorageService, StorageRegistry, StoragePlacementService],
  exports: [StorageService, StorageRegistry, StoragePlacementService],
})
export class StorageModule {}
