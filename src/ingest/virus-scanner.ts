import { Injectable, Logger } from '@nestjs/common';
import { IVirusScanner } from './types.js';

export const VIRUS_SCANNER = 'VIRUS_SCANNER';

/**
 * No-op VirusScanner implementation for Phase 1.
 * Real ClamAV scanner will be injected in Phase 5 (P5-07).
 */
@Injectable()
export class NoopVirusScanner implements IVirusScanner {
  private readonly logger = new Logger(NoopVirusScanner.name);

  scan(filePath: string): Promise<{ clean: boolean; threat?: string }> {
    this.logger.debug(
      `NoopVirusScanner: passing file without scan (${filePath})`,
    );
    return Promise.resolve({ clean: true });
  }
}
