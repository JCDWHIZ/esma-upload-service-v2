import type { ProcessedEventsRepository } from '../db/repositories/processed-events.repository.js';
import type { ConsumerContext, ConsumerHandler } from './consumer.interface.js';
import type { EventEnvelope } from './envelope.js';
import type { HandlerOutcome } from './broker.interface.js';

/**
 * Wraps a consumer handler with idempotent execution tracking backed by the
 * `processed_events` table (ARCH §8.5 & Task P4-05).
 *
 * If the event has already been processed for this consumer, it returns an immediate
 * `{ kind: 'ack' }` without invoking the underlying handler.
 */
export function withIdempotency<T = unknown>(
  consumerName: string,
  processedEventsRepo: ProcessedEventsRepository,
  handler: ConsumerHandler<T>,
): ConsumerHandler<T> {
  return async (
    event: EventEnvelope<T>,
    ctx: ConsumerContext,
  ): Promise<HandlerOutcome | void> => {
    const isNew = await processedEventsRepo.tryMark(
      consumerName,
      event.eventId,
      ctx.trx as never,
    );

    if (!isNew) {
      ctx.logger.debug?.(
        `Event ${event.eventId} already processed by "${consumerName}", skipping duplicate delivery.`,
      );
      return { kind: 'ack' };
    }

    return handler(event, ctx);
  };
}
