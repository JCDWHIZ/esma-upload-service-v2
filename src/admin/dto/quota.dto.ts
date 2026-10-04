import { ApiPropertyOptional } from '@nestjs/swagger';
import { z } from 'zod';

export const quotaPatchBodySchema = z.object({
  namespace: z.string().trim().min(1).optional(),
  maxBytes: z.number().int().nonnegative().nullable().optional(),
  maxFiles: z.number().int().nonnegative().nullable().optional(),
});

export type QuotaPatchBody = z.infer<typeof quotaPatchBodySchema>;

export class QuotaPatchBodyDto {
  @ApiPropertyOptional({
    description: 'Target namespace (defaults to "default")',
  })
  namespace?: string;

  @ApiPropertyOptional({
    description: 'Maximum allowable storage bytes (null for unlimited)',
    nullable: true,
  })
  maxBytes?: number | null;

  @ApiPropertyOptional({
    description: 'Maximum allowable file count (null for unlimited)',
    nullable: true,
  })
  maxFiles?: number | null;
}
