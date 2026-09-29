import { Module } from '@nestjs/common';
import { EventsService } from './events.service.js';
import { MemoryBroker } from './memory-broker.js';
import { MESSAGE_BROKER } from './broker.interface.js';
import { TopicMap, defaultTopicMap } from './topic-map.js';

@Module({
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
  ],
  exports: [EventsService, MemoryBroker, MESSAGE_BROKER, TopicMap],
})
export class EventsModule {}
