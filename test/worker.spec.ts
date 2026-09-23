import { Test, TestingModule } from '@nestjs/testing';
import { WorkerModule } from '../src/workers/worker.module.js';
import { DatabaseService } from '../src/db/database.service.js';

describe('Worker Bootstrap', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile WorkerModule without missing providers or circular dependencies', () => {
    expect(moduleRef).toBeDefined();
  });

  it('should resolve DatabaseService inside worker context', () => {
    const dbService = moduleRef.get(DatabaseService);
    expect(dbService).toBeDefined();
    expect(typeof dbService.ping).toBe('function');
  });
});
