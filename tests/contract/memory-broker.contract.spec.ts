import { describe } from 'vitest';
import { MemoryBroker } from '../../src/events/memory-broker.js';
import { runBrokerContract } from './broker.contract.js';

describe('MemoryBroker Contract Verification [P5-05]', () => {
  runBrokerContract(
    'MemoryBroker',
    async () => {
      const broker = new MemoryBroker();
      await broker.initialize();
      return broker;
    },
    {
      orderingMessageCount: 50,
      orderingKeyCount: 5,
      retryDelayMs: 20,
    },
  );
});
