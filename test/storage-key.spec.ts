import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  newId,
  hashFile,
  hashBuffer,
  createHashingTransform,
  KeyService,
  assertSafeSegment,
  getExtForMime,
  ValidationError,
} from '../src/core/index.js';

describe('Task P1-07: Identifiers, Hashing and Storage Key Service', () => {
  describe('newId (UUIDv7)', () => {
    it('generates valid UUIDv7 strings', () => {
      const id = newId();
      expect(typeof id).toBe('string');
      // UUID format 8-4-4-4-12
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates monotonic, unique IDs over consecutive calls', () => {
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(newId());
      }
      const unique = new Set(ids);
      expect(unique.size).toBe(50);

      // Verify lexicographical order roughly correlates with generation order
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i] >= ids[i - 1]).toBe(true);
      }
    });
  });

  describe('Hashing Utilities', () => {
    const sampleContent = 'Hello ESMA Upload Service v2!';
    // SHA-256 of "Hello ESMA Upload Service v2!"
    // echo -n "Hello ESMA Upload Service v2!" | sha256sum
    // 04aa96ef7be421ff0a23e5904fc498d9ba8842cce4237ebfdab1264c7b808940
    let expectedHash: string;
    let tempFilePath: string;

    beforeAll(async () => {
      expectedHash = hashBuffer(Buffer.from(sampleContent, 'utf-8'));
      tempFilePath = path.join(
        os.tmpdir(),
        `test-hash-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      await fs.promises.writeFile(tempFilePath, sampleContent, 'utf-8');
    });

    afterAll(async () => {
      try {
        await fs.promises.unlink(tempFilePath);
      } catch {
        // ignore
      }
    });

    it('computes correct SHA-256 for in-memory buffer', () => {
      const hash = hashBuffer(Buffer.from(sampleContent, 'utf-8'));
      expect(hash).toBe(expectedHash);
      expect(hash).toHaveLength(64);
    });

    it('computes correct SHA-256 for a file on disk via streaming', async () => {
      const hash = await hashFile(tempFilePath);
      expect(hash).toBe(expectedHash);
    });

    it('computes hash on the fly with createHashingTransform()', async () => {
      const transform = createHashingTransform();
      const chunks: Buffer[] = [];

      transform.on('data', (chunk: Buffer) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      const source = Readable.from([
        Buffer.from('Hello '),
        Buffer.from('ESMA Upload '),
        Buffer.from('Service v2!'),
      ]);

      await pipeline(source, transform);

      const received = Buffer.concat(chunks).toString('utf-8');
      expect(received).toBe(sampleContent);
      expect(transform.getDigest('hex')).toBe(expectedHash);
    });
  });

  describe('assertSafeSegment', () => {
    it('accepts valid segments', () => {
      expect(() => assertSafeSegment('school-123')).not.toThrow();
      expect(() => assertSafeSegment('branch_456.data')).not.toThrow();
      expect(() => assertSafeSegment('media')).not.toThrow();
      expect(() => assertSafeSegment('file-123_abc.ext')).not.toThrow();
    });

    it('rejects empty string or non-string', () => {
      expect(() => assertSafeSegment('')).toThrow(ValidationError);
      expect(() => assertSafeSegment(null as any)).toThrow(ValidationError);
      expect(() => assertSafeSegment(undefined as any)).toThrow(
        ValidationError,
      );
    });

    it('rejects dot and double-dot traversal', () => {
      expect(() => assertSafeSegment('.')).toThrow(ValidationError);
      expect(() => assertSafeSegment('..')).toThrow(ValidationError);
    });

    it('rejects segments with slashes or backslashes', () => {
      expect(() => assertSafeSegment('a/b')).toThrow(ValidationError);
      expect(() => assertSafeSegment('a\\b')).toThrow(ValidationError);
      expect(() => assertSafeSegment('/root')).toThrow(ValidationError);
    });

    it('rejects segments exceeding 128 characters', () => {
      const longStr = 'a'.repeat(129);
      expect(() => assertSafeSegment(longStr)).toThrow(ValidationError);

      const maxStr = 'a'.repeat(128);
      expect(() => assertSafeSegment(maxStr)).not.toThrow();
    });

    it('rejects null bytes and control characters', () => {
      expect(() => assertSafeSegment('abc\0def')).toThrow(ValidationError);
      expect(() => assertSafeSegment('abc\n')).toThrow(ValidationError);
      expect(() => assertSafeSegment('abc\r\n')).toThrow(ValidationError);
    });
  });

  describe('MIME_TO_EXT and getExtForMime', () => {
    it('resolves standard extensions', () => {
      expect(getExtForMime('image/jpeg')).toBe('.jpg');
      expect(getExtForMime('image/png')).toBe('.png');
      expect(getExtForMime('application/pdf')).toBe('.pdf');
      expect(getExtForMime('text/csv')).toBe('.csv');
      expect(getExtForMime('IMAGE/PNG')).toBe('.png'); // case insensitive
    });

    it('throws ValidationError for unmapped MIME types', () => {
      expect(() => getExtForMime('application/x-executable')).toThrow(
        ValidationError,
      );
      expect(() => getExtForMime('text/html')).toThrow(ValidationError);
      expect(() => getExtForMime('image/svg+xml')).toThrow(ValidationError);
    });
  });

  describe('KeyService.build (ARCH §3.3 table)', () => {
    const fileId = '018f3a55-bc1b-7d23-9034-45e305615712';
    const detectedMime = 'image/jpeg';

    it('Row 1: Organization/School scope with folder', () => {
      const key = KeyService.build(
        { namespace: 'esma-tenant', tenantId: 'SCH_001' },
        { folder: 'banners' },
        fileId,
        detectedMime,
      );
      expect(key).toBe(`tenants/SCH_001/banners/${fileId}.jpg`);
    });

    it('Row 1b: Organization/School scope without folder', () => {
      const key = KeyService.build(
        { namespace: 'esma-tenant', tenantId: 'SCH_001' },
        {},
        fileId,
        detectedMime,
      );
      expect(key).toBe(`tenants/SCH_001/${fileId}.jpg`);
    });

    it('Row 2: Branch scope with folder', () => {
      const key = KeyService.build(
        {
          namespace: 'esma-tenant',
          tenantId: 'SCH_001',
          subTenantId: 'BR_MAIN',
        },
        { folder: 'student-docs' },
        fileId,
        'application/pdf',
      );
      expect(key).toBe(
        `tenants/SCH_001/branches/BR_MAIN/student-docs/${fileId}.pdf`,
      );
    });

    it('Row 2b: Branch scope without folder', () => {
      const key = KeyService.build(
        {
          namespace: 'esma-tenant',
          tenantId: 'SCH_001',
          subTenantId: 'BR_MAIN',
        },
        {},
        fileId,
        'application/pdf',
      );
      expect(key).toBe(`tenants/SCH_001/branches/BR_MAIN/${fileId}.pdf`);
    });

    it('Row 3: System/Admin scope with folder', () => {
      const key = KeyService.build(
        { namespace: 'esma-admin', tenantId: 'system' },
        { folder: 'system-assets' },
        fileId,
        'image/png',
      );
      expect(key).toBe(`system/system-assets/${fileId}.png`);
    });

    it('Row 3b: System/Admin scope without folder', () => {
      const key = KeyService.build(
        { namespace: 'esma-admin', tenantId: 'system' },
        {},
        fileId,
        'image/png',
      );
      expect(key).toBe(`system/${fileId}.png`);
    });

    it('Supports multi-field upload with fieldname', () => {
      const key = KeyService.build(
        { namespace: 'esma-admin', tenantId: 'system' },
        { folder: 'onboarding', fieldname: 'logo' },
        fileId,
        'image/png',
      );
      expect(key).toBe(`system/onboarding/logo/${fileId}.png`);
    });

    it('Supports nested folder segments safely', () => {
      const key = KeyService.build(
        { namespace: 'esma-tenant', tenantId: 'SCH_001' },
        { folder: 'media/gallery' },
        fileId,
        'image/webp',
      );
      expect(key).toBe(`tenants/SCH_001/media/gallery/${fileId}.webp`);
    });

    it('Rejects hostile tenantId or folder attempts in key build', () => {
      expect(() =>
        KeyService.build(
          { namespace: 'esma-tenant', tenantId: '../escape' },
          { folder: 'banners' },
          fileId,
          detectedMime,
        ),
      ).toThrow(ValidationError);

      expect(() =>
        KeyService.build(
          { namespace: 'esma-tenant', tenantId: 'SCH_001' },
          { folder: 'banners/../../etc' },
          fileId,
          detectedMime,
        ),
      ).toThrow(ValidationError);
    });

    it('Works via DI instance method', () => {
      const service = new KeyService();
      const key = service.build(
        { namespace: 'esma-tenant', tenantId: 'SCH_002' },
        { folder: 'avatars' },
        fileId,
        'image/png',
      );
      expect(key).toBe(`tenants/SCH_002/avatars/${fileId}.png`);
    });
  });

  describe('toLegacyPublicId', () => {
    it('maps admin scope keys (replaces system/ with admin/)', () => {
      const publicId = KeyService.toLegacyPublicId(
        { namespace: 'esma-admin' },
        'system/banners/logo/018f3a55-bc1b-7d23.jpg',
        'image',
      );
      expect(publicId).toBe('admin/banners/logo/018f3a55-bc1b-7d23');
    });

    it('maps school tenant scope keys to uploads/schools/...', () => {
      const publicId = KeyService.toLegacyPublicId(
        { namespace: 'esma-tenant' },
        'tenants/SCH_001/logo/018f3a55-bc1b-7d23.png',
        'image',
      );
      expect(publicId).toBe('uploads/schools/SCH_001/logo/018f3a55-bc1b-7d23');
    });

    it('maps branch tenant scope keys to uploads/schools/.../branches/...', () => {
      const publicId = KeyService.toLegacyPublicId(
        { namespace: 'esma-tenant' },
        'tenants/SCH_001/branches/BR_MAIN/docs/018f3a55-bc1b-7d23.png',
        'image',
      );
      expect(publicId).toBe(
        'uploads/schools/SCH_001/branches/BR_MAIN/docs/018f3a55-bc1b-7d23',
      );
    });

    it('preserves file extension for raw resource types', () => {
      const publicId = KeyService.toLegacyPublicId(
        { namespace: 'esma-tenant' },
        'tenants/SCH_001/reports/018f3a55-bc1b-7d23.pdf',
        'raw',
      );
      expect(publicId).toBe(
        'uploads/schools/SCH_001/reports/018f3a55-bc1b-7d23.pdf',
      );
    });

    it('maps generic namespaces using configured cloudinaryRootFolder', () => {
      const publicId = KeyService.toLegacyPublicId(
        { namespace: 'third-party', cloudinaryRootFolder: 'custom-gus' },
        'tenants/client-a/exports/file.csv',
        'raw',
      );
      expect(publicId).toBe('custom-gus/tenants/client-a/exports/file.csv');
    });
  });
});
