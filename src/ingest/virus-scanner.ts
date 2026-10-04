import { Injectable, Logger } from '@nestjs/common';
import type { IVirusScanner, ScanResult } from './types.js';

export const VIRUS_SCANNER = 'VIRUS_SCANNER';

/**
 * No-op VirusScanner implementation.
 * ClamAvScanner is used when ClamAV scanning is enabled.
 */
@Injectable()
export class NoopVirusScanner implements IVirusScanner {
  private readonly logger = new Logger(NoopVirusScanner.name);

  scan(filePath: string): Promise<ScanResult> {
    this.logger.debug(
      `NoopVirusScanner: passing file without scan (${filePath})`,
    );
    return Promise.resolve({ clean: true, scannedBytes: 0 });
  }

  scanStream(): Promise<ScanResult> {
    this.logger.debug('NoopVirusScanner: passing stream without scan');
    return Promise.resolve({ clean: true, scannedBytes: 0 });
  }

  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
