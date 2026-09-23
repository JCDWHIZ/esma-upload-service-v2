import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  NotImplementedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { FilesService } from './files.service.js';

@ApiTags('files')
@Controller('api/v1/files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upload file(s)' })
  @ApiResponse({ status: 201, description: 'File uploaded successfully' })
  upload() {
    throw new NotImplementedException(
      'File upload engine will be implemented in Phase 2',
    );
  }

  @Get()
  @ApiOperation({ summary: 'List files for tenant' })
  @ApiResponse({ status: 200, description: 'List of files' })
  listFiles() {
    return this.filesService.listFiles('default');
  }

  @Get(':fileId')
  @ApiOperation({ summary: 'Get file content' })
  getFileContent(@Param('fileId') fileId: string) {
    throw new NotImplementedException(
      `File streaming for ${fileId} scheduled for Phase 2`,
    );
  }

  @Get(':fileId/metadata')
  @ApiOperation({ summary: 'Get file metadata manifest' })
  getMetadata(@Param('fileId') fileId: string) {
    return this.filesService.getFileMetadata(fileId);
  }

  @Post(':fileId/signed-url')
  @ApiOperation({ summary: 'Generate time-limited signed URL' })
  generateSignedUrl(@Param('fileId') fileId: string) {
    throw new NotImplementedException(
      `Signed URL generation for ${fileId} scheduled for Phase 2`,
    );
  }

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Purge file and replicas' })
  deleteFile(@Param('fileId') fileId: string) {
    throw new NotImplementedException(
      `Delete service for ${fileId} scheduled for Phase 2`,
    );
  }

  @Post('bulk-delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bulk delete files' })
  bulkDelete() {
    throw new NotImplementedException('Bulk delete scheduled for Phase 2');
  }
}
