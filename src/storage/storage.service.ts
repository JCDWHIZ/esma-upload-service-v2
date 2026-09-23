import { Injectable } from '@nestjs/common';

@Injectable()
export class StorageService {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
