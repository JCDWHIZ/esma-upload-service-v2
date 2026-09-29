import { PermanentError } from '../core/errors/app-error.js';
import type { EventEnvelope } from './envelope.js';
import type { LogicalTopic } from './catalog.js';
import type {
  DeliveryMeta,
  HandlerOutcome,
  IMessageBroker,
  MessageHandler,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from './broker.interface.js';

export interface BrokerClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultClock: BrokerClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface QueueItem {
  readonly id: string;
  readonly event: EventEnvelope<unknown>;
  readonly partitionKey: string;
  readonly attempt: number;
  readonly availableAt: number;
  readonly headers?: Record<string, string>;
  readonly firstFailedAt?: string;
}

interface GroupSubscription {
  readonly id: string;
  readonly options: SubscribeOptions;
  readonly handler: MessageHandler<unknown>;
  activeCount: number;
}

interface GroupState {
  readonly topic: LogicalTopic;
  readonly groupName: string;
  readonly queue: QueueItem[];
  readonly activeKeys: Set<string>;
  readonly subscriptions: Map<string, GroupSubscription>;
  timerHandle?: unknown;
}

export interface DlqRecord {
  readonly event: EventEnvelope<unknown>;
  readonly headers: Record<string, string>;
  readonly reason: string;
}

export class MemoryBroker implements IMessageBroker {
  public readonly name = 'memory' as const;

  private isInitialized = false;
  private isDisconnecting = false;
  private isDisconnected = false;

  private readonly clock: BrokerClock;
  // Key: `${topic}:${consumerGroup}`
  private readonly groups = new Map<string, GroupState>();
  // Subscribed topics -> set of consumer group names
  private readonly topicGroups = new Map<LogicalTopic, Set<string>>();

  // In-flight execution promises for clean draining on disconnect
  private readonly inFlightExecutions = new Set<Promise<void>>();

  // Audit / inspection storage for tests
  private readonly publishedHistory: Array<{
    topic: LogicalTopic;
    partitionKey: string;
    event: EventEnvelope<unknown>;
    opts?: PublishOptions;
  }> = [];
  private readonly dlqHistory: DlqRecord[] = [];

  constructor(clock: BrokerClock = defaultClock) {
    this.clock = clock;
  }

  public async initialize(): Promise<void> {
    await Promise.resolve();
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_MEMORY_BROKER !== 'true'
    ) {
      throw new PermanentError(
        'MemoryBroker cannot be used when NODE_ENV=production unless ALLOW_MEMORY_BROKER=true',
      );
    }
    this.isInitialized = true;
    this.isDisconnecting = false;
    this.isDisconnected = false;
  }

  public async publish<T>(
    topic: LogicalTopic,
    partitionKey: string,
    event: EventEnvelope<T>,
    opts?: PublishOptions,
  ): Promise<void> {
    await Promise.resolve();
    if (!this.isInitialized || this.isDisconnecting || this.isDisconnected) {
      throw new PermanentError(
        `Cannot publish to MemoryBroker in state: ${this.getStateString()}`,
      );
    }

    this.publishedHistory.push({
      topic,
      partitionKey,
      event: event,
      opts,
    });

    const groupsForTopic = this.topicGroups.get(topic);
    if (!groupsForTopic || groupsForTopic.size === 0) {
      return;
    }

    const deliverAfter = Math.max(0, opts?.deliverAfterMs ?? 0);
    const availableAt = this.clock.now() + deliverAfter;

    for (const groupName of groupsForTopic) {
      const groupKey = this.getGroupKey(topic, groupName);
      const groupState = this.groups.get(groupKey);
      if (!groupState) continue;

      const item: QueueItem = {
        id: `${event.eventId}:${groupName}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        event: event,
        partitionKey,
        attempt: event.attempt ?? 0,
        availableAt,
        headers: opts?.headers,
      };

      groupState.queue.push(item);
      this.schedulePump(groupState);
    }
  }

  public async subscribe<T>(
    topic: LogicalTopic,
    opts: SubscribeOptions,
    handler: MessageHandler<T>,
  ): Promise<Subscription> {
    await Promise.resolve();
    if (!this.isInitialized || this.isDisconnecting || this.isDisconnected) {
      throw new PermanentError(
        `Cannot subscribe to MemoryBroker in state: ${this.getStateString()}`,
      );
    }

    const groupName = opts.consumerGroup;
    let groupsForTopic = this.topicGroups.get(topic);
    if (!groupsForTopic) {
      groupsForTopic = new Set<string>();
      this.topicGroups.set(topic, groupsForTopic);
    }
    groupsForTopic.add(groupName);

    const groupKey = this.getGroupKey(topic, groupName);
    let groupState = this.groups.get(groupKey);
    if (!groupState) {
      groupState = {
        topic,
        groupName,
        queue: [],
        activeKeys: new Set<string>(),
        subscriptions: new Map<string, GroupSubscription>(),
      };
      this.groups.set(groupKey, groupState);
    }

    const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const sub: GroupSubscription = {
      id: subId,
      options: opts,
      handler: handler as MessageHandler<unknown>,
      activeCount: 0,
    };
    groupState.subscriptions.set(subId, sub);

    // Trigger pump in case messages were already enqueued
    this.schedulePump(groupState);

    return {
      close: async () => {
        await Promise.resolve();
        const state = this.groups.get(groupKey);
        if (state) {
          state.subscriptions.delete(subId);
          if (state.subscriptions.size === 0) {
            groupsForTopic?.delete(groupName);
          }
        }
      },
    };
  }

  public async healthCheck(): Promise<boolean> {
    await Promise.resolve();
    return this.isInitialized && !this.isDisconnecting && !this.isDisconnected;
  }

  public async disconnect(): Promise<void> {
    this.isDisconnecting = true;

    // Clear all pending group timers
    for (const group of this.groups.values()) {
      if (group.timerHandle !== undefined) {
        this.clock.clearTimeout(group.timerHandle);
        group.timerHandle = undefined;
      }
    }

    // Wait for all in-flight handler executions to settle
    while (this.inFlightExecutions.size > 0) {
      await Promise.all(Array.from(this.inFlightExecutions));
    }

    this.isDisconnected = true;
    this.isInitialized = false;
  }

  // --- Inspection and testing helpers ---

  public getPublished(topic?: LogicalTopic): readonly EventEnvelope<unknown>[] {
    if (!topic) return this.publishedHistory.map((p) => p.event);
    return this.publishedHistory
      .filter((p) => p.topic === topic)
      .map((p) => p.event);
  }

  public getDlqRecords(): readonly DlqRecord[] {
    return this.dlqHistory;
  }

  public clearHistory(): void {
    this.publishedHistory.length = 0;
    this.dlqHistory.length = 0;
  }

  // --- Internal Scheduling & Pumping ---

  private getGroupKey(topic: LogicalTopic, groupName: string): string {
    return `${topic}:${groupName}`;
  }

  private getStateString(): string {
    if (this.isDisconnected) return 'DISCONNECTED';
    if (this.isDisconnecting) return 'DISCONNECTING';
    if (this.isInitialized) return 'INITIALIZED';
    return 'UNINITIALIZED';
  }

  private schedulePump(group: GroupState): void {
    if (this.isDisconnecting || this.isDisconnected) return;
    this.pump(group);
  }

  private pump(group: GroupState): void {
    if (this.isDisconnecting || this.isDisconnected) return;

    if (group.timerHandle !== undefined) {
      this.clock.clearTimeout(group.timerHandle);
      group.timerHandle = undefined;
    }

    const now = this.clock.now();
    let nextDueTime: number | undefined;

    // Look for schedulable items
    let i = 0;
    while (i < group.queue.length) {
      const item = group.queue[i];

      if (item.availableAt > now) {
        if (nextDueTime === undefined || item.availableAt < nextDueTime) {
          nextDueTime = item.availableAt;
        }
        i++;
        continue;
      }

      // Check per-partition-key serial delivery:
      // If a message with this partitionKey is currently being executed in this group, skip it!
      if (group.activeKeys.has(item.partitionKey)) {
        i++;
        continue;
      }

      // Find an available subscription in this group that has remaining capacity
      const subscriber = this.findAvailableSubscriber(group);
      if (!subscriber) {
        // Group is at full concurrency capacity
        break;
      }

      // Claim item
      group.queue.splice(i, 1);
      group.activeKeys.add(item.partitionKey);
      subscriber.activeCount++;

      // Dispatch execution
      this.dispatchExecution(group, subscriber, item);
      // Don't increment i because splice removed current index
    }

    // If there are future scheduled items, set a timer for the earliest one
    if (
      nextDueTime !== undefined &&
      !this.isDisconnecting &&
      !this.isDisconnected
    ) {
      const delay = Math.max(0, nextDueTime - this.clock.now());
      group.timerHandle = this.clock.setTimeout(() => {
        group.timerHandle = undefined;
        this.pump(group);
      }, delay);
    }
  }

  private findAvailableSubscriber(
    group: GroupState,
  ): GroupSubscription | undefined {
    for (const sub of group.subscriptions.values()) {
      if (sub.activeCount < sub.options.concurrency) {
        return sub;
      }
    }
    return undefined;
  }

  private dispatchExecution(
    group: GroupState,
    sub: GroupSubscription,
    item: QueueItem,
  ): void {
    const meta: DeliveryMeta = {
      topic: group.topic,
      partitionKey: item.partitionKey,
      attempt: item.attempt,
      headers: item.headers,
      timestamp: new Date(this.clock.now()).toISOString(),
    };

    const deliveryEnvelope: EventEnvelope<unknown> = {
      ...item.event,
      attempt: item.attempt,
    };

    const executionPromise = (async () => {
      let outcome: HandlerOutcome;
      try {
        outcome = await sub.handler(deliveryEnvelope, meta);
      } catch (err: unknown) {
        if (err instanceof PermanentError) {
          outcome = { kind: 'dead-letter', reason: err.message };
        } else {
          let reason: string;
          if (err instanceof Error) {
            reason = err.message;
          } else if (typeof err === 'string') {
            reason = err;
          } else {
            reason = 'Unknown handler error';
          }
          outcome = { kind: 'retry', reason };
        }
      }

      await this.handleOutcome(group, sub, item, outcome);
    })().finally(() => {
      sub.activeCount = Math.max(0, sub.activeCount - 1);
      group.activeKeys.delete(item.partitionKey);
      this.inFlightExecutions.delete(executionPromise);
      // Pump again to schedule next waiting item (especially for same partitionKey)
      this.schedulePump(group);
    });

    this.inFlightExecutions.add(executionPromise);
  }

  private async handleOutcome(
    group: GroupState,
    sub: GroupSubscription,
    item: QueueItem,
    outcome: HandlerOutcome,
  ): Promise<void> {
    if (outcome.kind === 'ack') {
      return;
    }

    if (outcome.kind === 'dead-letter') {
      await this.routeToDlq(group.topic, item, outcome.reason);
      return;
    }

    if (outcome.kind === 'retry') {
      const nextAttempt = item.attempt + 1;
      if (nextAttempt >= sub.options.maxAttempts) {
        await this.routeToDlq(
          group.topic,
          item,
          `Exceeded max attempts (${sub.options.maxAttempts}): ${outcome.reason}`,
        );
        return;
      }

      const delayMs = Math.max(0, outcome.delayMs ?? 1000);
      const retryItem: QueueItem = {
        ...item,
        attempt: nextAttempt,
        availableAt: this.clock.now() + delayMs,
        firstFailedAt:
          item.firstFailedAt ?? new Date(this.clock.now()).toISOString(),
      };

      group.queue.push(retryItem);
    }
  }

  private async routeToDlq(
    originalTopic: LogicalTopic,
    item: QueueItem,
    reason: string,
  ): Promise<void> {
    const dlqHeaders: Record<string, string> = {
      ...(item.headers ?? {}),
      'x-original-topic': originalTopic,
      'x-event-type': item.event.eventType,
      'x-error': reason,
      'x-attempts': String(item.attempt + 1),
      'x-first-failed-at':
        item.firstFailedAt ?? new Date(this.clock.now()).toISOString(),
    };

    const dlqRecord: DlqRecord = {
      event: {
        ...item.event,
        attempt: item.attempt + 1,
      },
      headers: dlqHeaders,
      reason,
    };
    this.dlqHistory.push(dlqRecord);

    // If there are subscribers to 'dlq', publish through normal channels
    const dlqGroups = this.topicGroups.get('dlq');
    if (
      dlqGroups &&
      dlqGroups.size > 0 &&
      !this.isDisconnecting &&
      !this.isDisconnected
    ) {
      await this.publish('dlq', item.partitionKey, dlqRecord.event, {
        headers: dlqHeaders,
      });
    }
  }
}
