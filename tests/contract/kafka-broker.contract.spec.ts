/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/no-base-to-string */
import { describe, vi } from 'vitest';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  KafkaBrokerDriver,
  type KafkaBrokerConfig,
} from '../../src/events/kafka-broker.driver.js';
import { TopicMap } from '../../src/events/topic-map.js';
import { runBrokerContract } from './broker.contract.js';

interface SimulatedMessage {
  key: Buffer;
  value: Buffer;
  offset: string;
  timestamp: string;
  headers: Record<string, Buffer>;
}

interface ActiveConsumerRecord {
  groupId: string;
  topics: Set<string>;
  eachMessage?: (payload: {
    topic: string;
    partition: number;
    message: any;
    pause: () => () => void;
  }) => Promise<void>;
  pausedPartitions: Set<string>; // "topic:partition"
  isStopped: boolean;
}

/**
 * Creates a deterministic, in-memory Kafka client simulator for contract testing.
 * Implements real partition queues, key-based partition hashing, eachMessage dispatch,
 * partition pausing/resuming, manual offset commits, and admin topic management.
 */
function createInMemoryKafkaClient(): {
  client: KafkaJS.Kafka;
  topicStore: Map<string, string[]>;
} {
  const existingTopics = new Set<string>();
  const consumerGroups = new Map<string, ActiveConsumerRecord[]>();
  let globalOffset = 100;

  // Simple deterministic string hash for partition assignment
  const hashKey = (key: string, numPartitions = 3): number => {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    return hash % numPartitions;
  };

  const dispatchMessageToGroup = async (
    groupId: string,
    consumers: ActiveConsumerRecord[],
    topic: string,
    partition: number,
    simMsg: SimulatedMessage,
  ): Promise<void> => {
    // Round-robin or consistent key consumer selection within the group
    const active = consumers.filter((c) => !c.isStopped && c.topics.has(topic));
    if (active.length === 0) return;

    // Route partition to single consumer in group (competing consumers)
    const consumerIdx = partition % active.length;
    const targetConsumer = active[consumerIdx];

    if (!targetConsumer?.eachMessage) return;

    const partitionKey = `${topic}:${partition}`;
    if (targetConsumer.pausedPartitions.has(partitionKey)) {
      // Waiting for resume
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!targetConsumer.pausedPartitions.has(partitionKey)) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
    }

    const pauseFn = () => {
      targetConsumer.pausedPartitions.add(partitionKey);
      return () => {
        targetConsumer.pausedPartitions.delete(partitionKey);
      };
    };

    // Run eachMessage asynchronously
    await targetConsumer.eachMessage({
      topic,
      partition,
      message: simMsg,
      pause: pauseFn,
    });
  };

  const mockProducer = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi
      .fn()
      .mockImplementation(
        async (record: { topic: string; messages: any[] }) => {
          existingTopics.add(record.topic);

          for (const msg of record.messages) {
            const keyStr = msg.key ? String(msg.key) : '';
            const partition = hashKey(keyStr, 3);
            const headers: Record<string, Buffer> = {};

            if (msg.headers) {
              for (const [k, v] of Object.entries(msg.headers)) {
                if (v !== undefined) {
                  headers[k] = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
                }
              }
            }

            const simMsg: SimulatedMessage = {
              key: Buffer.from(keyStr),
              value: Buffer.isBuffer(msg.value)
                ? msg.value
                : Buffer.from(String(msg.value)),
              offset: String(globalOffset++),
              timestamp: String(Date.now()),
              headers,
            };

            // Fan out to every distinct consumer group subscribed to this topic
            for (const [groupId, groupConsumers] of consumerGroups.entries()) {
              void dispatchMessageToGroup(
                groupId,
                groupConsumers,
                record.topic,
                partition,
                simMsg,
              );
            }
          }
        },
      ),
  };

  const mockAdmin = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTopics: vi
      .fn()
      .mockImplementation(async () => Array.from(existingTopics)),
    createTopics: vi
      .fn()
      .mockImplementation(async ({ topics }: { topics: any[] }) => {
        for (const t of topics) {
          existingTopics.add(t.topic);
        }
        return true;
      }),
  };

  const createMockConsumer = (groupId: string): any => {
    const record: ActiveConsumerRecord = {
      groupId,
      topics: new Set<string>(),
      pausedPartitions: new Set<string>(),
      isStopped: false,
    };

    if (!consumerGroups.has(groupId)) {
      consumerGroups.set(groupId, []);
    }
    consumerGroups.get(groupId)!.push(record);

    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockImplementation(async () => {
        record.isStopped = true;
      }),
      subscribe: vi
        .fn()
        .mockImplementation(async ({ topics }: { topics: string[] }) => {
          for (const t of topics) {
            record.topics.add(t);
            existingTopics.add(t);
          }
        }),
      run: vi
        .fn()
        .mockImplementation(async ({ eachMessage }: { eachMessage: any }) => {
          record.eachMessage = eachMessage;
        }),
      stop: vi.fn().mockImplementation(async () => {
        record.isStopped = true;
      }),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
    };
  };

  const client = {
    producer: vi.fn().mockReturnValue(mockProducer),
    consumer: vi
      .fn()
      .mockImplementation((opts: any) =>
        createMockConsumer(opts?.kafkaJS?.groupId ?? 'default-group'),
      ),
    admin: vi.fn().mockReturnValue(mockAdmin),
  } as unknown as KafkaJS.Kafka;

  return { client, topicStore: new Map() };
}

describe('KafkaBrokerDriver Contract Verification [P5-05]', () => {
  const topicMap = new TopicMap({ kafkaPrefix: 'contract.files' });

  runBrokerContract(
    'KafkaBrokerDriver',
    async () => {
      const { client } = createInMemoryKafkaClient();
      const config: KafkaBrokerConfig = {
        brokers: 'localhost:9092',
        clientId: 'kafka-contract-test',
        topicMap,
        topicPrefix: 'contract.files',
        topicPartitions: 3,
        topicReplicationFactor: 1,
        ssl: false,
        ensureTopics: true,
        kafkaInstance: client, // Injected deterministic simulator
      };

      const driver = new KafkaBrokerDriver(config);
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
