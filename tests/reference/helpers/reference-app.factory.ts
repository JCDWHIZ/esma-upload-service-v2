import {
  Controller,
  Post,
  Get,
  Delete,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  Headers,
  Query,
  Param,
  Body,
  Inject,
  HttpException,
  HttpStatus,
  Module,
  INestApplication,
  Res,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  FileInterceptor,
  FilesInterceptor,
  FileFieldsInterceptor,
} from '@nestjs/platform-express';
import multer from 'multer';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import {
  FakeStorageDriver,
  STORAGE_DRIVER_TOKEN,
} from '../../helpers/storage-driver.mock.js';
import { TEST_JWT_SECRET } from '../../helpers/tokens.js';
import { JwtVerifierService } from '../../../src/auth/jwt/jwt-verifier.service.js';
import { AppConfigService } from '../../../src/config/config.service.js';
import { ProblemJsonErrorFilter } from '../../../src/common/filters/problem-json-error.filter.js';
import type { VerifiedTokenClaims } from '../../../src/auth/context.js';

interface RequestWithAuth extends Request {
  user?: VerifiedTokenClaims;
}

// Auth Interceptor / Guard to enforce auth before parsing
class ContractAuthInterceptor implements NestInterceptor {
  constructor(
    private readonly jwtVerifier: JwtVerifierService,
    private readonly routeType: 'tenant' | 'admin',
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<RequestWithAuth>();
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new HttpException(
        'Missing or invalid authorization header',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const token = authHeader.substring(7).trim();
    let verified: VerifiedTokenClaims;
    try {
      verified = await this.jwtVerifier.verifyToken(token);
    } catch {
      throw new HttpException(
        'Invalid or expired token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (this.routeType === 'admin') {
      const roles = verified.roles ?? [];
      const hasAdmin = roles.includes('superadmin') || roles.includes('admin');
      if (!hasAdmin) {
        throw new HttpException(
          'Forbidden: superadmin or admin role required',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    if (this.routeType === 'tenant') {
      const schoolHeader = req.headers['x-school-id'];
      if (!schoolHeader || schoolHeader !== verified.schoolId) {
        throw new HttpException(
          'Header mismatch: x-school-id does not match token claim',
          HttpStatus.FORBIDDEN,
        );
      }
      const branchHeader = req.headers['x-branch-id'];
      if (
        verified.branchId &&
        branchHeader &&
        branchHeader !== verified.branchId
      ) {
        throw new HttpException(
          'Header mismatch: x-branch-id does not match token claim',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    req.user = verified;
    return next.handle();
  }
}

// Simple magic bytes verification helper for contract tests
function validateMagicBytes(file: Express.Multer.File): void {
  if (!file || !file.buffer) {
    throw new HttpException('File is required', HttpStatus.BAD_REQUEST);
  }
  const buf = file.buffer;
  // Check PE executable disguised as pdf (MZ header)
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    throw new HttpException(
      'Disallowed file content: executable files are rejected',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Check supported magic bytes (PNG, JPEG, GIF, PDF, DOCX/XLSX PK)
  const isPng =
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  const isJpeg = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
  const isGif =
    buf.length >= 3 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
  const isPdf = buf.subarray(0, 5).toString('utf8').startsWith('%PDF-');
  const isZip =
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04;

  if (!isPng && !isJpeg && !isGif && !isPdf && !isZip) {
    throw new HttpException(
      'Disallowed file type: format not supported',
      HttpStatus.BAD_REQUEST,
    );
  }
}

@Controller('api/tenant/upload')
@UseInterceptors(
  new ContractAuthInterceptor(
    new JwtVerifierService({
      get: () => ({
        JWT_SECRET: TEST_JWT_SECRET,
        JWT_ALGORITHMS: 'HS256',
        JWT_CLOCK_TOLERANCE_SECONDS: 2,
      }),
    } as unknown as AppConfigService),
    'tenant',
  ),
)
class LegacyTenantUploadController {
  constructor(
    @Inject(STORAGE_DRIVER_TOKEN)
    private readonly storage: FakeStorageDriver,
  ) {}

  @Post('single')
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage() }))
  async singleUpload(
    @UploadedFile() file: Express.Multer.File,
    @Headers('x-school-id') schoolId: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    if (!file) {
      throw new HttpException('File is required', HttpStatus.BAD_REQUEST);
    }
    validateMagicBytes(file);

    const folder = branchId
      ? `uploads/schools/${schoolId}/branches/${branchId}`
      : `uploads/schools/${schoolId}`;
    const fileId = '01a0df82-9c54-71ff-8ffc-5e1566b01191';
    const key = `${folder}/${fileId}.png`;

    await this.storage.put(key, file.buffer);

    return {
      message: 'File uploaded successfully',
      data: {
        public_id: key,
        secure_url: `https://storage.example.com/${key}`,
        tenant: {
          schoolId,
          ...(branchId ? { branchId } : {}),
          schoolName: 'Test School',
        },
      },
    };
  }

  @Post('multiple')
  @UseInterceptors(
    FilesInterceptor('files', 10, { storage: multer.memoryStorage() }),
  )
  async multipleUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Headers('x-school-id') schoolId: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    if (!files || files.length === 0) {
      throw new HttpException('Files are required', HttpStatus.BAD_REQUEST);
    }
    for (const f of files) {
      validateMagicBytes(f);
    }

    const folder = branchId
      ? `uploads/schools/${schoolId}/branches/${branchId}`
      : `uploads/schools/${schoolId}`;

    const uploadedList: Array<{ public_id: string; secure_url: string }> = [];
    let idx = 1;
    for (const f of files) {
      const fileId = `01a0df82-9c54-71ff-8ffc-5e1566b0119${idx++}`;
      const key = `${folder}/${fileId}.png`;
      await this.storage.put(key, f.buffer);
      uploadedList.push({
        public_id: key,
        secure_url: `https://storage.example.com/${key}`,
      });
    }

    return {
      message: 'Files uploaded successfully',
      files: uploadedList,
      tenant: {
        schoolId,
        ...(branchId ? { branchId } : {}),
        schoolName: 'Test School',
      },
    };
  }

  @Post('multiple-fields')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'avatar', maxCount: 1 },
        { name: 'gallery', maxCount: 5 },
        { name: 'documents', maxCount: 10 },
      ],
      { storage: multer.memoryStorage() },
    ),
  )
  async multipleFields(
    @UploadedFiles()
    files: {
      avatar?: Express.Multer.File[];
      gallery?: Express.Multer.File[];
      documents?: Express.Multer.File[];
    },
    @Headers('x-school-id') schoolId: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const hasAny =
      (files.avatar && files.avatar.length > 0) ||
      (files.gallery && files.gallery.length > 0) ||
      (files.documents && files.documents.length > 0);
    if (!hasAny) {
      throw new HttpException(
        'At least one field is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const folder = branchId
      ? `uploads/schools/${schoolId}/branches/${branchId}`
      : `uploads/schools/${schoolId}`;

    const responseFiles: Record<
      string,
      Array<{ public_id: string; secure_url: string }>
    > = {};

    for (const field of ['avatar', 'gallery', 'documents'] as const) {
      const fieldList = files[field] || [];
      responseFiles[field] = [];
      let idx = 1;
      for (const f of fieldList) {
        validateMagicBytes(f);
        const fileId = `01a0df82-${field}-${idx++}`;
        const key = `${folder}/${fileId}.png`;
        await this.storage.put(key, f.buffer);
        responseFiles[field].push({
          public_id: key,
          secure_url: `https://storage.example.com/${key}`,
        });
      }
    }

    return {
      message: 'Files uploaded successfully',
      files: responseFiles,
      tenant: {
        schoolId,
        ...(branchId ? { branchId } : {}),
        schoolName: 'Test School',
      },
    };
  }

  @Get('files/:schoolId')
  listSchoolFiles(
    @Param('schoolId') schoolId: string,
    @Headers('x-school-id') callerSchool: string,
  ) {
    if (schoolId !== callerSchool) {
      throw new HttpException(
        'Forbidden: tenant mismatch',
        HttpStatus.FORBIDDEN,
      );
    }
    const key = `uploads/schools/${schoolId}/01a0df82-sample.png`;
    return {
      message: 'Files retrieved successfully',
      files: [
        {
          public_id: key,
          secure_url: `https://storage.example.com/${key}`,
          created_at: new Date('2026-09-26T20:00:00Z').toISOString(),
        },
      ],
      tenant: {
        schoolId,
        schoolName: 'Test School',
      },
      total: 1,
    };
  }

  @Get('files/:schoolId/:branchId')
  listBranchFiles(
    @Param('schoolId') schoolId: string,
    @Param('branchId') branchId: string,
    @Headers('x-school-id') callerSchool: string,
    @Headers('x-branch-id') callerBranch?: string,
  ) {
    if (
      schoolId !== callerSchool ||
      (callerBranch && branchId !== callerBranch)
    ) {
      throw new HttpException(
        'Forbidden: tenant mismatch',
        HttpStatus.FORBIDDEN,
      );
    }
    const key = `uploads/schools/${schoolId}/branches/${branchId}/01a0df82-sample.png`;
    return {
      message: 'Files retrieved successfully',
      files: [
        {
          public_id: key,
          secure_url: `https://storage.example.com/${key}`,
          created_at: new Date('2026-09-26T20:00:00Z').toISOString(),
        },
      ],
      tenant: {
        schoolId,
        branchId,
        schoolName: 'Test School',
      },
      total: 1,
    };
  }

  @Delete('files/:publicId')
  async deleteTenantFile(
    @Param('publicId') publicId: string,
    @Headers('x-school-id') schoolId: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const decodedKey = decodeURIComponent(publicId);
    // Corrected F-42 prefix scoping: must match exact folder with trailing slash
    const schoolPrefix = `uploads/schools/${schoolId}/`;
    if (!decodedKey.startsWith(schoolPrefix)) {
      throw new HttpException('File not found', HttpStatus.NOT_FOUND);
    }

    if (branchId) {
      const branchPrefix = `uploads/schools/${schoolId}/branches/${branchId}/`;
      if (!decodedKey.startsWith(branchPrefix)) {
        throw new HttpException('File not found', HttpStatus.NOT_FOUND);
      }
    }

    await this.storage.delete(decodedKey);

    return {
      message: 'File deleted successfully',
      result: {
        result: 'ok',
      },
      tenant: {
        schoolId,
        schoolName: 'Test School',
      },
    };
  }
}

@Controller('api/admin/upload')
@UseInterceptors(
  new ContractAuthInterceptor(
    new JwtVerifierService({
      get: () => ({
        JWT_SECRET: TEST_JWT_SECRET,
        JWT_ALGORITHMS: 'HS256',
        JWT_CLOCK_TOLERANCE_SECONDS: 2,
      }),
    } as unknown as AppConfigService),
    'admin',
  ),
)
class LegacyAdminUploadController {
  constructor(
    @Inject(STORAGE_DRIVER_TOKEN)
    private readonly storage: FakeStorageDriver,
  ) {}

  @Post('single')
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage() }))
  async singleUpload(
    @UploadedFile() file: Express.Multer.File,
    @Query('folder') folder = 'general',
  ) {
    if (!file) {
      throw new HttpException('File is required', HttpStatus.BAD_REQUEST);
    }
    validateMagicBytes(file);

    const key = `admin/${folder}/01a0df82-sample.png`;
    await this.storage.put(key, file.buffer);

    return {
      message: 'File uploaded successfully',
      data: {
        public_id: key,
        secure_url: `https://storage.example.com/${key}`,
      },
      folder: `admin/${folder}`,
    };
  }

