import { z } from 'zod';
import type {
  FileRecord,
  FileReplica,
  FileVisibility,
  Provider,
  ReplicationStatus,
  ScanStatus,
} from './types.js';

export interface FileReplicaManifest {
  status: string;
  syncedAt: string | null;
}

export interface FileManifestData {
  fileId: string;
  filename: string;
  mimetype: string;
  size: number;
  sha256: string | null;
  visibility: FileVisibility;
  canonicalUrl: string;
  publicUrl: string | null;
  primaryProvider: Provider;
  replicas: Record<string, FileReplicaManifest>;
  replicationStatus: ReplicationStatus;
  scanStatus: ScanStatus;
  createdAt: string;
}

export interface UploadManifestResponse {
  success: boolean;
  message: string;
  data: FileManifestData;
}

export interface ToManifestOptions {
  message?: string;
  skippedProviders?: Provider[];
}

/**
 * Maps a stored FileRecord and its FileReplicas to the canonical manifest DTO per ARCH §9.2.
 */
export function toManifest(
  file: FileRecord,
  replicas: FileReplica[],
  appBaseUrl: string,
  options?: ToManifestOptions,
): UploadManifestResponse {
  const cleanBaseUrl = appBaseUrl.replace(/\/+$/, '');
  const prefix = cleanBaseUrl.endsWith('/uploads') ? '' : '/uploads';
  const canonicalUrl = `${cleanBaseUrl}${prefix}/api/v1/files/${file.id}`;

  // publicUrl is set only for public files once a CDN replica is AVAILABLE (ARCH §9.2)
  let publicUrl: string | null = null;
  if (file.visibility === 'public') {
    const cdnReplica = replicas.find(
      (r) =>
        r.status === 'AVAILABLE' &&
        (r.provider === 'cloudinary' || r.url !== null),
    );
    if (cdnReplica && cdnReplica.url) {
      publicUrl = cdnReplica.url;
    }
  }

  const replicasMap: Record<string, FileReplicaManifest> = {};
  for (const replica of replicas) {
    replicasMap[replica.provider] = {
      status: replica.status,
      syncedAt: replica.syncedAt ? replica.syncedAt.toISOString() : null,
    };
  }

  if (options?.skippedProviders) {
    for (const provider of options.skippedProviders) {
      if (!replicasMap[provider]) {
        replicasMap[provider] = {
          status: 'SKIPPED_BY_POLICY',
          syncedAt: null,
        };
      }
    }
  }

  const defaultMessage =
    file.replicationStatus === 'QUEUED'
      ? 'File uploaded. Replication to secondary storage is queued.'
      : 'File uploaded successfully.';

  return {
    success: true,
    message: options?.message ?? defaultMessage,
    data: {
      fileId: file.id,
      filename: file.originalFilename,
      mimetype: file.mimetype,
      size: Number(file.sizeBytes),
      sha256: file.sha256,
      visibility: file.visibility,
      canonicalUrl,
      publicUrl,
      primaryProvider: file.primaryProvider,
      replicas: replicasMap,
      replicationStatus: file.replicationStatus,
      scanStatus: file.scanStatus,
      createdAt: file.createdAt.toISOString(),
    },
  };
}

export const fileReplicaManifestSchema = z.object({
  status: z.string(),
  syncedAt: z.string().datetime().nullable(),
});

export const fileManifestDataSchema = z.object({
  fileId: z.string().uuid(),
  filename: z.string().min(1),
  mimetype: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  visibility: z.enum(['private', 'tenant', 'public']),
  canonicalUrl: z.string().url(),
  publicUrl: z.string().url().nullable(),
  primaryProvider: z.enum(['local', 'seaweedfs', 'cloudinary']),
  replicas: z.record(z.string(), fileReplicaManifestSchema),
  replicationStatus: z.enum([
    'NOT_REQUIRED',
    'QUEUED',
    'IN_PROGRESS',
    'SYNCED',
    'PARTIAL',
    'FAILED',
  ]),
  scanStatus: z.enum(['NOT_REQUIRED', 'PENDING', 'CLEAN', 'INFECTED', 'ERROR']),
  createdAt: z.string().datetime(),
});

export const uploadManifestResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: fileManifestDataSchema,
});
