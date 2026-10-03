import { Module } from '@nestjs/common';
import { IngestValidationPipe } from './ingest-validation.pipe.js';
import { StagingCleanupInterceptor } from './staging-cleanup.js';
import { NoopVirusScanner, VIRUS_SCANNER } from './virus-scanner.js';
import { ConfigModule } from '../config/config.module.js';

@Module({
  imports: [ConfigModule],
  providers: [
    IngestValidationPipe,
    StagingCleanupInterceptor,
    {
      provide: VIRUS_SCANNER,
      useClass: NoopVirusScanner,
    },
    NoopVirusScanner,
  ],
  exports: [
    IngestValidationPipe,
    StagingCleanupInterceptor,
    VIRUS_SCANNER,
    NoopVirusScanner,
  ],
})
export class IngestModule {}
