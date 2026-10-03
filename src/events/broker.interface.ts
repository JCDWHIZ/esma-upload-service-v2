import type { EventEnvelope } from './envelope.js';
import type { LogicalTopic } from './catalog.js';

export const MESSAGE_BROKER = Symbol('MESSAGE_BROKER');

export interface PublishOptions {
  readonly headers?: Record<string, string>;
  readonly deliverAfterMs?: number;
}

export type HandlerOutcome =
  | { readonly kind: 'ack' }
  | {
      readonly kind: 'retry';
      readonly delayMs?: number;
      readonly reason: string;
    }
  | { readonly kind: 'dead-letter'; readonly reason: string };

export interface SubscribeOptions {
  readonly consumerGroup: string;
  readonly concurrency: number;
  readonly maxAttempts: number;
}

export interface DeliveryMeta {
  readonly topic: LogicalTopic;
  readonly partitionKey: string;
  readonly attempt: number;
  readonly headers?: Record<string, string>;
  readonly timestamp: string;
}

export interface Subscription {
  close(): Promise<void>;
}

export type MessageHandler<T = unknown> = (
  event: EventEnvelope<T>,
  meta: DeliveryMeta,
) => Promise<HandlerOutcome>;

export interface IMessageBroker {
  readonly name: 'memory' | 'kafka' | 'pulsar';
  initialize(): Promise<void>;
  publish<T>(
    topic: LogicalTopic,
    partitionKey: string,
    event: EventEnvelope<T>,
    opts?: PublishOptions,
  ): Promise<void>;
  subscribe<T>(
    topic: LogicalTopic,
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription>;
  healthCheck(): Promise<boolean>;
  disconnect(): Promise<void>; // drains in-flight handlers first
}
