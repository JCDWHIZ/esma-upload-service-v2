import { describe, it, expect } from 'vitest';
import {
  toManifest,
  uploadManifestResponseSchema,
  fileManifestDataSchema,
} from '../../src/core/manifest.js';
import type { FileRecord, FileReplica } from '../../src/core/types.js';

describe('Manifest Mapper and Schema Verification (ARCH §9.2)', () => {
  const sampleArchManifest = {
    success: true,
    message: 'File uploaded. Replication to secondary storage is queued.',
    data: {
      fileId: '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
      filename: 'academic_report_2026.pdf',
      mimetype: 'application/pdf',
      size: 2458902,
      sha256:
        '9f2b5c0a1d7e4b6a8c3f0e1d2a4b6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c',
      visibility: 'tenant',
      canonicalUrl:
        'https://upload.esma.example/api/v1/files/0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90',
      publicUrl: null,
      primaryProvider: 'seaweedfs',
      replicas: {
        seaweedfs: {
          status: 'AVAILABLE',
          syncedAt: '2026-09-21T12:00:00.120Z',
        },
        local: {
          status: 'QUEUED',
          syncedAt: null,
        },
        cloudinary: {
          status: 'SKIPPED_BY_POLICY',
          syncedAt: null,
        },
      },
      replicationStatus: 'QUEUED',
      scanStatus: 'NOT_REQUIRED',
      createdAt: '2026-09-21T12:00:00.125Z',
    },
  };

  it('validates the verbatim sample manifest from ARCH §9.2 against Zod schema', () => {
    const parseResult =
      uploadManifestResponseSchema.safeParse(sampleArchManifest);
    expect(parseResult.success).toBe(true);
  });

  it('generates a valid manifest via toManifest for single-driver mode', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const mockFile: FileRecord = {
      id: '01923cb1-3a1b-7c42-88f2-2b3f114c0001',
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      subTenantId: 'branch-456',
      folder: 'reports',
      storageKey:
        'tenants/school-123/branches/branch-456/reports/01923cb1-3a1b-7c42-88f2-2b3f114c0001.pdf',
      originalFilename: 'report.pdf',
      mimetype: 'application/pdf',
      declaredMimetype: 'application/pdf',
      sizeBytes: 1048576n,
      sha256:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      visibility: 'tenant',
      status: 'ACTIVE',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: 'local',
      uploadedBy: 'user-001',
      tags: ['annual', 'finance'],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: '01923cb1-3a1b-7c42-88f2-2b3f114c0002',
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const mockReplica: FileReplica = {
      fileId: mockFile.id,
      provider: 'local',
      role: 'primary',
      status: 'AVAILABLE',
      providerKey: mockFile.storageKey,
      providerMeta: {},
      url: null,
      etag: 'etag-123',
      attempts: 0,
      lastError: null,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const manifest = toManifest(
      mockFile,
      [mockReplica],
      'https://api.upload.example.com',
    );

    expect(manifest.success).toBe(true);
    expect(manifest.message).toBe('File uploaded successfully.');
    expect(manifest.data.fileId).toBe(mockFile.id);
    expect(manifest.data.canonicalUrl).toBe(
      `https://api.upload.example.com/api/v1/files/${mockFile.id}`,
    );
    expect(manifest.data.publicUrl).toBeNull();
    expect(manifest.data.size).toBe(1048576);
    expect(manifest.data.replicas.local).toEqual({
      status: 'AVAILABLE',
      syncedAt: '2026-09-28T12:00:00.000Z',
    });

    const parsed = uploadManifestResponseSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });

  it('sets publicUrl when visibility is public and CDN replica is AVAILABLE', () => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    const mockFile: FileRecord = {
      id: '01923cb1-3a1b-7c42-88f2-2b3f114c0003',
      namespace: 'esma-tenant',
      tenantId: 'school-123',
      subTenantId: null,
      folder: 'avatars',
      storageKey:
        'tenants/school-123/avatars/01923cb1-3a1b-7c42-88f2-2b3f114c0003.jpg',
      originalFilename: 'avatar.jpg',
      mimetype: 'image/jpeg',
      declaredMimetype: 'image/jpeg',
      sizeBytes: 20480n,
      sha256: 'a1b2c3d4e5f6',
      visibility: 'public',
      status: 'ACTIVE',
      scanStatus: 'NOT_REQUIRED',
      replicationStatus: 'NOT_REQUIRED',
      primaryProvider: 'cloudinary',
      uploadedBy: 'user-001',
      tags: [],
      attributes: {},
      legacyPublicId: null,
      idempotencyKey: null,
      correlationId: '01923cb1-3a1b-7c42-88f2-2b3f114c0004',
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const mockReplica: FileReplica = {
      fileId: mockFile.id,
      provider: 'cloudinary',
      role: 'primary',
      status: 'AVAILABLE',
      providerKey: 'uploads/schools/school-123/avatars/avatar',
      providerMeta: {},
      url: 'https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg',
      etag: null,
      attempts: 0,
      lastError: null,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const manifest = toManifest(
      mockFile,
      [mockReplica],
      'https://upload.esma.example',
      { skippedProviders: ['local', 'seaweedfs'] },
    );

    expect(manifest.data.publicUrl).toBe(
      'https://res.cloudinary.com/demo/image/upload/v1/avatar.jpg',
    );
    expect(manifest.data.replicas.local).toEqual({
      status: 'SKIPPED_BY_POLICY',
      syncedAt: null,
    });
    expect(manifest.data.replicas.seaweedfs).toEqual({
      status: 'SKIPPED_BY_POLICY',
      syncedAt: null,
    });

    const parsed = uploadManifestResponseSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid manifests missing required fields or invalid UUIDs', () => {
    const invalid = {
      fileId: 'not-a-uuid',
      filename: '',
      size: -10,
    };
    const parsed = fileManifestDataSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});
