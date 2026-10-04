import { Injectable, Logger } from '@nestjs/common';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { Readable, once } from 'node:stream';
import { AppConfigService } from '../config/config.service.js';
import type { IVirusScanner, ScanResult } from './types.js';
import { AppError } from '../core/errors/app-error.js';

export class ClamAvError extends AppError {
  constructor(message: string, code = 'CLAMAV_ERROR') {
    super({
      message,
      code,
      status: 502,
    });
    this.name = 'ClamAvError';
  }
}

export class ClamAvConnectionError extends ClamAvError {
  constructor(message: string) {
    super(message, 'CLAMAV_CONNECTION_ERROR');
    this.name = 'ClamAvConnectionError';
  }
}

export class ClamAvTimeoutError extends ClamAvError {
  constructor(message: string) {
    super(message, 'CLAMAV_TIMEOUT_ERROR');
    this.name = 'ClamAvTimeoutError';
  }
}

const CHUNK_SIZE = 64 * 1024; // 64 KiB per clamd protocol best practice

@Injectable()
export class ClamAvScanner implements IVirusScanner {
  private readonly logger = new Logger(ClamAvScanner.name);

  constructor(private readonly configService: AppConfigService) {}

  get host(): string {
    return this.configService.clamavHost || 'localhost';
  }

  get port(): number {
    return this.configService.clamavPort || 3310;
  }

  get timeoutMs(): number {
    return this.configService.clamavTimeoutMs || 30000;
  }

  /**
   * Pings the ClamAV daemon using the zPING\0 command.
   * Returns true if clamd responds with PONG, false otherwise.
   */
  async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
      });

      let resolved = false;
      const finish = (result: boolean) => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          resolve(result);
        }
      };

      socket.setTimeout(5000);
      socket.on('timeout', () => finish(false));
      socket.on('error', () => finish(false));

      socket.on('connect', () => {
        socket.write('zPING\0');
      });

      let response = '';
      socket.on('data', (chunk) => {
        response += chunk.toString('utf-8');
        if (response.includes('PONG')) {
          finish(true);
        }
      });

      socket.on('end', () => {
        finish(response.includes('PONG'));
      });
    });
  }

  /**
   * Scans a file on disk by streaming it through ClamAV.
   */
  async scan(filePath: string): Promise<ScanResult> {
    const stream = fs.createReadStream(filePath);
    return this.scanStream(stream);
  }

  /**
   * Speaks the clamd INSTREAM protocol over TCP:
   * 1. Send 'zINSTREAM\0'
   * 2. Stream chunks prefixed with 4-byte big-endian chunk length
   * 3. Send 4-byte 0 length delimiter [0, 0, 0, 0]
   * 4. Receive and parse clamd response:
   *    - 'stream: OK' -> clean
   *    - 'stream: <threat> FOUND' -> infected
   *    - 'stream: <msg> ERROR' -> error
   */
  async scanStream(stream: Readable): Promise<ScanResult> {
    const host = this.host;
    const port = this.port;
    const timeoutMs = this.timeoutMs;

    return new Promise<ScanResult>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let scannedBytes = 0;
      let settled = false;
      let responseData = '';

      const cleanup = () => {
        if (!settled) {
          settled = true;
          socket.destroy();
        }
      };

      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };

      const succeed = (result: ScanResult) => {
        cleanup();
        resolve(result);
      };

      socket.setTimeout(timeoutMs);

      socket.on('timeout', () => {
        fail(
          new ClamAvTimeoutError(
            `ClamAV scan timed out after ${timeoutMs}ms (${host}:${port})`,
          ),
        );
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
          fail(
            new ClamAvConnectionError(
              `Failed to connect to ClamAV daemon at ${host}:${port}: ${err.message}`,
            ),
          );
        } else {
          // If socket closed/errored while data was already received from clamd,
          // it might be an early termination from clamd (e.g. virus found or size exceeded)
          if (responseData.length > 0) {
            parseResponseAndSettle();
          } else {
            fail(new ClamAvError(`ClamAV socket error: ${err.message}`));
          }
        }
      });

      const parseResponseAndSettle = () => {
        const trimmed = responseData.replace(/[\0\r\n]+$/, '').trim();

        // 1. stream: OK
        if (trimmed === 'stream: OK' || trimmed.endsWith(': OK')) {
          succeed({ clean: true, scannedBytes });
          return;
        }

        // 2. stream: <threat> FOUND
        const foundMatch = /stream:\s*(.+)\s+FOUND$/i.exec(trimmed);
        if (foundMatch) {
          const threat = foundMatch[1].trim();
          this.logger.warn(`ClamAV virus detected: "${threat}"`);
          succeed({ clean: false, threat, scannedBytes });
          return;
        }

        // 3. stream: <err> ERROR
        const errorMatch = /stream:\s*(.+)\s+ERROR$/i.exec(trimmed);
        if (errorMatch) {
          const errorMsg = errorMatch[1].trim();
          fail(new ClamAvError(`ClamAV scan error: ${errorMsg}`));
          return;
        }

        if (trimmed.length > 0) {
          fail(new ClamAvError(`Unexpected response from ClamAV: ${trimmed}`));
        } else {
          fail(
            new ClamAvError(
              'ClamAV closed connection without returning a response',
            ),
          );
        }
      };

      socket.on('data', (chunk) => {
        responseData += chunk.toString('utf-8');
        // clamd responses end with \0 or \n
        if (responseData.includes('\0') || responseData.includes('\n')) {
          parseResponseAndSettle();
        }
      });

      socket.on('end', () => {
        if (!settled) {
          parseResponseAndSettle();
        }
      });

      socket.on('connect', () => {
        void (async () => {
          try {
            // 1. Send handshake
            const ok = socket.write('zINSTREAM\0');
            if (!ok) {
              await once(socket, 'drain');
            }

            // 2. Stream chunks
            for await (const rawChunk of stream) {
              if (settled) break;

              const buf = Buffer.isBuffer(rawChunk)
                ? rawChunk
                : Buffer.from(rawChunk as string);

              let offset = 0;
              while (offset < buf.length) {
                if (settled) break;
                const sliceLen = Math.min(CHUNK_SIZE, buf.length - offset);
                const slice = buf.subarray(offset, offset + sliceLen);
                offset += sliceLen;

                // Write 4-byte BE length prefix
                const lenBuf = Buffer.alloc(4);
                lenBuf.writeUInt32BE(slice.length, 0);

                const canWriteLen = socket.write(lenBuf);
                if (!canWriteLen) {
                  await once(socket, 'drain');
                }

                const canWriteData = socket.write(slice);
                scannedBytes += slice.length;

                if (!canWriteData) {
                  await once(socket, 'drain');
                }
              }
            }

            if (settled) return;

            // 3. Send zero-length terminator
            const endBuf = Buffer.alloc(4); // [0, 0, 0, 0]
            const canWriteEnd = socket.write(endBuf);
            if (!canWriteEnd) {
              await once(socket, 'drain');
            }
          } catch (err: unknown) {
            if (!settled) {
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
      });
    });
  }
}
