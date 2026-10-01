/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-base-to-string */
import { describe, vi } from 'vitest';
import {
  PulsarBrokerDriver,
  type PulsarBrokerConfig,
  type PulsarClientLike,
  type PulsarConsumerLike,
  type PulsarProducerLike,
  type PulsarMessageLike,
  type PulsarConsumerConfigLike,
  type PulsarProducerConfigLike,
} from '../../src/events/pulsar-broker.driver.js';
import { TopicMap } from '../../src/events/topic-map.js';
import { runBrokerContract } from './broker.contract.js';

interface SimulatedPulsarMessage {
  id: string;
  data: Buffer;
  partitionKey: string;
  properties: Record<string, string>;
  topic: string;
  redeliveryCount: number;
}

interface SimulatedConsumerSlot {
  consumer: PulsarConsumerLike;
  topic: string;
  subscription: string;
  subscriptionType: string;
  isClosed: boolean;
  queue: SimulatedPulsarMessage[];
  pendingReceiveResolvers: Array<{
    resolve: (msg: PulsarMessageLike) => void;
    reject: (err: Error) => void;
    timer: any;
  }>;
}

/**
 * Creates a deterministic, in-memory Apache Pulsar client simulator for contract testing.
 * Implements:
 * - Persistent topic routing
 * - Key_Shared subscription hashing per partitionKey
 * - Competing consumer load balancing per subscription group
 * - Message FIFO queues per consumer
 * - reconsumeLater with scheduled delay and incremented redelivery count
 * - Dead letter topic routing
 */
