import { Injectable } from '@nestjs/common';

@Injectable()
export class DatabaseService {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
