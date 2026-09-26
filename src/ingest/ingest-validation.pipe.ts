import {
  Injectable,
  PipeTransform,
  Inject,
  Optional,
  Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import * as fs from 'node:fs';
import { Request } from 'express';
import { PolicyRegistry } from '../config/policy-registry.js';
import { UploadPolicy } from '../config/policies.js';
import {
  ValidationError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from '../core/errors/app-error.js';
import { hashFile } from '../core/hashing.js';
import { sanitizeFilename } from './sanitize.js';
import { assertMimeCompatibility, detectFileType } from './sniff.js';
import { IngestedFile } from './types.js';
import type { IngestValidationOptions } from './types.js';
import { IngestedFileImpl } from './ingested-file.js';
import { cleanUpStagedFiles, unregisterStagedFile } from './staging-cleanup.js';

interface RequestWithContext extends Request {
  ctx?: {
    namespace?: string;
  };
}

@Injectable({ scope: Scope.REQUEST })
export class IngestValidationPipe implements PipeTransform {
  constructor(
    private readonly policyRegistry: PolicyRegistry,
    @Optional() @Inject(REQUEST) private readonly request?: RequestWithContext,
    @Optional() private readonly options?: IngestValidationOptions,
  ) {}

  async transform(
    value: unknown,
  ): Promise<IngestedFile | IngestedFile[] | Record<string, IngestedFile[]>> {
    if (!value) {
      throw new ValidationError('No file uploaded or multipart body is empty');
    }

    // Determine target policy
    const namespace = this.options?.namespace ?? this.request?.ctx?.namespace;
    const policy = this.options?.policy ?? this.policyRegistry.get(namespace);

    // Identify input shape
    const isSingle = this.isMulterFile(value);
    const isArray =
      Array.isArray(value) && value.every((f) => this.isMulterFile(f));
    const isFieldsMap =
      !isSingle &&
      !isArray &&
      typeof value === 'object' &&
      value !== null &&
      Object.values(value).every(
        (arr) => Array.isArray(arr) && arr.every((f) => this.isMulterFile(f)),
      );

    if (!isSingle && !isArray && !isFieldsMap) {
      throw new ValidationError('Invalid multipart file payload');
    }

    // Collect all raw files for validation and rollback tracking
    const rawFiles: Express.Multer.File[] = [];
    if (isSingle) {
      rawFiles.push(value);
    } else if (isArray) {
      rawFiles.push(...value);
    } else if (isFieldsMap) {
      for (const files of Object.values(
        value as Record<string, Express.Multer.File[]>,
      )) {
        rawFiles.push(...files);
      }
    }

    try {
      // 1. Enforce fieldRules count limits across files
      if (policy.fieldRules) {
        const countsByField = new Map<string, number>();
        for (const file of rawFiles) {
          const count = (countsByField.get(file.fieldname) ?? 0) + 1;
          countsByField.set(file.fieldname, count);
        }

        for (const [fieldname, count] of countsByField.entries()) {
          const rule = policy.fieldRules[fieldname];
          if (rule && count > rule.maxCount) {
            throw new ValidationError(
              `Field "${fieldname}" exceeds allowable file count limit of ${rule.maxCount} (received ${count})`,
              {
                detail: `Policy "${policy.namespace}" limits field "${fieldname}" to max ${rule.maxCount}`,
              },
            );
          }
        }
      }

      // 2. Validate, hash, sniff and wrap each file
      const processedMap = new Map<Express.Multer.File, IngestedFile>();

      for (const file of rawFiles) {
        const ingested = await this.validateAndWrapFile(file, policy);
        processedMap.set(file, ingested);
      }

      // 3. Return original structure populated with IngestedFile instances
      if (isSingle) {
        return processedMap.get(value)!;
      }

      if (isArray) {
        return value.map((f) => processedMap.get(f)!);
      }

      if (isFieldsMap) {
        const result: Record<string, IngestedFile[]> = {};
        for (const [k, files] of Object.entries(
          value as Record<string, Express.Multer.File[]>,
        )) {
          result[k] = files.map((f) => processedMap.get(f)!);
        }
        return result;
      }

      throw new ValidationError('Invalid file payload');
    } catch (err: unknown) {
      // Guaranteed atomic rollback on validation failure: dispose all files
      await this.disposeRawFiles(rawFiles);
      throw err;
    }
  }

  private async validateAndWrapFile(
    file: Express.Multer.File,
    policy: UploadPolicy,
  ): Promise<IngestedFile> {
    // Check file presence on disk
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file.path);
    } catch {
      throw new ValidationError(
        `Staged upload file missing on disk: ${file.path}`,
      );
    }

    // Sniff real MIME type from magic bytes (never trust declared type or extension)
    const detected = await detectFileType(
      file.path,
      file.mimetype,
      file.originalname,
    );
    if (!detected) {
      throw new UnsupportedMediaTypeError(
        'Unable to detect allowable media type from file content',
        {
          detail: 'File content does not match any known safe file signature',
        },
      );
    }

    // Check against policy allowlist
    const isAllowed = policy.allowedMimeTypes.includes(detected.mime);
    if (!isAllowed) {
      throw new UnsupportedMediaTypeError(
        `Media type "${detected.mime}" is not allowed for namespace "${policy.namespace}"`,
        {
          detail: `Allowed types: ${policy.allowedMimeTypes.join(', ')}`,
        },
      );
    }

    // Check for contradiction between declared MIME / extension and detected MIME
    assertMimeCompatibility(detected.mime, file.mimetype, file.originalname);

    // Enforce size limit
    if (stat.size > policy.maxFileSizeBytes) {
      throw new PayloadTooLargeError(
        `Uploaded file "${file.originalname}" (${stat.size} bytes) exceeds maximum allowable size of ${policy.maxFileSizeBytes} bytes`,
        {
          detail: `Size: ${stat.size} bytes, limit: ${policy.maxFileSizeBytes} bytes`,
        },
      );
    }

    // Compute SHA-256 hex digest
    const sha256 = await hashFile(file.path);

    // Sanitize filename
    const originalName = sanitizeFilename(file.originalname);

    return new IngestedFileImpl({
      fieldName: file.fieldname,
      originalName,
      declaredMime: file.mimetype,
      detectedMime: detected.mime,
      size: stat.size,
      sha256,
      path: file.path,
      onDisposed: (filePath) => {
        if (this.request) {
          unregisterStagedFile(this.request, filePath);
        }
      },
    });
  }

  private async disposeRawFiles(files: Express.Multer.File[]): Promise<void> {
    for (const f of files) {
      if (f.path) {
        try {
          await fs.promises.unlink(f.path);
        } catch {
          // Ignore ENOENT
        }
      }
    }
    if (this.request) {
      await cleanUpStagedFiles(this.request);
    }
  }

  private isMulterFile(item: unknown): item is Express.Multer.File {
    return (
      typeof item === 'object' &&
      item !== null &&
      'path' in item &&
      'fieldname' in item &&
      'originalname' in item &&
      'mimetype' in item
    );
  }
}
