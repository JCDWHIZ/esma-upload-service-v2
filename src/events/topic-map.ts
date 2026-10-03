import type { LogicalTopic } from './catalog.js';

export interface TopicMapOptions {
  readonly kafkaPrefix?: string;
  readonly pulsarTenant?: string;
  readonly pulsarNamespace?: string;
}

export type KafkaRetryTier = '10s' | '1m' | '10m';

export class TopicMap {
  public static readonly ALL_LOGICAL_TOPICS: readonly LogicalTopic[] = [
    'replication',
    'processing',
    'audit',
    'dlq',
  ];

  private readonly kafkaPrefix: string;
  private readonly pulsarTenant: string;
  private readonly pulsarNamespace: string;

  constructor(options: TopicMapOptions = {}) {
    this.kafkaPrefix = options.kafkaPrefix ?? 'esma.files';
    this.pulsarTenant = options.pulsarTenant ?? 'esma';
    this.pulsarNamespace = options.pulsarNamespace ?? 'uploads';
  }

  public toKafka(topic: LogicalTopic): string {
    return `${this.kafkaPrefix}.${topic}`;
  }

  public toKafkaRetry(topic: LogicalTopic, tier: KafkaRetryTier): string {
    return `${this.kafkaPrefix}.${topic}.retry.${tier}`;
  }

  public toPulsar(
    topic: LogicalTopic,
    override?: { tenant?: string; namespace?: string },
  ): string {
    const tenant = override?.tenant ?? this.pulsarTenant;
    const namespace = override?.namespace ?? this.pulsarNamespace;
    return `persistent://${tenant}/${namespace}/${topic}`;
  }

  public fromKafka(physical: string): LogicalTopic | undefined {
    const prefix = `${this.kafkaPrefix}.`;
    if (!physical.startsWith(prefix)) return undefined;
    const stripped = physical.slice(prefix.length).split('.')[0];
    if (this.isLogicalTopic(stripped)) return stripped;
    return undefined;
  }

  public fromPulsar(physical: string): LogicalTopic | undefined {
    const prefix = `persistent://${this.pulsarTenant}/${this.pulsarNamespace}/`;
    if (!physical.startsWith(prefix)) return undefined;
    const stripped = physical.slice(prefix.length);
    if (this.isLogicalTopic(stripped)) return stripped;
    return undefined;
  }

  public isLogicalTopic(name: string): name is LogicalTopic {
    return (TopicMap.ALL_LOGICAL_TOPICS as readonly string[]).includes(name);
  }
}

export const defaultTopicMap = new TopicMap();
