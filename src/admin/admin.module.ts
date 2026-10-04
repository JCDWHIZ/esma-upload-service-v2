import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { ObservabilityModule } from '../observability/observability.module.js';
import { DatabaseModule } from '../db/database.module.js';
import { EventsModule } from '../events/events.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authz/authorization.module.js';
import { DlqController } from './dlq.controller.js';
import { QuotaController } from './quota.controller.js';
import { TenantUsageReconciler } from './tenant-usage-reconciler.service.js';

@Module({
  imports: [
    ConfigModule,
    ObservabilityModule,
    DatabaseModule,
    EventsModule,
    AuthModule,
    AuthorizationModule,
  ],
  controllers: [DlqController, QuotaController],
  providers: [TenantUsageReconciler],
})
export class AdminModule {}
