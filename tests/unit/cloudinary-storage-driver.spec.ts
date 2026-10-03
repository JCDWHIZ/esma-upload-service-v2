import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { v2 as cloudinaryType } from 'cloudinary';
import { PolicyViolationError } from '../../src/core/errors/app-error.js';
import { CloudinaryStorageDriver } from '../../src/storage/drivers/cloudinary.driver.js';

describe('CloudinaryStorageDriver Unit & Security Tests', () => {
  const driver = new CloudinaryStorageDriver({
    cloudName: 'test-cloud',
    apiKey: 'key-123',
    apiSecret: 'secret-456',
    rootFolder: 'uploads',
  });

  describe('Defense-in-Depth Policy Validation (F-26)', () => {
    it('refuses upload when visibility is "tenant" with PolicyViolationError', async () => {
      const payload = Buffer.from('private-tenant-data');
      await expect(
        driver.upload({
          key: 'tenants/sch-01/file.png',
          source: () => Readable.from(payload),
          size: payload.length,
          sha256: 'dummy-sha',
          mimetype: 'image/png',
          visibility: 'tenant',
        }),
      ).rejects.toThrow(PolicyViolationError);
    });

    it('refuses upload when visibility is "private" with PolicyViolationError', async () => {
      const payload = Buffer.from('confidential-user-data');
      await expect(
        driver.upload({
          key: 'system/documents/report.pdf',
          source: () => Readable.from(payload),
          size: payload.length,
          sha256: 'dummy-sha',
          mimetype: 'application/pdf',
          visibility: 'private',
        }),
      ).rejects.toThrow(PolicyViolationError);
    });
  });

  describe('Public ID Mapping Across Namespaces', () => {
    it('maps tenant school-scoped key to uploads/schools/...', () => {
      const { publicId, resourceType } = driver.computePublicId(
        'tenants/sch-999/avatar/profile.jpg',
        'image/jpeg',
      );
      expect(publicId).toBe('uploads/schools/sch-999/avatar/profile');
      expect(resourceType).toBe('image');
    });

    it('maps tenant branch-scoped key preserving branch path segment', () => {
      const { publicId, resourceType } = driver.computePublicId(
        'tenants/sch-999/branches/br-101/gallery/photo.png',
        'image/png',
      );
      expect(publicId).toBe(
        'uploads/schools/sch-999/branches/br-101/gallery/photo',
      );
      expect(resourceType).toBe('image');
    });

    it('maps admin system key to admin/...', () => {
      const { publicId, resourceType } = driver.computePublicId(
        'system/banners/main.webp',
        'image/webp',
      );
      expect(publicId).toBe('admin/banners/main');
      expect(resourceType).toBe('image');
    });

    it('maps generic key to rootFolder/...', () => {
      const { publicId, resourceType } = driver.computePublicId(
        'generic/assets/logo.svg',
        'image/svg+xml',
      );
      expect(publicId).toBe('uploads/generic/assets/logo');
      expect(resourceType).toBe('image');
    });

    it('retains extension for raw resource types', () => {
      const { publicId, resourceType } = driver.computePublicId(
        'tenants/sch-999/docs/syllabus.pdf',
        'application/pdf',
      );
      expect(publicId).toBe('uploads/schools/sch-999/docs/syllabus.pdf');
      expect(resourceType).toBe('raw');
    });
  });

  describe('Direct Delivery URL Generation', () => {
    it('builds direct URL with format and quality transformations', async () => {
      const ref = {
        provider: driver.name,
        key: 'system/logos/brand.png',
        meta: { public_id: 'admin/logos/brand' },
      };

      const url = await driver.getDirectUrl(ref, {
        transform: { width: 300, height: 200, format: 'webp', quality: 80 },
      });

      expect(typeof url).toBe('string');
      expect(url).toContain('admin/logos/brand');
    });
  });

  describe('Idempotent Deletion', () => {
    it('treats "not found" response from destroy as success', async () => {
      const mockDestroy = (): Promise<{ result: string }> =>
        Promise.resolve({ result: 'not found' });
      const mockCloudinary = {
        config: () => ({}),
        uploader: { destroy: mockDestroy },
      } as unknown as typeof cloudinaryType;

      const testDriver = new CloudinaryStorageDriver(
        { cloudName: 'c', apiKey: 'k', apiSecret: 's' },
        mockCloudinary,
      );

      await expect(
        testDriver.delete({
          provider: 'cloudinary',
          key: 'tenants/sch-01/avatar/non-existent.png',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('Health Probes', () => {
    it('returns ok: true when ping succeeds', async () => {
      const mockCloudinary = {
        config: () => ({}),
        api: {
          ping: (): Promise<{ status: string }> =>
            Promise.resolve({ status: 'ok' }),
        },
      } as unknown as typeof cloudinaryType;

      const testDriver = new CloudinaryStorageDriver(
        { cloudName: 'c', apiKey: 'k', apiSecret: 's' },
        mockCloudinary,
      );

      const health = await testDriver.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('returns ok: false when ping throws', async () => {
      const mockCloudinary = {
        config: () => ({}),
        api: {
          ping: (): Promise<{ status: string }> =>
            Promise.reject(new Error('Cloudinary API unreachable')),
        },
      } as unknown as typeof cloudinaryType;

      const testDriver = new CloudinaryStorageDriver(
        { cloudName: 'c', apiKey: 'k', apiSecret: 's' },
        mockCloudinary,
      );

      const health = await testDriver.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.detail).toContain('Cloudinary API unreachable');
    });
  });
});
