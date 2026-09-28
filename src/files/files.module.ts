import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { HealthController } from './health.controller.js';
import { FilesService } from './files.service.js';
import { UploadService } from './upload.service.js';
import { KeyService } from '../core/storage-key.service.js';
import { AuthorizationModule } from '../authz/authorization.module.js';
import { NoOpQuotaGate, QUOTA_GATE } from './quota-gate.interface.js';

@Module({
  imports: [AuthorizationModule],
  controllers: [FilesController, HealthController],
  providers: [
    FilesService,
    UploadService,
    KeyService,
    {
      provide: QUOTA_GATE,
      useClass: NoOpQuotaGate,
    },
  ],
  exports: [FilesService, UploadService, KeyService, QUOTA_GATE],
})
export class FilesModule {}
