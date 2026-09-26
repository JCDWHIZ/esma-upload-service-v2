import { Module, Global } from '@nestjs/common';
import { AppConfigService } from './config.service.js';
import { PolicyRegistry } from './policy-registry.js';

@Global()
@Module({
  providers: [AppConfigService, PolicyRegistry],
  exports: [AppConfigService, PolicyRegistry],
})
export class ConfigModule {}
