import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response, Request } from 'express';
import { mapExceptionToCanonical } from './error-mapper.js';

@Catch()
export class ProblemJsonErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const fallbackId =
      (request?.headers?.['x-correlation-id'] as string) || 'unknown';
    const canonical = mapExceptionToCanonical(exception, fallbackId);

    if (response?.setHeader) {
      response.setHeader('x-correlation-id', canonical.correlationId);
      response.setHeader('Content-Type', 'application/problem+json');
    }

    response.status(canonical.status).json({
      type: canonical.typeUrl,
      title: canonical.title,
      status: canonical.status,
      statusCode: canonical.status,
      code: canonical.code,
      error: canonical.code,
      detail: canonical.detail,
      message: canonical.detail,
      correlationId: canonical.correlationId,
      errors: canonical.errors,
    });
  }
}
