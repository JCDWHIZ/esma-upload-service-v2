import { Logger } from '@nestjs/common';
import { PermanentError, RetryableError } from '../core/errors/app-error.js';
import type {
  DeliveryMeta,
  HandlerOutcome,
  Subscription,
} from './broker.interface.js';
import type { EventType } from './catalog.js';
import { parseEventPayload } from './catalog.js';
import type { EventEnvelope } from './envelope.js';
import { computeBackoff } from './backoff.js';
import type {
  ConsumerContext,
  ConsumerDefinition,
  ConsumerMetrics,
  ConsumerRunnable,
} from './consumer.interface.js';

export function defineConsumer<T = unknown>(
  def: ConsumerDefinition<T>,
): ConsumerRunnable {
  const logger = def.logger ?? new Logger(`Consumer:${def.name}`);
  const concurrency = def.concurrency ?? 1;
  const maxAttempts = def.maxAttempts ?? 5;
  const handlerTimeoutMs = def.handlerTimeoutMs ?? 30_000;
  const shutdownTimeoutMs = def.shutdownTimeoutMs ?? 10_000;

  const metrics: ConsumerMetrics = {
    processed: 0,
    retried: 0,
    deadLettered: 0,
    handlerDurationMsTotal: 0,
  };

  let subscription: Subscription | null = null;
  let running = false;
  const inFlightExecutions = new Set<Promise<void>>();

  async function handleMessage(
    envelope: EventEnvelope<T>,
    meta: DeliveryMeta,
  ): Promise<HandlerOutcome> {
    const startTime = Date.now();
    const currentAttempt = meta.attempt + 1;

    // 1. Validate payload against schema catalog before dispatching to handler
    try {
      parseEventPayload(
        envelope.eventType as EventType,
        envelope.payload,
        envelope.schemaVersion,
      );
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : 'Event payload validation error';
      logger.error(
        `Consumer ${def.name}: event ${envelope.eventId} failed payload validation: ${reason}`,
      );

      metrics.deadLettered++;
      if (def.broker.name !== 'memory') {
        await publishToDlq(envelope, meta, reason, currentAttempt);
      }
      return { kind: 'dead-letter', reason };
    }

    // 2. Execute handler with timeout and abort signal
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(
        new RetryableError(
          `Consumer ${def.name}: handler execution timed out after ${handlerTimeoutMs}ms`,
        ),
      );
    }, handlerTimeoutMs);

    const ctx: ConsumerContext = {
      meta,
      signal: controller.signal,
      attempt: currentAttempt,
      logger,
    };

    let outcome: HandlerOutcome;
    try {
      const result = await Promise.race([
        def.handler(envelope, ctx),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            const abortReason: unknown = controller.signal.reason;
            const err =
              abortReason instanceof Error
                ? abortReason
                : new RetryableError(String(abortReason));
            reject(err);
          });
        }),
      ]);

      outcome = result ?? { kind: 'ack' };
    } catch (err: unknown) {
      if (err instanceof PermanentError) {
        outcome = { kind: 'dead-letter', reason: err.message };
      } else {
        const errorReason =
          err instanceof Error ? err.message : 'Unknown handler failure';

        if (currentAttempt >= maxAttempts) {
          outcome = {
            kind: 'dead-letter',
            reason: `Exceeded max attempts (${maxAttempts}): ${errorReason}`,
          };
        } else {
          const delayMs = computeBackoff(
            currentAttempt,
            def.backoffPolicy,
            def.rng,
            err,
          );
          outcome = {
            kind: 'retry',
            delayMs,
            reason: errorReason,
          };
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
      const duration = Date.now() - startTime;
      metrics.handlerDurationMsTotal += duration;
      metrics.lastExecutionDurationMs = duration;
    }

    // 3. Process outcome metrics and DLQ publication
    if (outcome.kind === 'ack') {
      metrics.processed++;
    } else if (outcome.kind === 'retry') {
      metrics.retried++;
      logger.warn(
        `Consumer ${def.name}: retrying event ${envelope.eventId} (attempt ${currentAttempt}/${maxAttempts}, delay ${outcome.delayMs}ms): ${outcome.reason}`,
      );
    } else if (outcome.kind === 'dead-letter') {
      metrics.deadLettered++;
      logger.error(
        `Consumer ${def.name}: dead-lettering event ${envelope.eventId}: ${outcome.reason}`,
      );
      if (def.broker.name !== 'memory') {
        await publishToDlq(envelope, meta, outcome.reason, currentAttempt);
      }
    }

    return outcome;
  }

  async function publishToDlq(
    envelope: EventEnvelope<T>,
    meta: DeliveryMeta,
    reason: string,
    attempt: number,
  ): Promise<void> {
    const dlqHeaders: Record<string, string> = {
      ...(meta.headers ?? {}),
      'x-original-topic': def.topic,
      'x-event-type': envelope.eventType,
      'x-error': reason,
      'x-attempts': String(attempt),
      'x-first-failed-at': meta.timestamp,
    };

    try {
      await def.broker.publish('dlq', envelope.partitionKey, envelope, {
        headers: dlqHeaders,
      });
    } catch (dlqErr: unknown) {
      logger.error(
        `Consumer ${def.name}: failed to publish event ${envelope.eventId} to DLQ: ${dlqErr instanceof Error ? dlqErr.message : String(dlqErr)}`,
      );
    }
  }

  return {
    name: def.name,
    topic: def.topic,
    group: def.group,
    metrics,

    async start(): Promise<void> {
      if (running) return;
      running = true;

      subscription = await def.broker.subscribe<T>(
        def.topic,
        {
          consumerGroup: def.group,
          concurrency,
          maxAttempts,
        },
        async (envelope, meta) => {
          const executionPromise = (async () => {
            return await handleMessage(envelope, meta);
          })();

          const trackedPromise = executionPromise.then(
            () => {},
            () => {},
          );
          inFlightExecutions.add(trackedPromise);
          void trackedPromise.finally(() => {
            inFlightExecutions.delete(trackedPromise);
          });

          return executionPromise;
        },
      );

      logger.log(
        `Consumer "${def.name}" started on topic "${def.topic}" (group: "${def.group}", concurrency: ${concurrency}, maxAttempts: ${maxAttempts})`,
      );
    },

    async stop(): Promise<void> {
      if (!running) return;
      running = false;

      logger.log(`Consumer "${def.name}" stopping, closing subscription...`);
      if (subscription) {
        await subscription.close();
        subscription = null;
      }

      if (inFlightExecutions.size > 0) {
        logger.log(
          `Consumer "${def.name}" waiting for ${inFlightExecutions.size} in-flight handlers (up to ${shutdownTimeoutMs}ms)...`,
        );

        const drainPromise = Promise.allSettled(Array.from(inFlightExecutions));
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), shutdownTimeoutMs);
        });

        const raceResult = await Promise.race([drainPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);

        if (raceResult === 'timeout') {
          logger.warn(
            `Consumer "${def.name}" shutdown timeout reached with ${inFlightExecutions.size} handlers still in-flight.`,
          );
        } else {
          logger.log(`Consumer "${def.name}" all in-flight handlers drained.`);
        }
      }

      logger.log(`Consumer "${def.name}" stopped.`);
    },

    isRunning(): boolean {
      return running;
    },
  };
}