function createInMemoryPulsarClient(): { client: PulsarClientLike } {
  // topic -> subscription -> consumerSlots
  const subscriptions = new Map<string, Map<string, SimulatedConsumerSlot[]>>();
  let msgSeq = 1;

  const hashKey = (key: string, modulus: number): number => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return hash % modulus;
  };

  const deliverToSubscription = (
    topic: string,
    subName: string,
    slots: SimulatedConsumerSlot[],
    msg: SimulatedPulsarMessage,
  ): void => {
    const activeSlots = slots.filter((s) => !s.isClosed);
    if (activeSlots.length === 0) return;

    // Key_Shared: consistent hash partitionKey to active slot
    const slotIdx = hashKey(msg.partitionKey || 'default', activeSlots.length);
    const targetSlot = activeSlots[slotIdx];

    const messageWrapper: PulsarMessageLike = {
      getData: () => msg.data,
      getMessageId: () => msg.id,
      getPartitionKey: () => msg.partitionKey,
      getProperties: () => msg.properties,
      getTopicName: () => msg.topic,
      getRedeliveryCount: () => msg.redeliveryCount,
      getEventTimestamp: () => Date.now(),
    };

    if (targetSlot.pendingReceiveResolvers.length > 0) {
      const resolver = targetSlot.pendingReceiveResolvers.shift()!;
      clearTimeout(resolver.timer);
      resolver.resolve(messageWrapper);
    } else {
      targetSlot.queue.push(msg);
    }
  };

  const dispatchToTopic = (
    topic: string,
    msg: SimulatedPulsarMessage,
  ): void => {
    const topicSubs = subscriptions.get(topic);
    if (!topicSubs) return;

    for (const [subName, slots] of topicSubs.entries()) {
      deliverToSubscription(topic, subName, slots, msg);
    }
  };

  const mockProducerMap = new Map<string, PulsarProducerLike>();

  const client: PulsarClientLike = {
    createProducer: vi
      .fn()
      .mockImplementation(async (config: PulsarProducerConfigLike) => {
        let producer = mockProducerMap.get(config.topic);
        if (!producer) {
          producer = {
            send: vi.fn().mockImplementation(async (msgToSend: any) => {
              const simMsg: SimulatedPulsarMessage = {
                id: `pulsar-msg-${msgSeq++}`,
                data: msgToSend.data,
                partitionKey: msgToSend.partitionKey || 'default',
                properties: msgToSend.properties || {},
                topic: config.topic,
                redeliveryCount: 0,
              };
              dispatchToTopic(config.topic, simMsg);
            }),
            flush: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
          };
          mockProducerMap.set(config.topic, producer);
        }
        return producer;
      }),

    subscribe: vi
      .fn()
      .mockImplementation(async (config: PulsarConsumerConfigLike) => {
        if (!subscriptions.has(config.topic)) {
          subscriptions.set(config.topic, new Map());
        }
        const topicSubs = subscriptions.get(config.topic)!;
        if (!topicSubs.has(config.subscription)) {
          topicSubs.set(config.subscription, []);
        }

        const slot: SimulatedConsumerSlot = {
          consumer: null as any,
          topic: config.topic,
          subscription: config.subscription,
          subscriptionType: config.subscriptionType || 'Key_Shared',
          isClosed: false,
          queue: [],
          pendingReceiveResolvers: [],
        };

        const consumer: PulsarConsumerLike = {
          receive: vi.fn().mockImplementation(async (timeoutMs = 200) => {
            if (slot.isClosed) {
              throw new Error('Consumer is closed');
            }

            if (slot.queue.length > 0) {
              const msg = slot.queue.shift()!;
              const wrapper: PulsarMessageLike = {
                getData: () => msg.data,
                getMessageId: () => msg.id,
                getPartitionKey: () => msg.partitionKey,
                getProperties: () => msg.properties,
                getTopicName: () => msg.topic,
                getRedeliveryCount: () => msg.redeliveryCount,
                getEventTimestamp: () => Date.now(),
              };
              return wrapper;
            }

            return new Promise<PulsarMessageLike>((resolve, reject) => {
              const timer = setTimeout(() => {
                const idx = slot.pendingReceiveResolvers.findIndex(
                  (r) => r.resolve === resolve,
                );
                if (idx !== -1) slot.pendingReceiveResolvers.splice(idx, 1);
                reject(new Error('Receive timeout'));
              }, timeoutMs);

              slot.pendingReceiveResolvers.push({ resolve, reject, timer });
            });
          }),

          acknowledge: vi.fn().mockResolvedValue(undefined),
          negativeAcknowledge: vi
            .fn()
            .mockImplementation((msg: PulsarMessageLike) => {
              const simMsg: SimulatedPulsarMessage = {
                id: String(msg.getMessageId()),
                data: msg.getData(),
                partitionKey: msg.getPartitionKey(),
                properties: msg.getProperties(),
                topic: msg.getTopicName(),
                redeliveryCount: msg.getRedeliveryCount() + 1,
              };
              const slots = topicSubs.get(config.subscription) || [];
              deliverToSubscription(
                config.topic,
                config.subscription,
                slots,
                simMsg,
              );
            }),

          reconsumeLater: vi
            .fn()
            .mockImplementation(
              async (msg: PulsarMessageLike, delayMs: number) => {
                const simMsg: SimulatedPulsarMessage = {
                  id: String(msg.getMessageId()),
                  data: msg.getData(),
                  partitionKey: msg.getPartitionKey(),
                  properties: msg.getProperties(),
                  topic: msg.getTopicName(),
                  redeliveryCount: msg.getRedeliveryCount() + 1,
                };

                setTimeout(() => {
                  if (!slot.isClosed) {
                    const slots = topicSubs.get(config.subscription) || [];
                    deliverToSubscription(
                      config.topic,
                      config.subscription,
                      slots,
                      simMsg,
                    );
                  }
                }, delayMs);
              },
            ),

          close: vi.fn().mockImplementation(async () => {
            slot.isClosed = true;
            for (const resolver of slot.pendingReceiveResolvers) {
              clearTimeout(resolver.timer);
              resolver.reject(new Error('Consumer closed'));
            }
            slot.pendingReceiveResolvers = [];
          }),
        };

        slot.consumer = consumer;
        topicSubs.get(config.subscription)!.push(slot);
        return consumer;
      }),

    close: vi.fn().mockImplementation(async () => {
      for (const topicSubs of subscriptions.values()) {
        for (const slots of topicSubs.values()) {
          for (const slot of slots) {
            await slot.consumer.close();
          }
        }
      }
      subscriptions.clear();
      mockProducerMap.clear();
    }),
  };

  return { client };
}

describe('PulsarBrokerDriver Contract Verification [P5-04, P5-05]', () => {
  const topicMap = new TopicMap({
    pulsarTenant: 'contract',
    pulsarNamespace: 'default',
  });

  runBrokerContract(
    'PulsarBrokerDriver',
    async () => {
      const { client } = createInMemoryPulsarClient();
      const config: PulsarBrokerConfig = {
        serviceUrl: 'pulsar://localhost:6650',
        tenant: 'contract',
        namespace: 'default',
        topicMap,
        pulsarInstance: client,
      };

      const driver = new PulsarBrokerDriver(config);
      await driver.initialize();
      return driver;
    },
    {
      orderingMessageCount: 40,
      orderingKeyCount: 4,
      retryDelayMs: 20,
    },
  );
});
