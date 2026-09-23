import { Module, Global } from '@nestjs/common';
import { AppConfigService } from './config.service.js';

@Global()
@Module({
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
