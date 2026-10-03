import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import * as fs from 'node:fs';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { Request, Response } from 'express';

const STAGED_FILES_KEY = '__gus_staged_files__';

interface RequestWithStagedFiles extends Request {
  [STAGED_FILES_KEY]?: Set<string>;
}

/**
 * Registers a file path staged on disk for automatic cleanup.
 */
export function registerStagedFile(req: Request, filePath: string): void {
  const reqWithFiles = req as RequestWithStagedFiles;
  if (!reqWithFiles[STAGED_FILES_KEY]) {
    reqWithFiles[STAGED_FILES_KEY] = new Set<string>();
  }
  reqWithFiles[STAGED_FILES_KEY].add(filePath);
}

/**
 * Unregisters a file path once explicitly disposed.
 */
export function unregisterStagedFile(req: Request, filePath: string): void {
  const reqWithFiles = req as RequestWithStagedFiles;
  reqWithFiles[STAGED_FILES_KEY]?.delete(filePath);
}

/**
 * Removes all staged files associated with a request from disk.
 */
export async function cleanUpStagedFiles(req: Request): Promise<void> {
  const reqWithFiles = req as RequestWithStagedFiles;
  const files = reqWithFiles[STAGED_FILES_KEY];
  if (!files || files.size === 0) {
    return;
  }

  const paths = Array.from(files);
  files.clear();

  for (const filePath of paths) {
    try {
      await fs.promises.unlink(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        Logger.warn(
          `Failed to clean up staged file: ${filePath}`,
          'StagingCleanup',
        );
      }
    }
  }
}

/**
 * Interceptor that ensures all staged files are deleted from STAGING_DIR
 * regardless of outcome (success, validation failure, error, or client abort).
 */
@Injectable()
export class StagingCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithStagedFiles>();
    const res = http.getResponse<Response>();

    // Listen to response finish / close events (covers client aborts)
    if (res && typeof res.on === 'function') {
      const cleanupListener = (): void => {
        void cleanUpStagedFiles(req);
      };
      res.once('close', cleanupListener);
      res.once('finish', cleanupListener);
    }

    return next.handle().pipe(
      finalize(() => {
        void cleanUpStagedFiles(req);
      }),
    );
  }
}
