import { Injectable } from '@nestjs/common';

@Injectable()
export class EventsService {
  publish(topic: string, event: unknown): Promise<void> {
    void topic;
    void event;
    return Promise.resolve();
  }
}
