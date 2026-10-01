import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiSecurity,
  ApiParam,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard.js';
import { ContextGuard } from '../auth/guards/context.guard.js';
import { AuthorizationGuard } from '../authz/guards/authorization.guard.js';
import { Accept } from '../auth/decorators/accept.decorator.js';
import { RequireAction } from '../authz/decorators/require-action.decorator.js';
import { ProblemJsonErrorFilter } from '../common/filters/problem-json-error.filter.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import type { AuthenticatedHttpRequest } from '../auth/context.js';
import { DeadLetterService } from '../events/dead-letter.service.js';
import {
  dlqListQuerySchema,
  type DlqListQuery,
  DlqRedriveBodyDto,
  dlqRedriveBodySchema,
  DlqDiscardBodyDto,
  dlqDiscardBodySchema,
} from './dto/dlq.dto.js';
import type { DeadLetterFilter } from '../core/types.js';

@ApiTags('admin-dlq')
@ApiBearerAuth()
@ApiSecurity('api-key')
@Controller('api/v1/admin/dlq')
@UseGuards(AuthGuard, ContextGuard, AuthorizationGuard)
@UseFilters(ProblemJsonErrorFilter)
@Accept('admin-jwt', 'bearer-jwt', 'api-key')
@RequireAction('admin')
export class DlqController {
  constructor(private readonly deadLetterService: DeadLetterService) {}

  @Get()
  @ApiOperation({
    summary: 'List dead letters with filters and keyset pagination',
    description:
      'Retrieve dead-lettered messages, filtering by status, topic, event, or timestamp.',
  })
  @ApiResponse({
    status: 200,
    description:
      'List of dead letters with pagination cursor and totalOpen count',
  })
  async list(
    @Query(new ZodValidationPipe(dlqListQuerySchema)) query: DlqListQuery,
  ) {
    const filter: DeadLetterFilter = {
      status: query.status,
      originalTopic: query.originalTopic,
      eventType: query.eventType,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    };

    return this.deadLetterService.list(filter, query.cursor, query.limit);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get DLQ depth and operational stats',
    description:
      'Returns the count of OPEN dead letters corresponding to metric gus_dlq_depth.',
  })
  @ApiResponse({ status: 200, description: 'DLQ depth and metrics' })
  async getStats() {
    const openCount = await this.deadLetterService.getDlqDepth();
    return {
      metric: 'gus_dlq_depth',
      openCount,
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get dead letter by ID' })
  @ApiParam({ name: 'id', description: 'Dead letter UUID' })
  @ApiResponse({ status: 200, description: 'Dead letter details' })
  @ApiResponse({ status: 404, description: 'Dead letter not found' })
  async getById(@Param('id') id: string) {
    return this.deadLetterService.getById(id);
  }

  @Post(':id/redrive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redrive dead letter',
    description:
      'Republish dead letter to its original topic through the outbox with attempt reset, marking it REDRIVEN.',
  })
  @ApiParam({ name: 'id', description: 'Dead letter UUID' })
  @ApiResponse({
    status: 200,
    description: 'Dead letter successfully redriven',
  })
  @ApiResponse({
    status: 400,
    description: 'Dead letter is not in OPEN status',
  })
  @ApiResponse({ status: 404, description: 'Dead letter not found' })
  async redrive(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dlqRedriveBodySchema)) body: DlqRedriveBodyDto,
    @Req() req: AuthenticatedHttpRequest,
  ) {
    const actorId = req.ctx?.actor?.id ?? 'admin';
    const deadLetter = await this.deadLetterService.redrive(id, actorId, {
      directPublish: body.directPublish,
    });

    return {
      message: 'Dead letter redriven successfully',
      deadLetter,
    };
  }

  @Post(':id/discard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Discard dead letter',
    description:
      'Mark a dead letter as DISCARDED so it is permanently resolved without re-execution.',
  })
  @ApiParam({ name: 'id', description: 'Dead letter UUID' })
  @ApiResponse({
    status: 200,
    description: 'Dead letter discarded successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Dead letter is not in OPEN status',
  })
  @ApiResponse({ status: 404, description: 'Dead letter not found' })
  async discard(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(dlqDiscardBodySchema)) body: DlqDiscardBodyDto,
    @Req() req: AuthenticatedHttpRequest,
  ) {
    const actorId = req.ctx?.actor?.id ?? 'admin';
    const deadLetter = await this.deadLetterService.discard(
      id,
      actorId,
      body.reason,
    );

    return {
      message: 'Dead letter discarded successfully',
      deadLetter,
    };
  }
}
