import { PipeTransform, Injectable } from '@nestjs/common';
import type { ZodType, ZodIssue } from 'zod';
import { ValidationError } from '../../core/errors/app-error.js';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType<unknown>) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const formattedErrors = result.error.issues.map((err: ZodIssue) => ({
        path: err.path.join('.') || 'root',
        message: err.message,
        code: err.code,
      }));

      const errorMessages = formattedErrors
        .map(
          (e: { path: string; message: string }) => `${e.path}: ${e.message}`,
        )
        .join('; ');

      throw new ValidationError(errorMessages || 'Request validation failed', {
        detail: `Validation failed: ${errorMessages}`,
        errors: formattedErrors,
      });
    }
    return result.data;
  }
}
