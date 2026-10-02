import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const auditListQuerySchema = z.object({
  namespace: z.string().trim().min(1).optional(),
  tenantId: z.string().trim().min(1).optional(),
  actorId: z.string().trim().min(1).optional(),
  fileId: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export class AuditListQueryDto {
  @ApiPropertyOptional({ description: 'Filter by namespace' })
  namespace?: string;

  @ApiPropertyOptional({ description: 'Filter by tenant ID' })
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Filter by actor ID' })
  actorId?: string;

  @ApiPropertyOptional({ description: 'Filter by file ID' })
  fileId?: string;

  @ApiPropertyOptional({ description: 'Filter by action name' })
  action?: string;

  @ApiPropertyOptional({
    enum: ['SUCCESS', 'DENIED', 'FAILURE'],
    description: 'Filter by outcome',
  })
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';

  @ApiPropertyOptional({ description: 'Filter from ISO timestamp' })
  from?: string;

  @ApiPropertyOptional({ description: 'Filter to ISO timestamp' })
  to?: string;

  @ApiPropertyOptional({ description: 'Keyset cursor for pagination' })
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  limit?: number;
}
