import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/config.service.js';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private isConnected = false;

  constructor(private readonly configService: AppConfigService) {}

  onModuleInit(): void {
    const url = this.configService.redisUrl;
    try {
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: (times) => {
          if (times > 5) {
            return null; // Stop retrying after 5 attempts
          }
          return Math.min(times * 200, 2000);
        },
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log(`Connected to Redis at ${url}`);
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.warn(`Redis connection error: ${String(err)}`);
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });

      // Connect asynchronously
      this.client.connect().catch((err) => {
        this.logger.warn(
          `Initial Redis connection deferred/failed: ${String(err)}`,
        );
      });
    } catch (err: unknown) {
      this.logger.warn(`Failed to initialize Redis client: ${String(err)}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect();
      }
      this.client = null;
      this.isConnected = false;
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  isReady(): boolean {
    return (
      this.isConnected && this.client !== null && this.client.status === 'ready'
    );
  }
}
