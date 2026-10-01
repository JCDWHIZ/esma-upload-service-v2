import { Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { MemoryBroker } from './memory-broker.js';
import { KafkaBrokerDriver } from './kafka-broker.driver.js';
import { PulsarBrokerDriver } from './pulsar-broker.driver.js';
import { MESSAGE_BROKER } from './broker.interface.js';
import { TopicMap, defaultTopicMap } from './topic-map.js';
import { OutboxWriter } from './outbox-writer.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxRetentionService } from './outbox-retention.service.js';
import { DatabaseModule } from '../db/database.module.js';
import { AppConfigService } from '../config/config.service.js';
import { ConfigModule } from '../config/config.module.js';
import type { IMessageBroker } from './broker.interface.js';

import { DeadLetterService } from './dead-letter.service.js';

@Module({
  imports: [DatabaseModule, ConfigModule],
  providers: [
    EventsService,
    DeadLetterService,
    {
      provide: MemoryBroker,
      useFactory: () => {
        const broker = new MemoryBroker();
        void broker.initialize();
        return broker;
      },
    },
    {
      provide: MESSAGE_BROKER,
      useFactory: (
        config: AppConfigService,
        memoryBroker: MemoryBroker,
        topicMap: TopicMap,
      ): IMessageBroker => {
        const brokerType = config.eventBroker;

        if (brokerType === 'kafka') {
          const kafkaDriver = new KafkaBrokerDriver({
            brokers: config.kafkaBrokers,
            clientId: config.kafkaClientId,
            topicMap,
            topicPrefix: config.kafkaTopicPrefix,
            topicPartitions: config.kafkaTopicPartitions,
            topicReplicationFactor: config.kafkaTopicReplicationFactor,
            ssl: config.kafkaSsl,
            saslMechanism: config.kafkaSaslMechanism,
            saslUsername: config.kafkaSaslUsername,
            saslPassword: config.kafkaSaslPassword,
            ensureTopics: !config.isProduction(),
          });
          // initialize() is called by the service on application bootstrap
          return kafkaDriver;
        }

        if (brokerType === 'pulsar') {
          const pulsarDriver = new PulsarBrokerDriver({
            serviceUrl: config.pulsarServiceUrl,
            authToken: config.pulsarAuthToken,
            tenant: config.pulsarTenant,
            namespace: config.pulsarNamespace,
            topicMap,
          });
          return pulsarDriver;
        }

        // Default: memory broker
        return memoryBroker;
      },
      inject: [AppConfigService, MemoryBroker, TopicMap],
    },
    {
      provide: TopicMap,
      useValue: defaultTopicMap,
    },
    OutboxWriter,
    OutboxRelay,
    OutboxRetentionService,
  ],
  exports: [
    EventsService,
    DeadLetterService,
    MemoryBroker,
    MESSAGE_BROKER,
    TopicMap,
    OutboxWriter,
    OutboxRelay,
    OutboxRetentionService,
  ],
})
export class EventsModule {}
