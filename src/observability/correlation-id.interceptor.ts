import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import {
  correlationStorage,
  CorrelationContext,
} from './correlation-context.js';

export const CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{8,64}$/;

export function resolveOrGenerateCorrelationId(headerValue: unknown): string {
  if (
    typeof headerValue === 'string' &&
    CORRELATION_ID_REGEX.test(headerValue)
  ) {
    return headerValue;
  }
  return uuidv7();
}

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const http = context.switchToHttp();
      const req = http.getRequest<Request>();
      const res = http.getResponse<Response>();

      const existing =
        req?.headers?.['x-correlation-id'] ??
        (res?.getHeader ? res.getHeader('x-correlation-id') : undefined);
      const correlationId = resolveOrGenerateCorrelationId(existing);

      if (req?.headers) {
        req.headers['x-correlation-id'] = correlationId;
      }
      if (res?.setHeader) {
        res.setHeader('x-correlation-id', correlationId);
      }

      const store: CorrelationContext = {
        correlationId,
      };

      return new Observable((subscriber) => {
        correlationStorage.run(store, () => {
          next.handle().subscribe(subscriber);
        });
      });
    }

    return next.handle();
  }
}
