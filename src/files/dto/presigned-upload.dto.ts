import type { FileVisibility } from '../../core/types.js';

export interface InitiatePresignedUploadDto {
  filename: string;
  sizeBytes: number;
  mimeType: string;
  branchId?: string;
  folder?: string;
  visibility?: FileVisibility;
  tags?: string[];
  attributes?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface InitiatePresignedUploadResponse {
  fileId: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface CompletePresignedUploadDto {
  clientEtag?: string;
  sha256?: string;
}
