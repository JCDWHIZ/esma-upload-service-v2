import { v7 as uuidv7 } from 'uuid';

/**
 * Generate a new deterministic monotonic UUIDv7 identifier.
 */
export function newId(): string {
  return uuidv7();
}
