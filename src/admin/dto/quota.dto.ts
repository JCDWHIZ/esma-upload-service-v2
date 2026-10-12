import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const quotaPatchBodySchema = z.object({
  namespace: z.string().trim().min(1).optional(),
  maxBytes: z.number().int().nonnegative().nullable().optional(),
  maxFiles: z.number().int().nonnegative().nullable().optional(),
  overrideQuotaBytes: z.number().int().nonnegative().nullable().optional(),
  reason: z.string().trim().min(1).optional(),
  expiresAt: z.union([z.string().datetime(), z.string()]).nullable().optional(),
});

export type QuotaPatchBody = z.infer<typeof quotaPatchBodySchema>;

export class QuotaPatchBodyDto {
  @ApiPropertyOptional({
    description: 'Target namespace (defaults to "generic")',
    example: 'generic',
  })
  namespace?: string;

  @ApiPropertyOptional({
    description: 'Maximum allowable storage bytes (null for unlimited)',
    nullable: true,
    example: 104857600,
  })
  maxBytes?: number | null;

  @ApiPropertyOptional({
    description: 'Maximum allowable file count (null for unlimited)',
    nullable: true,
    example: 1000,
  })
  maxFiles?: number | null;

  @ApiPropertyOptional({
    description: 'Administrative override quota bytes (UR-13)',
    nullable: true,
    example: 2147483648,
  })
  overrideQuotaBytes?: number | null;

  @ApiPropertyOptional({
    description: 'Reason for administrative quota override (UR-13)',
    example: 'Extended evaluation tier approval',
  })
  reason?: string;

  @ApiPropertyOptional({
    description: 'Expiration date/time of the override (ISO 8601, null for persistent)',
    nullable: true,
    example: '2026-12-31T23:59:59Z',
  })
  expiresAt?: string | null;
}
