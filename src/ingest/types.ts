import { Readable } from 'node:stream';
import { UploadPolicy } from '../config/policies.js';

export interface IngestedFile {
  readonly fieldName: string;
  readonly originalName: string;
  readonly declaredMime: string;
  readonly detectedMime: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
  openReadStream(): Readable;
  dispose(): Promise<void>;
}

export type IngestShape =
  | { type: 'single'; fieldName?: string }
  | { type: 'array'; fieldName?: string; maxCount?: number }
  | { type: 'fields'; fields: Array<{ name: string; maxCount: number }> };

export interface ScanResult {
  readonly clean: boolean;
  readonly threat?: string;
  readonly scannedBytes?: number;
}

export interface IVirusScanner {
  scan(filePath: string): Promise<ScanResult>;
  scanStream(stream: Readable): Promise<ScanResult>;
  ping?(): Promise<boolean>;
}

export interface IngestValidationOptions {
  policy?: UploadPolicy;
  namespace?: string;
}
