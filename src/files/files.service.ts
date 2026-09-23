import { Injectable } from '@nestjs/common';

@Injectable()
export class FilesService {
  listFiles(
    tenantId: string,
  ): Promise<{ items: unknown[]; total: number; cursor: string | null }> {
    void tenantId;
    return Promise.resolve({
      items: [],
      total: 0,
      cursor: null,
    });
  }

  getFileMetadata(fileId: string): Promise<{ fileId: string; status: string }> {
    return Promise.resolve({
      fileId,
      status: 'AVAILABLE',
    });
  }
}
