import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const dlqListQuerySchema = z.object({
  status: z.enum(['OPEN', 'REDRIVEN', 'DISCARDED']).optional(),
  originalTopic: z.string().trim().min(1).optional(),
  eventType: z.string().trim().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type DlqListQuery = z.infer<typeof dlqListQuerySchema>;

export class DlqListQueryDto {
  @ApiPropertyOptional({
    enum: ['OPEN', 'REDRIVEN', 'DISCARDED'],
    description: 'Filter by dead-letter status',
  })
  status?: 'OPEN' | 'REDRIVEN' | 'DISCARDED';

  @ApiPropertyOptional({ description: 'Filter by original topic' })
  originalTopic?: string;

  @ApiPropertyOptional({ description: 'Filter by event type' })
  eventType?: string;

  @ApiPropertyOptional({ description: 'Filter from ISO timestamp' })
  from?: string;

  @ApiPropertyOptional({ description: 'Filter to ISO timestamp' })
  to?: string;

  @ApiPropertyOptional({ description: 'Keyset cursor for pagination' })
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  limit?: number;
}

export const dlqRedriveBodySchema = z.object({
  directPublish: z.boolean().optional(),
});

export class DlqRedriveBodyDto {
  @ApiPropertyOptional({
    description: 'Directly publish to broker bypassing outbox relay',
  })
  directPublish?: boolean;
}

export const dlqDiscardBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000).optional(),
});

export class DlqDiscardBodyDto {
  @ApiPropertyOptional({ description: 'Reason for discarding the dead letter' })
  reason?: string;
}
