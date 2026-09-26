import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import multer, { StorageEngine } from 'multer';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { newId } from '../core/identifiers.js';
import { UploadPolicy } from '../config/policies.js';
import { IngestShape } from './types.js';
import { registerStagedFile } from './staging-cleanup.js';
import { Request } from 'express';

export type StagingDirResolver = string | (() => string);

function resolveStagingDir(dir?: StagingDirResolver): string {
  if (typeof dir === 'function') {
    return dir();
  }
  if (typeof dir === 'string' && dir.trim().length > 0) {
    return dir;
  }
  return process.env.STAGING_DIR || path.join(os.tmpdir(), 'gus-staging');
}

/**
 * Creates disk storage for Multer targeting STAGING_DIR with collision-free UUIDv7 filenames.
 */
export function createStagingDiskStorage(
  stagingDir?: StagingDirResolver,
): StorageEngine {
  return multer.diskStorage({
    destination: (_req: Request, _file: Express.Multer.File, cb) => {
      try {
        const resolved = resolveStagingDir(stagingDir);
        fs.mkdirSync(resolved, { recursive: true });
        cb(null, resolved);
      } catch (err: unknown) {
        cb(err as Error, '');
      }
    },
    filename: (req: Request, _file: Express.Multer.File, cb) => {
      const resolved = resolveStagingDir(stagingDir);
      const uniqueName = `gus_${newId()}_${Date.now()}.tmp`;
      const fullPath = path.join(resolved, uniqueName);
      registerStagedFile(req, fullPath);
      cb(null, uniqueName);
    },
  });
}

/**
 * Factory producing MulterModuleOptions tailored to a specific policy and ingestion shape.
 */
export function multerOptionsFactory(
  stagingDir?: StagingDirResolver,
  policy?: UploadPolicy,
  shape?: IngestShape | 'single',
): MulterOptions {
  let maxFiles = policy?.maxFilesPerRequest ?? 10;

  if (shape === 'single' || shape?.type === 'single') {
    maxFiles = 1;
  } else if (shape?.type === 'array' && shape.maxCount) {
    maxFiles = shape.maxCount;
  } else if (shape?.type === 'fields' && shape.fields) {
    maxFiles = shape.fields.reduce((acc, f) => acc + f.maxCount, 0);
  }

  return {
    storage: createStagingDiskStorage(stagingDir),
    limits: {
      fileSize: policy?.maxFileSizeBytes,
      files: maxFiles,
    },
  };
}
