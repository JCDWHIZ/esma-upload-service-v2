import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { FilesService } from '../src/files/files.service.js';
import { AppConfigService } from '../src/config/config.service.js';

describe('App Bootstrap', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile AppModule without missing providers or circular dependencies', () => {
    expect(moduleRef).toBeDefined();
  });

  it('should resolve AppConfigService and FilesService', () => {
    const config = moduleRef.get(AppConfigService);
    const files = moduleRef.get(FilesService);
    expect(config).toBeDefined();
    expect(files).toBeDefined();
    expect(config.port).toBe(7030);
  });
});
