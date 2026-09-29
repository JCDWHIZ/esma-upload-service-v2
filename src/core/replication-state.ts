import type { ReplicaRole, ReplicaStatus, ReplicationStatus } from './types.js';

export const DEFAULT_REPLICATION_LEASE_SECONDS = 600;

/**
 * Valid state transitions for a replica according to ARCH §5.2 state machine.
 */
const ALLOWED_REPLICA_TRANSITIONS: Readonly<
  Record<ReplicaStatus, readonly ReplicaStatus[]>
> = {
  QUEUED: ['IN_PROGRESS', 'DELETING', 'DELETED'],
  IN_PROGRESS: ['AVAILABLE', 'QUEUED', 'FAILED', 'DELETING'],
  AVAILABLE: ['DELETING'],
  FAILED: ['QUEUED', 'DELETING', 'DELETED'],
  DELETING: ['DELETED'],
  DELETED: [],
};

/**
 * Validates whether a replica can legally transition from one status to another.
 * Pure function matching the ARCH §5.2 state diagram.
 */
export function canTransition(from: ReplicaStatus, to: ReplicaStatus): boolean {
  if (from === to) {
    return false;
  }
  const allowed = ALLOWED_REPLICA_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface ReplicaStatusInput {
  status: ReplicaStatus;
  role?: ReplicaRole;
}

/**
 * Derives the aggregate `replication_status` from secondary replicas only.
 * Conforms strictly to ARCH §5.2:
 *
 * | Secondary replicas                                       | Aggregate      |
 * | :------------------------------------------------------- | :------------- |
 * | none                                                     | `NOT_REQUIRED` |
 * | all `AVAILABLE`                                          | `SYNCED`       |
 * | all `QUEUED`                                             | `QUEUED`       |
 * | all `FAILED`                                             | `FAILED`       |
 * | no `QUEUED`/`IN_PROGRESS`, mix of `AVAILABLE` and `FAILED`| `PARTIAL`      |
 * | anything else                                            | `IN_PROGRESS`  |
 *
 * Primary replicas and DELETED/DELETING replicas are excluded from aggregate calculation.
 */
export function deriveReplicationStatus(
  replicas: ReadonlyArray<ReplicaStatus | ReplicaStatusInput>,
): ReplicationStatus {
  // Normalize and filter to active secondary replicas
  const secondaries: ReplicaStatus[] = [];

  for (const item of replicas) {
    if (typeof item === 'string') {
      if (item !== 'DELETED' && item !== 'DELETING') {
        secondaries.push(item);
      }
    } else {
      const isPrimary = item.role === 'primary';
      const isDeleted = item.status === 'DELETED' || item.status === 'DELETING';
      if (!isPrimary && !isDeleted) {
        secondaries.push(item.status);
      }
    }
  }

  // 1. None
  if (secondaries.length === 0) {
    return 'NOT_REQUIRED';
  }

  // 2. All AVAILABLE
  if (secondaries.every((s) => s === 'AVAILABLE')) {
    return 'SYNCED';
  }

  // 3. All QUEUED
  if (secondaries.every((s) => s === 'QUEUED')) {
    return 'QUEUED';
  }

  // 4. All FAILED
  if (secondaries.every((s) => s === 'FAILED')) {
    return 'FAILED';
  }

  // 5. No QUEUED / IN_PROGRESS, mix of AVAILABLE and FAILED
  const hasQueuedOrInProgress = secondaries.some(
    (s) => s === 'QUEUED' || s === 'IN_PROGRESS',
  );
  if (!hasQueuedOrInProgress) {
    return 'PARTIAL';
  }

  // 6. Anything else
  return 'IN_PROGRESS';
}

/**
 * Checks whether an IN_PROGRESS replica lease has expired and can be reclaimed.
 */
export function isReplicaLeaseStale(
  updatedAt: Date,
  leaseSeconds = DEFAULT_REPLICATION_LEASE_SECONDS,
  now = new Date(),
): boolean {
  const elapsedMs = now.getTime() - updatedAt.getTime();
  return elapsedMs > leaseSeconds * 1000;
}
