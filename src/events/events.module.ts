import { Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { MemoryBroker } from './memory-broker.js';
import { MESSAGE_BROKER } from './broker.interface.js';
import { TopicMap, defaultTopicMap } from './topic-map.js';
import { OutboxWriter } from './outbox-writer.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxRetentionService } from './outbox-retention.service.js';
import { DatabaseModule } from '../db/database.module.js';

@Module({
  imports: [DatabaseModule],
  providers: [
    EventsService,
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
      useExisting: MemoryBroker,
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
    MemoryBroker,
    MESSAGE_BROKER,
    TopicMap,
    OutboxWriter,
    OutboxRelay,
    OutboxRetentionService,
  ],
})
export class EventsModule {}
