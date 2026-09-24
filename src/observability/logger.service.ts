import { Injectable, LoggerService } from '@nestjs/common';
import { Logger } from 'nestjs-pino';
import { getCorrelationContext } from './correlation-context.js';

@Injectable()
export class StructuredLogger implements LoggerService {
  constructor(private readonly pinoLogger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    const ctx = getCorrelationContext();
    this.pinoLogger.log({
      message: typeof message === 'string' ? message : String(message),
      correlationId: ctx?.correlationId,
      namespace: ctx?.namespace,
      tenantId: ctx?.tenantId,
      fileId: ctx?.fileId,
      extra: optionalParams.length > 0 ? optionalParams : undefined,
    });
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const ctx = getCorrelationContext();
    this.pinoLogger.error({
      message: typeof message === 'string' ? message : String(message),
      correlationId: ctx?.correlationId,
      namespace: ctx?.namespace,
      tenantId: ctx?.tenantId,
      fileId: ctx?.fileId,
      extra: optionalParams.length > 0 ? optionalParams : undefined,
    });
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const ctx = getCorrelationContext();
    this.pinoLogger.warn({
      message: typeof message === 'string' ? message : String(message),
      correlationId: ctx?.correlationId,
      namespace: ctx?.namespace,
      tenantId: ctx?.tenantId,
      fileId: ctx?.fileId,
      extra: optionalParams.length > 0 ? optionalParams : undefined,
    });
  }

  debug?(message: unknown, ...optionalParams: unknown[]): void {
    const ctx = getCorrelationContext();
    this.pinoLogger.debug({
      message: typeof message === 'string' ? message : String(message),
      correlationId: ctx?.correlationId,
      namespace: ctx?.namespace,
      tenantId: ctx?.tenantId,
      fileId: ctx?.fileId,
      extra: optionalParams.length > 0 ? optionalParams : undefined,
    });
  }
}
