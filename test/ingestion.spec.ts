import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Readable } from 'node:stream';
import type { Request, Response, NextFunction } from 'express';
import { sanitizeFilename } from '../src/ingest/sanitize.js';
import {
  detectFileType,
  assertMimeCompatibility,
} from '../src/ingest/sniff.js';
import { IngestedFileImpl } from '../src/ingest/ingested-file.js';
import { StagingCleanupInterceptor } from '../src/ingest/staging-cleanup.js';
import { multerOptionsFactory } from '../src/ingest/multer-options.js';
import { IngestValidationPipe } from '../src/ingest/ingest-validation.pipe.js';
import type { IngestedFile } from '../src/ingest/types.js';
import { IngestModule } from '../src/ingest/ingest.module.js';
import { ConfigModule } from '../src/config/config.module.js';
import { PolicyRegistry } from '../src/config/policy-registry.js';
import { DEFAULT_POLICIES, UploadPolicy } from '../src/config/policies.js';
import {
  MimeMismatchError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../src/core/errors/app-error.js';
import { ProblemJsonErrorFilter } from '../src/common/filters/problem-json-error.filter.js';

interface RequestWithCtx extends Request {
  ctx?: { namespace: string };
}

interface UploadSingleSuccessResponse {
  ok: boolean;
  size: number;
  sha256: string;
  originalName: string;
}

interface UploadMultipleSuccessResponse {
  count: number;
}

interface UploadErrorResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
}

// Minimal binary fixtures
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const TINY_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300030202020202030202020303030304060404040404080606050609080a0a090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c12131210130f101010ffc9000b080001000101011100ffcc000600101005ffda0008010100003f00d2cf20ffd9',
  'hex',
);
const TINY_GIF = Buffer.from(
  '47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b',
  'hex',
);
const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\nxref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n115\n%%EOF\n',
  'utf8',
);

