import { Module, Global } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { v7 as uuidv7 } from 'uuid';
import { AppConfigService } from '../config/config.service.js';
import { ConfigModule } from '../config/config.module.js';
import {
  CorrelationIdInterceptor,
  CORRELATION_ID_REGEX,
} from './correlation-id.interceptor.js';
import { getCorrelationContext } from './correlation-context.js';
import { StructuredLogger } from './logger.service.js';

interface SerializedReq {
  id?: unknown;
  method?: string;
  url?: string;
  query?: unknown;
  headers?: unknown;
  remoteAddress?: string;
  remotePort?: number;
}

interface SerializedRes {
  statusCode?: number;
  headers?: unknown;
}

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.logLevel,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers["x-api-key"]',
              'req.headers.cookie',
              'req.headers["set-cookie"]',
              '*.secret',
              '*.token',
              '*.password',
              '*.key',
              '*.apiKey',
              '*.jwtSecret',
              '*.signedUrlSecret',
              '*.*.secret',
              '*.*.token',
              '*.*.password',
              '*.*.key',
            ],
            censor: '[REDACTED]',
          },
          genReqId: (req, res) => {
            const raw = req.headers['x-correlation-id'];
            const valid =
              typeof raw === 'string' && CORRELATION_ID_REGEX.test(raw);
            const correlationId = valid ? raw : uuidv7();
            res.setHeader('x-correlation-id', correlationId);
            return correlationId;
          },
          customProps: (req, res) => {
            const ctx = getCorrelationContext();
            return {
              correlationId:
                ctx?.correlationId ||
                (res.getHeader('x-correlation-id') as string) ||
                (req.headers['x-correlation-id'] as string),
              ...(ctx?.namespace ? { namespace: ctx.namespace } : {}),
              ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
              ...(ctx?.fileId ? { fileId: ctx.fileId } : {}),
              ...(ctx?.actorId ? { actorId: ctx.actorId } : {}),
            };
          },
          serializers: {
            req: (rawReq: unknown) => {
              const req = rawReq as SerializedReq;
              return {
                id: req.id,
                method: req.method,
                url: req.url,
                query: req.query,
                headers: req.headers,
                remoteAddress: req.remoteAddress,
                remotePort: req.remotePort,
              };
            },
            res: (rawRes: unknown) => {
              const res = rawRes as SerializedRes;
              return {
                statusCode: res.statusCode,
                headers: res.headers,
              };
            },
          },
        },
      }),
    }),
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: CorrelationIdInterceptor,
    },
    StructuredLogger,
  ],
  exports: [PinoLoggerModule, StructuredLogger],
})
export class ObservabilityModule {}
