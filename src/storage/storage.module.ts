import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module.js';
import { StorageService } from './storage.service.js';
import { StorageRegistry } from './registry.js';
import { StoragePlacementService } from './placement.service.js';
import { StoragePromoteService } from './storage-promote.service.js';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [
    StorageService,
    StorageRegistry,
    StoragePlacementService,
    StoragePromoteService,
  ],
  exports: [
    StorageService,
    StorageRegistry,
    StoragePlacementService,
    StoragePromoteService,
  ],
})
export class StorageModule {}