describe('Ingestion Module (P1-12)', () => {
  let stagingDir: string;

  beforeEach(() => {
    stagingDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ingestion-test-staging-'),
    );
  });

  afterEach(() => {
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  describe('1. Filename Sanitization (sanitizeFilename)', () => {
    it('strips path traversal patterns (POSIX and Windows)', () => {
      expect(sanitizeFilename('../../evil.png')).toBe('evil.png');
      expect(sanitizeFilename('..\\..\\evil.png')).toBe('evil.png');
      expect(sanitizeFilename('folder/sub/doc.pdf')).toBe('doc.pdf');
      expect(sanitizeFilename('C:\\Users\\Admin\\photo.jpg')).toBe('photo.jpg');
    });

    it('removes null bytes and control characters', () => {
      expect(sanitizeFilename('file\0name\x01\x1f.png')).toBe('filename.png');
    });

    it('strips leading dots', () => {
      expect(sanitizeFilename('...hidden.txt')).toBe('hidden.txt');
      expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    });

    it('truncates to 255 bytes while preserving the extension', () => {
      const veryLong = 'a'.repeat(300) + '.jpeg';
      const sanitized = sanitizeFilename(veryLong);
      expect(Buffer.byteLength(sanitized, 'utf8')).toBeLessThanOrEqual(255);
      expect(sanitized.endsWith('.jpeg')).toBe(true);
    });

    it('falls back to "unnamed-file" for empty or dot inputs', () => {
      expect(sanitizeFilename('')).toBe('unnamed-file');
      expect(sanitizeFilename('   ')).toBe('unnamed-file');
      expect(sanitizeFilename('.')).toBe('unnamed-file');
      expect(sanitizeFilename('..')).toBe('unnamed-file');
      expect(sanitizeFilename(null)).toBe('unnamed-file');
    });
  });

  describe('2. Magic Bytes Sniffing & Contradiction Detection', () => {
    it('detects real PNG, JPEG, GIF and PDF magic bytes', async () => {
      const pngPath = path.join(stagingDir, 'sample.png');
      fs.writeFileSync(pngPath, TINY_PNG);
      const detectedPng = await detectFileType(pngPath);
      expect(detectedPng?.mime).toBe('image/png');
      expect(detectedPng?.ext).toBe('.png');

      const pdfPath = path.join(stagingDir, 'sample.pdf');
      fs.writeFileSync(pdfPath, TINY_PDF);
      const detectedPdf = await detectFileType(pdfPath);
      expect(detectedPdf?.mime).toBe('application/pdf');
      expect(detectedPdf?.ext).toBe('.pdf');

      const jpegPath = path.join(stagingDir, 'sample.jpg');
      fs.writeFileSync(jpegPath, TINY_JPEG);
      const detectedJpeg = await detectFileType(jpegPath);
      expect(detectedJpeg?.mime).toBe('image/jpeg');

      const gifPath = path.join(stagingDir, 'sample.gif');
      fs.writeFileSync(gifPath, TINY_GIF);
      const detectedGif = await detectFileType(gifPath);
      expect(detectedGif?.mime).toBe('image/gif');
    });

    it('detects plain text and JSON text formats', async () => {
      const jsonPath = path.join(stagingDir, 'sample.json');
      fs.writeFileSync(jsonPath, JSON.stringify({ hello: 'world' }));
      const detectedJson = await detectFileType(jsonPath);
      expect(detectedJson?.mime).toBe('application/json');

      const txtPath = path.join(stagingDir, 'sample.txt');
      fs.writeFileSync(txtPath, 'plain text content');
      const detectedTxt = await detectFileType(
        txtPath,
        'text/plain',
        'sample.txt',
      );
      expect(detectedTxt?.mime).toBe('text/plain');
    });

    it('throws MimeMismatchError when declared MIME contradicts detected magic bytes', () => {
      // PDF bytes, but client claimed image/png
      expect(() => {
        assertMimeCompatibility('application/pdf', 'image/png', 'doc.pdf');
      }).toThrow(MimeMismatchError);
    });

    it('throws MimeMismatchError when filename extension contradicts detected MIME', () => {
      // PDF bytes, but filename says photo.png
      expect(() => {
        assertMimeCompatibility(
          'application/pdf',
          'application/pdf',
          'photo.png',
        );
      }).toThrow(MimeMismatchError);
    });

    it('permits compatible aliases like image/jpeg and image/jpg', () => {
      expect(() => {
        assertMimeCompatibility('image/jpeg', 'image/jpg', 'photo.jpg');
      }).not.toThrow();

      expect(() => {
        assertMimeCompatibility('image/jpeg', 'image/jpeg', 'photo.jpeg');
      }).not.toThrow();
    });
  });

  describe('3. IngestedFile Contract & Repeatable Streams', () => {
    it('openReadStream() can be called repeatedly and yields identical bytes', async () => {
      const filePath = path.join(stagingDir, 'repeatable.bin');
      fs.writeFileSync(filePath, TINY_PNG);

      const ingested = new IngestedFileImpl({
        fieldName: 'file',
        originalName: 'test.png',
        declaredMime: 'image/png',
        detectedMime: 'image/png',
        size: TINY_PNG.length,
        sha256: 'fake-hash',
        path: filePath,
      });

      // Stream 1
      const stream1 = ingested.openReadStream();
      const chunks1: Buffer[] = [];
      stream1.on('data', (chunk: Buffer) => {
        chunks1.push(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        stream1.on('end', resolve);
        stream1.on('error', reject);
      });
      const data1 = Buffer.concat(chunks1);

      // Stream 2
      const stream2 = ingested.openReadStream();
      const chunks2: Buffer[] = [];
      stream2.on('data', (chunk: Buffer) => {
        chunks2.push(chunk);
      });
      await new Promise<void>((resolve, reject) => {
        stream2.on('end', resolve);
        stream2.on('error', reject);
      });
      const data2 = Buffer.concat(chunks2);

      expect(data1.equals(TINY_PNG)).toBe(true);
      expect(data2.equals(TINY_PNG)).toBe(true);
      expect(data1.equals(data2)).toBe(true);

      // Dispose
      await ingested.dispose();
      expect(fs.existsSync(filePath)).toBe(false);
      expect(() => ingested.openReadStream()).toThrow();
    });
  });

  describe('4. IngestValidationPipe Invariant Enforcement', () => {
    let registry: PolicyRegistry;

    beforeEach(() => {
      registry = PolicyRegistry.create();
    });

    it('rejects disallowed media types with UnsupportedMediaTypeError (415)', async () => {
      const filePath = path.join(stagingDir, 'forbidden.bin');
      // Create a ZIP archive or binary file that is not in esma-tenant allowed types
      const zipHeader = Buffer.from([
        0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00,
      ]);
      fs.writeFileSync(filePath, zipHeader);

      const pipe = new IngestValidationPipe(registry, undefined, {
        policy: DEFAULT_POLICIES['esma-tenant'],
      });

      const fakeMulterFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'archive.zip',
        encoding: '7bit',
        mimetype: 'application/zip',
        size: zipHeader.length,
        destination: stagingDir,
        filename: 'forbidden.bin',
        path: filePath,
        buffer: Buffer.alloc(0),
        stream: null as unknown as Readable,
      };

      await expect(pipe.transform(fakeMulterFile)).rejects.toThrow(
        UnsupportedMediaTypeError,
      );
      // Cleaned up on error
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('rejects file exceeding maxFileSizeBytes with PayloadTooLargeError (413)', async () => {
      const filePath = path.join(stagingDir, 'toolarge.png');
      fs.writeFileSync(filePath, TINY_PNG);

      const smallPolicy: UploadPolicy = {
        ...DEFAULT_POLICIES['generic-default'],
        maxFileSizeBytes: 10, // TINY_PNG is > 10 bytes
      };

      const pipe = new IngestValidationPipe(registry, undefined, {
        policy: smallPolicy,
      });

      const fakeMulterFile: Express.Multer.File = {
        fieldname: 'file',
        originalname: 'toolarge.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: TINY_PNG.length,
        destination: stagingDir,
        filename: 'toolarge.png',
        path: filePath,
        buffer: Buffer.alloc(0),
        stream: null as unknown as Readable,
      };

      await expect(pipe.transform(fakeMulterFile)).rejects.toThrow(
        PayloadTooLargeError,
      );
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('rejects field counts exceeding fieldRules limit with ValidationError (422)', async () => {
      // esma-tenant allows avatar: max 1
      const path1 = path.join(stagingDir, 'avatar1.png');
      const path2 = path.join(stagingDir, 'avatar2.png');
      fs.writeFileSync(path1, TINY_PNG);
      fs.writeFileSync(path2, TINY_PNG);

      const pipe = new IngestValidationPipe(registry, undefined, {
        policy: DEFAULT_POLICIES['esma-tenant'],
      });

      const fakeFiles: Express.Multer.File[] = [
        {
          fieldname: 'avatar',
          originalname: 'avatar1.png',
          encoding: '7bit',
          mimetype: 'image/png',
          size: TINY_PNG.length,
          destination: stagingDir,
          filename: 'avatar1.png',
          path: path1,
          buffer: Buffer.alloc(0),
          stream: null as unknown as Readable,
        },
        {
          fieldname: 'avatar',
          originalname: 'avatar2.png',
          encoding: '7bit',
          mimetype: 'image/png',
          size: TINY_PNG.length,
          destination: stagingDir,
          filename: 'avatar2.png',
          path: path2,
          buffer: Buffer.alloc(0),
          stream: null as unknown as Readable,
        },
      ];

      await expect(pipe.transform(fakeFiles)).rejects.toThrow(ValidationError);
      // Both files disposed
      expect(fs.existsSync(path1)).toBe(false);
      expect(fs.existsSync(path2)).toBe(false);
    });
  });

  describe('5. HTTP Integration & Guaranteed Disposal with Supertest', () => {
    let app: INestApplication;

    @Controller('test-upload')
    class TestUploadController {
      @Post('single')
      @UseInterceptors(
        StagingCleanupInterceptor,
        FileInterceptor(
          'file',
          multerOptionsFactory(
            () => stagingDir,
            DEFAULT_POLICIES['esma-tenant'],
            'single',
          ),
        ),
      )
      uploadSingle(@UploadedFile(IngestValidationPipe) file: IngestedFile): {
        ok: boolean;
        size: number;
        sha256: string;
        originalName: string;
      } {
        return {
          ok: true,
          size: file.size,
          sha256: file.sha256,
          originalName: file.originalName,
        };
      }

      @Post('multiple')
      @UseInterceptors(
        StagingCleanupInterceptor,
        FilesInterceptor(
          'files',
          5,
          multerOptionsFactory(
            () => stagingDir,
            DEFAULT_POLICIES['esma-tenant'],
            { type: 'array', maxCount: 5 },
          ),
        ),
      )
      uploadMultiple(
        @UploadedFiles(IngestValidationPipe) files: IngestedFile[],
      ): { count: number } {
        return { count: files.length };
      }
    }

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ConfigModule, IngestModule],
        controllers: [TestUploadController],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.use((req: RequestWithCtx, _res: Response, next: NextFunction) => {
        req.ctx = { namespace: 'esma-tenant' };
        next();
      });
      app.useGlobalFilters(new ProblemJsonErrorFilter());
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('successful upload: returns 201 and empties STAGING_DIR completely', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const res = await request(server)
        .post('/test-upload/single')
        .attach('file', TINY_PNG, 'photo.png')
        .expect(201);

      const body = res.body as UploadSingleSuccessResponse;
      expect(body.ok).toBe(true);
      expect(body.size).toBe(TINY_PNG.length);
      expect(body.originalName).toBe('photo.png');

      // Assert STAGING_DIR is completely empty after response completes
      const stagedFiles = fs.readdirSync(stagingDir);
      expect(stagedFiles).toEqual([]);
    });

    it('MIME mismatch (PDF disguised as PNG): returns 415 and empties STAGING_DIR', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const res = await request(server)
        .post('/test-upload/single')
        .attach('file', TINY_PDF, 'malicious.png') // PDF bytes with .png name
        .expect(415);

      const body = res.body as UploadErrorResponse;
      expect(body.code).toBe('MIME_MISMATCH');

      // Assert STAGING_DIR is completely empty
      const stagedFiles = fs.readdirSync(stagingDir);
      expect(stagedFiles).toEqual([]);
    });

    it('disallowed MIME: returns 415 and empties STAGING_DIR', async () => {
      const zipHeader = Buffer.from([
        0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00,
      ]);
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const res = await request(server)
        .post('/test-upload/single')
        .attach('file', zipHeader, 'archive.zip')
        .expect(415);

      const body = res.body as UploadErrorResponse;
      expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE');

      const stagedFiles = fs.readdirSync(stagingDir);
      expect(stagedFiles).toEqual([]);
    });

    it('multiple files upload: validates all and empties STAGING_DIR', async () => {
      const server = app.getHttpServer() as unknown as Parameters<
        typeof request
      >[0];
      const res = await request(server)
        .post('/test-upload/multiple')
        .attach('files', TINY_PNG, 'img1.png')
        .attach('files', TINY_JPEG, 'img2.jpg')
        .expect(201);

      const body = res.body as UploadMultipleSuccessResponse;
      expect(body.count).toBe(2);

      const stagedFiles = fs.readdirSync(stagingDir);
      expect(stagedFiles).toEqual([]);
    });
  });

  describe('6. Security Invariant: Auth Before Body Parsing (F-41)', () => {
    it('unauthenticated request fails at AuthGuard before body is read or staged', async () => {
      // In Nest, guards run before interceptors.
      // We verify that an unauthenticated request receives 401 and Multer never writes any file to stagingDir.
      @Controller('secure-upload')
      class SecureUploadController {
        @Post()
        @UseInterceptors(
          StagingCleanupInterceptor,
          FileInterceptor(
            'file',
            multerOptionsFactory(
              () => stagingDir,
              DEFAULT_POLICIES['esma-tenant'],
              'single',
            ),
          ),
        )
        upload(): { ok: boolean } {
          return { ok: true };
        }
      }

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [ConfigModule, IngestModule],
        controllers: [SecureUploadController],
      }).compile();

      const app = moduleFixture.createNestApplication();
      // Apply AuthGuard globally as in real app bootstrap
      const mockAuthGuard = {
        canActivate: () => false, // Reject immediately
      };
      app.useGlobalGuards(mockAuthGuard);
      await app.init();

      try {
        const server = app.getHttpServer() as unknown as Parameters<
          typeof request
        >[0];
        await request(server)
          .post('/secure-upload')
          .attach('file', TINY_PNG, 'test.png')
          .expect(403); // default Nest guard rejection or 401

        // Assert STAGING_DIR is completely empty (zero files ever written)
        const files = fs.readdirSync(stagingDir);
        expect(files).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('asserts IngestModule never registers global APP_INTERCEPTOR ahead of APP_GUARD', async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [IngestModule],
      }).compile();

      // Check module metadata providers for global interceptors
      const providers =
        (Reflect.getMetadata('providers', IngestModule) as unknown[]) ?? [];
      const hasGlobalInterceptor = providers.some(
        (p: unknown) =>
          p === 'APP_INTERCEPTOR' ||
          (typeof p === 'object' &&
            p !== null &&
            'provide' in p &&
            p.provide === 'APP_INTERCEPTOR'),
      );
      expect(hasGlobalInterceptor).toBe(false);
      await moduleFixture.close();
    });
  });
});