  @Post('multiple')
  @UseInterceptors(
    FilesInterceptor('files', 10, { storage: multer.memoryStorage() }),
  )
  async multipleUpload(
    @UploadedFiles() files: Express.Multer.File[],
    @Query('folder') folder = 'general',
  ) {
    if (!files || files.length === 0) {
      throw new HttpException('Files are required', HttpStatus.BAD_REQUEST);
    }
    for (const f of files) {
      validateMagicBytes(f);
    }

    const uploadedList: Array<{ public_id: string; secure_url: string }> = [];
    let idx = 1;
    for (const f of files) {
      const key = `admin/${folder}/01a0df82-${idx++}.png`;
      await this.storage.put(key, f.buffer);
      uploadedList.push({
        public_id: key,
        secure_url: `https://storage.example.com/${key}`,
      });
    }

    return {
      message: 'Files uploaded successfully',
      files: uploadedList,
      folder: `admin/${folder}`,
      total: files.length,
    };
  }

  @Post('fields')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'profile_image', maxCount: 1 },
        { name: 'gallery_images', maxCount: 5 },
        { name: 'documents', maxCount: 3 },
      ],
      { storage: multer.memoryStorage() },
    ),
  )
  async fieldsUpload(
    @UploadedFiles()
    files: {
      profile_image?: Express.Multer.File[];
      gallery_images?: Express.Multer.File[];
      documents?: Express.Multer.File[];
    },
    @Query('folder') folder = 'general',
  ) {
    const hasAny =
      (files.profile_image && files.profile_image.length > 0) ||
      (files.gallery_images && files.gallery_images.length > 0) ||
      (files.documents && files.documents.length > 0);
    if (!hasAny) {
      throw new HttpException(
        'At least one field is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const responseFiles: Record<
      string,
      Array<{ public_id: string; secure_url: string }>
    > = {};

    for (const field of [
      'profile_image',
      'gallery_images',
      'documents',
    ] as const) {
      const fieldList = files[field] || [];
      responseFiles[field] = [];
      let idx = 1;
      for (const f of fieldList) {
        validateMagicBytes(f);
        const key = `admin/${folder}/${field}/01a0df82-${idx++}.png`;
        await this.storage.put(key, f.buffer);
        responseFiles[field].push({
          public_id: key,
          secure_url: `https://storage.example.com/${key}`,
        });
      }
    }

    return {
      message: 'Files uploaded successfully',
      files: responseFiles,
      folder: `admin/${folder}`,
    };
  }

  @Get('files')
  listFiles(@Query('folder') folder = 'general') {
    const key = `admin/${folder}/01a0df82-sample.png`;
    return {
      message: 'Files retrieved successfully',
      files: [
        {
          public_id: key,
          secure_url: `https://storage.example.com/${key}`,
          format: 'png',
          created_at: new Date('2026-09-26T20:00:00Z').toISOString(),
        },
      ],
      total: 1,
      next_cursor: null,
      rate_limit_allowed: 500,
    };
  }

  @Get('file/:publicId')
  getFileDetails(@Param('publicId') publicId: string) {
    const key = decodeURIComponent(publicId);
    return {
      message: 'File retrieved successfully',
      file: {
        public_id: key,
        format: 'png',
        bytes: 67,
        secure_url: `https://storage.example.com/${key}`,
        created_at: new Date('2026-09-26T20:00:00Z').toISOString(),
      },
    };
  }

  @Delete('file/:publicId')
  async deleteSingleFile(@Param('publicId') publicId: string) {
    const key = decodeURIComponent(publicId);
    await this.storage.delete(key);
    return {
      message: 'File deleted successfully',
      result: {
        result: 'ok',
      },
      publicId: key,
    };
  }

  @Delete('files')
  async bulkDelete(@Body() body: { publicIds: string[] }) {
    if (!body || !Array.isArray(body.publicIds)) {
      throw new HttpException(
        'publicIds array is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Corrected F-45: cap bulk delete at 100 items
    if (body.publicIds.length > 100) {
      throw new HttpException(
        'Bulk delete exceeded maximum limit of 100 items',
        HttpStatus.BAD_REQUEST,
      );
    }

    for (const id of body.publicIds) {
      await this.storage.delete(id);
    }

    return {
      message: 'Bulk delete completed',
      successful: body.publicIds,
      failed: [],
      total: body.publicIds.length,
    };
  }
}

@Controller()
class LegacySystemController {
  @Get('api/test')
  healthCheck() {
    return {
      message: 'Hello World',
    };
  }

  @Get('docs.json')
  openApiSpec() {
    return {
      openapi: '3.1.0',
      info: {
        title: 'ESMA Upload Service',
        version: '2.0.0',
      },
      paths: {},
    };
  }

  @Get()
  swaggerUi(@Headers('accept') _accept: string, @Res() res: Response) {
    res.setHeader('content-type', 'text/html');
    res.send(
      '<!DOCTYPE html><html><head><title>Swagger UI</title></head><body><div id="swagger-ui"></div></body></html>',
    );
  }

  @Get('uploads/*')
  staticRoute() {
    // Corrected F-47: direct traversal disallowed
    throw new HttpException(
      'Static upload path not found',
      HttpStatus.NOT_FOUND,
    );
  }
}

@Module({
  controllers: [
    LegacyTenantUploadController,
    LegacyAdminUploadController,
    LegacySystemController,
  ],
  providers: [
    {
      provide: STORAGE_DRIVER_TOKEN,
      useFactory: () => new FakeStorageDriver('fake-storage'),
    },
  ],
})
export class LegacyReferenceModule {}

export async function createReferenceApp(): Promise<{
  app: INestApplication;
  storage: FakeStorageDriver;
}> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [LegacyReferenceModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemJsonErrorFilter());
  await app.init();

  const storage = moduleRef.get<FakeStorageDriver>(STORAGE_DRIVER_TOKEN);

  return { app, storage };
}
