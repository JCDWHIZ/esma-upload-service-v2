import type { Logger } from '@nestjs/common';
import type { LogicalTopic } from './catalog.js';
import type {
  DeliveryMeta,
  HandlerOutcome,
  IMessageBroker,
} from './broker.interface.js';
import type { EventEnvelope } from './envelope.js';
import type { BackoffPolicy, RngFn } from './backoff.js';

export interface ConsumerMetrics {
  processed: number;
  retried: number;
  deadLettered: number;
  handlerDurationMsTotal: number;
  lastExecutionDurationMs?: number;
}

export interface ConsumerContext {
  readonly meta: DeliveryMeta;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly logger: Logger;
  trx?: unknown;
}

export type ConsumerHandler<T = unknown> = (
  event: EventEnvelope<T>,
  ctx: ConsumerContext,
) => Promise<HandlerOutcome | void>;

export interface ConsumerDefinition<T = unknown> {
  readonly name: string;
  readonly topic: LogicalTopic;
  readonly group: string;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly handlerTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly backoffPolicy?: BackoffPolicy;
  readonly broker: IMessageBroker;
  readonly handler: ConsumerHandler<T>;
  readonly logger?: Logger;
  readonly rng?: RngFn;
}

export interface ConsumerRunnable {
  readonly name: string;
  readonly topic: LogicalTopic;
  readonly group: string;
  readonly metrics: ConsumerMetrics;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}
