import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  INestApplication,
  Inject,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { FileInterceptor } from '@nestjs/platform-express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import {
  FakeStorageDriver,
  STORAGE_DRIVER_TOKEN,
} from '../helpers/storage-driver.mock.js';
import { tmpUploadsDir, type TmpUploadsDir } from '../helpers/tmp-dir.js';
import { makeFile } from '../helpers/make-file.js';
import { StagingCleanupInterceptor } from '../../src/ingest/staging-cleanup.js';
import { multerOptionsFactory } from '../../src/ingest/multer-options.js';
import { IngestValidationPipe } from '../../src/ingest/ingest-validation.pipe.js';
import type { IngestedFile } from '../../src/ingest/types.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { IngestModule } from '../../src/ingest/ingest.module.js';
import { DEFAULT_POLICIES } from '../../src/config/policies.js';
import { ProblemJsonErrorFilter } from '../../src/common/filters/problem-json-error.filter.js';

interface RequestWithCtx extends Request {
  ctx?: { namespace: string };
}

interface UploadResponse {
  ok: boolean;
  storageKey: string;
  size: number;
}

describe('Sample Integration: Supertest with FakeStorageDriver & Staging Cleanup', () => {
  let app: INestApplication;
  let fakeStorage: FakeStorageDriver;
  let tmpStaging: TmpUploadsDir;

  @Controller('sample-upload')
  class SampleUploadController {
    constructor(
      @Inject(STORAGE_DRIVER_TOKEN)
      private readonly storage: FakeStorageDriver,
    ) {}

    @Post()
    @UseInterceptors(
      StagingCleanupInterceptor,
      FileInterceptor(
        'file',
        multerOptionsFactory(
          () => tmpStaging.path,
          DEFAULT_POLICIES['generic-default'],
          'single',
        ),
      ),
    )
    async upload(
      @UploadedFile(IngestValidationPipe) file: IngestedFile,
    ): Promise<UploadResponse> {
      const stream = file.openReadStream();
      stream.on('error', () => {});
      try {
        const res = await this.storage.put(
          `uploads/${file.originalName}`,
          stream,
        );
        return {
          ok: true,
          storageKey: res.key,
          size: res.size,
        };
      } catch (err) {
        stream.destroy();
        throw new HttpException(
          (err as Error).message,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }
  }

  beforeAll(async () => {
    fakeStorage = new FakeStorageDriver('test-storage');
    tmpStaging = tmpUploadsDir('test-integ-staging-');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule, IngestModule],
      controllers: [SampleUploadController],
      providers: [
        {
          provide: STORAGE_DRIVER_TOKEN,
          useValue: fakeStorage,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use((req: RequestWithCtx, _res: Response, next: NextFunction) => {
      req.ctx = { namespace: 'generic-default' };
      next();
    });
    app.useGlobalFilters(new ProblemJsonErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    tmpStaging.cleanup();
  });

  beforeEach(() => {
    fakeStorage.clear();
  });

  afterEach(() => {
    tmpStaging.assertEmpty();
  });

  it('uploads a file successfully, stores in FakeStorageDriver, and leaves staging empty', async () => {
    const pngFixture = makeFile('png');
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    const res = await request(server)
      .post('/sample-upload')
      .attach('file', pngFixture.buffer, pngFixture.filename)
      .expect(201);

    const body = res.body as UploadResponse;
    expect(body.ok).toBe(true);
    expect(body.storageKey).toBe(`uploads/${pngFixture.filename}`);
    expect(body.size).toBe(pngFixture.size);

    // Verify storage double contains the file
    expect(fakeStorage.hasFile(`uploads/${pngFixture.filename}`)).toBe(true);
    const stored = fakeStorage.getFile(`uploads/${pngFixture.filename}`);
    expect(stored?.equals(pngFixture.buffer)).toBe(true);

    // Staging directory is verified empty by afterEach(tmpStaging.assertEmpty)
  });

  it('handles driver failure injection (failNext) and guarantees staging cleanup on error', async () => {
    fakeStorage.failNext(new Error('Simulated upstream driver disk failure'));
    const pngFixture = makeFile('png');
    const server = app.getHttpServer() as unknown as Parameters<
      typeof request
    >[0];

    await request(server)
      .post('/sample-upload')
      .attach('file', pngFixture.buffer, pngFixture.filename)
      .expect(500);

    // Verify file was NOT stored due to driver failure
    expect(fakeStorage.hasFile(`uploads/${pngFixture.filename}`)).toBe(false);

    // Staging directory is still guaranteed to be empty even after 500 error!
    tmpStaging.assertEmpty();
  });
});
