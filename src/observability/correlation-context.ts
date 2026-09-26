import { AsyncLocalStorage } from 'node:async_hooks';

export interface CorrelationContext {
  correlationId: string;
  namespace?: string;
  tenantId?: string;
  fileId?: string;
  actorId?: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationContext(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function runWithCorrelationContext<T>(
  context: CorrelationContext,
  fn: () => T,
): T {
  return correlationStorage.run(context, fn);
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run({ correlationId }, fn);
}
