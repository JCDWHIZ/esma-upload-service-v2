import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class StructuredLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]) {
    console.log(
      JSON.stringify({
        level: 'info',
        message: typeof message === 'string' ? message : String(message),
        timestamp: new Date().toISOString(),
        extra: optionalParams,
      }),
    );
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: typeof message === 'string' ? message : String(message),
        timestamp: new Date().toISOString(),
        extra: optionalParams,
      }),
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: typeof message === 'string' ? message : String(message),
        timestamp: new Date().toISOString(),
        extra: optionalParams,
      }),
    );
  }

  debug?(message: unknown, ...optionalParams: unknown[]) {
    console.debug(
      JSON.stringify({
        level: 'debug',
        message: typeof message === 'string' ? message : String(message),
        timestamp: new Date().toISOString(),
        extra: optionalParams,
      }),
    );
  }
}
