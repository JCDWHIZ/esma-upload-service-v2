import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import {
  ClamAvScanner,
  ClamAvError,
  ClamAvConnectionError,
  ClamAvTimeoutError,
} from '../../src/ingest/clamav.scanner.js';
import type { AppConfigService } from '../../src/config/config.service.js';

describe('ClamAvScanner (P5-07)', () => {
  let server: net.Server;
  let serverPort: number;
  let mockConfig: AppConfigService;
  let scanner: ClamAvScanner;
  let serverResponses: (socket: net.Socket, data: Buffer) => void;

  beforeEach(async () => {
    serverResponses = () => {};
    server = net.createServer((socket) => {
      socket.on('data', (data) => {
        serverResponses(socket, data);
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        serverPort = addr.port;
        resolve();
      });
    });

    mockConfig = {
      clamavHost: '127.0.0.1',
      clamavPort: serverPort,
      clamavTimeoutMs: 5000,
    } as unknown as AppConfigService;

    scanner = new ClamAvScanner(mockConfig);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe('ping()', () => {
    it('returns true when clamd returns PONG', async () => {
      serverResponses = (socket, data) => {
        if (data.toString('utf-8').includes('zPING')) {
          socket.write('PONG\0');
        }
      };

      const result = await scanner.ping();
      expect(result).toBe(true);
    });

    it('returns false when clamd connection fails', async () => {
      const badConfig = {
        clamavHost: '127.0.0.1',
        clamavPort: 65432, // Closed port
        clamavTimeoutMs: 1000,
      } as unknown as AppConfigService;
      const badScanner = new ClamAvScanner(badConfig);

      const result = await badScanner.ping();
      expect(result).toBe(false);
    });
  });

  describe('scanStream()', () => {
    it('scans a clean stream and returns clean=true', async () => {
      let receivedHandshake = false;
      const receivedChunks: Buffer[] = [];

      serverResponses = (socket, data) => {
        let cursor = 0;
        if (!receivedHandshake) {
          const str = data.toString('utf-8');
          if (str.startsWith('zINSTREAM\0')) {
            receivedHandshake = true;
            cursor = 10; // length of 'zINSTREAM\0'
          }
        }

        while (cursor + 4 <= data.length) {
          const chunkLen = data.readUInt32BE(cursor);
          cursor += 4;
          if (chunkLen === 0) {
            // End of stream! Reply stream: OK\0
            socket.write('stream: OK\0');
            return;
          }
          const chunk = data.subarray(cursor, cursor + chunkLen);
          receivedChunks.push(chunk);
          cursor += chunkLen;
        }
      };

      const testContent = Buffer.from(
        'Clean document payload for virus scanning',
      );
      const stream = Readable.from([testContent]);

      const result = await scanner.scanStream(stream);

      expect(result.clean).toBe(true);
      expect(result.threat).toBeUndefined();
      expect(result.scannedBytes).toBe(testContent.length);
      expect(Buffer.concat(receivedChunks).toString('utf-8')).toBe(
        testContent.toString('utf-8'),
      );
    });

    it('detects infected file (EICAR standard test signature)', async () => {
      // Standard EICAR test string
      const eicarString =
        'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

      serverResponses = (socket, data) => {
        const str = data.toString('utf-8');
        if (str.includes('EICAR')) {
          socket.write('stream: Eicar-Test-Signature FOUND\0');
        }
      };

      const stream = Readable.from([Buffer.from(eicarString)]);
      const result = await scanner.scanStream(stream);

      expect(result.clean).toBe(false);
      expect(result.threat).toBe('Eicar-Test-Signature');
    });

    it('correctly slices large chunks (>64KB) with chunk headers', async () => {
      const largePayload = Buffer.alloc(150 * 1024, 0x41); // 150 KiB
      const chunkSizes: number[] = [];
      let serverBuffer = Buffer.alloc(0);

      serverResponses = (socket, data) => {
        serverBuffer = Buffer.concat([serverBuffer, data]);
        let cursor = 0;
        if (serverBuffer.toString('utf-8').startsWith('zINSTREAM\0')) {
          cursor = 10;
        } else {
          return;
        }

        while (cursor + 4 <= serverBuffer.length) {
          const chunkLen = serverBuffer.readUInt32BE(cursor);
          if (chunkLen === 0) {
            socket.write('stream: OK\0');
            return;
          }
          if (cursor + 4 + chunkLen > serverBuffer.length) {
            // Partial chunk received, wait for next data event
            break;
          }
          cursor += 4;
          chunkSizes.push(chunkLen);
          cursor += chunkLen;
        }
      };

      const stream = Readable.from([largePayload]);
      const result = await scanner.scanStream(stream);

      expect(result.clean).toBe(true);
      expect(result.scannedBytes).toBe(largePayload.length);
      // Max chunk size is 64KB (65536)
      for (const size of chunkSizes) {
        expect(size).toBeLessThanOrEqual(65536);
      }
    });

    it('throws ClamAvError when clamd returns ERROR response', async () => {
      serverResponses = (socket, data) => {
        if (data.toString('utf-8').includes('zINSTREAM')) {
          socket.write('stream: INSTREAM size limit exceeded. ERROR\0');
        }
      };

      const stream = Readable.from([Buffer.from('large data')]);

      await expect(scanner.scanStream(stream)).rejects.toThrow(ClamAvError);
      await expect(scanner.scanStream(stream)).rejects.toThrow(
        /INSTREAM size limit exceeded/,
      );
    });

    it('throws ClamAvConnectionError when daemon is unreachable', async () => {
      const unreachableConfig = {
        clamavHost: '127.0.0.1',
        clamavPort: 65431,
        clamavTimeoutMs: 1000,
      } as unknown as AppConfigService;
      const unreachableScanner = new ClamAvScanner(unreachableConfig);

      const stream = Readable.from([Buffer.from('hello')]);
      await expect(unreachableScanner.scanStream(stream)).rejects.toThrow(
        ClamAvConnectionError,
      );
    });

    it('throws ClamAvTimeoutError when clamd does not respond in time', async () => {
      const timeoutConfig = {
        clamavHost: '127.0.0.1',
        clamavPort: serverPort,
        clamavTimeoutMs: 50, // very low timeout
      } as unknown as AppConfigService;
      const timeoutScanner = new ClamAvScanner(timeoutConfig);

      // Server never replies
      serverResponses = () => {};

      const stream = Readable.from([Buffer.from('waiting data')]);
      await expect(timeoutScanner.scanStream(stream)).rejects.toThrow(
        ClamAvTimeoutError,
      );
    });
  });

  describe('scan() file path', () => {
    it('streams a file from disk through scanStream', async () => {
      serverResponses = (socket, data) => {
        let cursor = 0;
        if (data.toString('utf-8').startsWith('zINSTREAM\0')) {
          cursor = 10;
        }
        while (cursor + 4 <= data.length) {
          const chunkLen = data.readUInt32BE(cursor);
          cursor += 4;
          if (chunkLen === 0) {
            socket.write('stream: OK\0');
            return;
          }
          cursor += chunkLen;
        }
      };

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clamav-test-'));
      const tmpFile = path.join(tmpDir, 'test.txt');
      await fs.writeFile(tmpFile, 'Local file on disk to scan');

      try {
        const result = await scanner.scan(tmpFile);
        expect(result.clean).toBe(true);
        expect(result.scannedBytes).toBeGreaterThan(0);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
