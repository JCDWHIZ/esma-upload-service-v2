import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FileVisibility } from '../../core/types.js';

export class InitiatePresignedUploadDto {
  @ApiProperty({
    description: 'Original name of the file to be uploaded',
    example: 'video_lecture_2026.mp4',
  })
  filename!: string;

  @ApiProperty({
    description: 'Exact file size in bytes to reserve against tenant quota',
    example: 104857600,
  })
  sizeBytes!: number;

  @ApiProperty({
    description: 'MIME type of the file payload',
    example: 'video/mp4',
  })
  mimeType!: string;

  @ApiPropertyOptional({
    description: 'Branch ID within the tenant',
    example: 'branch_lagos_01',
  })
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Logical folder path',
    example: 'courses/lectures',
  })
  folder?: string;

  @ApiPropertyOptional({
    enum: ['public', 'tenant', 'subtenant', 'private'],
    default: 'tenant',
    description: 'Visibility level',
  })
  visibility?: FileVisibility;

  @ApiPropertyOptional({
    description: 'Tags for searching and categorizing',
    example: ['lecture', 'physics'],
  })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Arbitrary key-value metadata',
    example: { courseId: 'PHY101' },
  })
  attributes?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Presigned PUT URL validity in seconds (default 900s)',
    example: 900,
    default: 900,
  })
  expiresInSeconds?: number;
}

export class InitiatePresignedUploadResponse {
  @ApiProperty({ example: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90' })
  fileId!: string;

  @ApiProperty({
    description: 'Direct S3 Presigned PUT URL for upload',
    example:
      'https://s3.esma.example/esma-files/generic/0198f3a2/video.mp4?X-Amz-Signature=...',
  })
  uploadUrl!: string;

  @ApiProperty({
    description: 'Headers that must accompany the client PUT upload',
    example: { 'Content-Type': 'video/mp4' },
  })
  requiredHeaders!: Record<string, string>;

  @ApiProperty({
    description: 'ISO 8601 timestamp after which the upload URL expires',
    example: '2026-09-28T12:15:00.000Z',
  })
  expiresAt!: string;
}

export class CompletePresignedUploadDto {
  @ApiPropertyOptional({
    description: 'ETag header returned by S3 after successful PUT',
    example: '"9b105d4c9e12ecb530c31449320ce0ed"',
  })
  clientEtag?: string;

  @ApiPropertyOptional({
    description: 'Optional client-computed SHA-256 hash',
    example: '9f2b5c0a1d7e4b6a8c3f0e1d2a4b6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c',
  })
  sha256?: string;
}
