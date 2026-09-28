import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { LocalStorageDriver } from '../../src/storage/drivers/local.driver.js';
import { runDriverContract } from './driver.contract.js';

describe('LocalStorageDriver Contract Verification', () => {
  let tempDir: string;
  let driver: LocalStorageDriver;

  beforeAll(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'local-driver-contract-'),
    );
    driver = new LocalStorageDriver({ rootPath: tempDir });
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.promises
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => {});
    }
  });

  runDriverContract('LocalStorageDriver', () => driver);
});
