import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response, Request } from 'express';
import { mapExceptionToCanonical } from './error-mapper.js';

@Catch()
export class LegacyErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const fallbackId =
      (request?.headers?.['x-correlation-id'] as string) || 'unknown';
    const canonical = mapExceptionToCanonical(exception, fallbackId);

    if (response?.setHeader) {
      response.setHeader('x-correlation-id', canonical.correlationId);
      response.setHeader('Content-Type', 'application/json');
    }

    const errorMessage = canonical.expose
      ? canonical.detail
      : 'Internal Server Error';

    response.status(canonical.status).json({
      success: false,
      error: errorMessage,
      message: errorMessage,
      code: canonical.code,
      correlationId: canonical.correlationId,
      ...(canonical.errors.length > 0 ? { errors: canonical.errors } : {}),
    });
  }
}
