import { Module } from '@nestjs/common';
import { FilesController } from './files.controller.js';
import { HealthController } from './health.controller.js';
import { FilesService } from './files.service.js';
import { UploadService } from './upload.service.js';
import { FileReadService } from './file-read.service.js';
import { SignedUrlService } from './signed-url.service.js';
import { DeleteService } from './delete.service.js';
import { FileQueryService } from './file-query.service.js';
import { PresignedUploadService } from './presigned-upload.service.js';
import { KeyService } from '../core/storage-key.service.js';
import { AuthorizationModule } from '../authz/authorization.module.js';
import { NoOpQuotaGate, QUOTA_GATE } from './quota-gate.interface.js';

import { AuthModule } from '../auth/auth.module.js';
import { IngestModule } from '../ingest/ingest.module.js';

@Module({
  imports: [AuthorizationModule, AuthModule, IngestModule],
  controllers: [FilesController, HealthController],
  providers: [
    FilesService,
    UploadService,
    FileReadService,
    SignedUrlService,
    DeleteService,
    FileQueryService,
    PresignedUploadService,
    KeyService,
    {
      provide: QUOTA_GATE,
      useClass: NoOpQuotaGate,
    },
  ],
  exports: [
    FilesService,
    UploadService,
    FileReadService,
    SignedUrlService,
    DeleteService,
    FileQueryService,
    PresignedUploadService,
    KeyService,
    QUOTA_GATE,
  ],
})
export class FilesModule {}
