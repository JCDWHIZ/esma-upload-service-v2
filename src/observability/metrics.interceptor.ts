import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.record(req, res);
        },
        error: () => {
          this.record(req, res);
        },
      }),
    );
  }

  private record(req: Request, res: Response): void {
    try {
      const method = req.method ?? 'GET';
      const route = req.route?.path ? String(req.route.path) : (req.path ?? 'unknown');
      const statusCode = String(res.statusCode ?? 200);

      this.metricsService.httpRequestsTotal.inc({
        method,
        route,
        status_code: statusCode,
      });
    } catch {
      // Metrics collection must never break request execution
    }
  }
}
