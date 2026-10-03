import { describe } from 'vitest';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';
import { runDriverContract } from './driver.contract.js';

describe('FakeStorageDriver Contract Verification', () => {
  runDriverContract('FakeStorageDriver', () => new FakeStorageDriver('local'), {
    cleanup: (driver) => {
      (driver as FakeStorageDriver).clear();
    },
  });
});
