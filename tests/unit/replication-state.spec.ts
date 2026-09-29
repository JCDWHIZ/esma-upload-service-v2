import { describe, expect, it } from 'vitest';
import {
  canTransition,
  deriveReplicationStatus,
  isReplicaLeaseStale,
} from '../../src/core/replication-state.js';
import type { ReplicaStatus, ReplicationStatus } from '../../src/core/types.js';

describe('Replication State Machine & Aggregate Derivation Tests (P4-02)', () => {
  describe('canTransition State Machine Rules (ARCH §5.2)', () => {
    const allStatuses: ReplicaStatus[] = [
      'QUEUED',
      'IN_PROGRESS',
      'AVAILABLE',
      'FAILED',
      'DELETING',
      'DELETED',
    ];

    it('allows legal transitions matching ARCH §5.2', () => {
      // QUEUED
      expect(canTransition('QUEUED', 'IN_PROGRESS')).toBe(true);
      expect(canTransition('QUEUED', 'DELETED')).toBe(true);
      expect(canTransition('QUEUED', 'DELETING')).toBe(true);

      // IN_PROGRESS
      expect(canTransition('IN_PROGRESS', 'AVAILABLE')).toBe(true);
      expect(canTransition('IN_PROGRESS', 'QUEUED')).toBe(true);
      expect(canTransition('IN_PROGRESS', 'FAILED')).toBe(true);
      expect(canTransition('IN_PROGRESS', 'DELETING')).toBe(true);

      // AVAILABLE
      expect(canTransition('AVAILABLE', 'DELETING')).toBe(true);

      // FAILED
      expect(canTransition('FAILED', 'QUEUED')).toBe(true);
      expect(canTransition('FAILED', 'DELETING')).toBe(true);
      expect(canTransition('FAILED', 'DELETED')).toBe(true);

      // DELETING
      expect(canTransition('DELETING', 'DELETED')).toBe(true);
    });

    it('rejects illegal transitions', () => {
      // AVAILABLE cannot move directly to QUEUED, IN_PROGRESS, or FAILED
      expect(canTransition('AVAILABLE', 'QUEUED')).toBe(false);
      expect(canTransition('AVAILABLE', 'IN_PROGRESS')).toBe(false);
      expect(canTransition('AVAILABLE', 'FAILED')).toBe(false);
      expect(canTransition('AVAILABLE', 'DELETED')).toBe(false);

      // DELETED is a terminal state
      for (const target of allStatuses) {
        expect(canTransition('DELETED', target)).toBe(false);
      }

      // Self-transitions are rejected
      for (const status of allStatuses) {
        expect(canTransition(status, status)).toBe(false);
      }
    });
  });

  describe('deriveReplicationStatus Truth-Table (ARCH §5.2)', () => {
    it('returns NOT_REQUIRED when there are no secondary replicas', () => {
      expect(deriveReplicationStatus([])).toBe('NOT_REQUIRED');
    });

    it('excludes primary replicas from aggregate calculation', () => {
      expect(
        deriveReplicationStatus([{ role: 'primary', status: 'AVAILABLE' }]),
      ).toBe('NOT_REQUIRED');

      expect(
        deriveReplicationStatus([
          { role: 'primary', status: 'AVAILABLE' },
          { role: 'secondary', status: 'AVAILABLE' },
        ]),
      ).toBe('SYNCED');
    });

    it('excludes DELETED and DELETING replicas from aggregate calculation', () => {
      expect(
        deriveReplicationStatus([
          { role: 'secondary', status: 'AVAILABLE' },
          { role: 'secondary', status: 'DELETED' },
        ]),
      ).toBe('SYNCED');

      expect(
        deriveReplicationStatus([
          { role: 'secondary', status: 'DELETED' },
          { role: 'secondary', status: 'DELETING' },
        ]),
      ).toBe('NOT_REQUIRED');
    });

    it('returns SYNCED when all active secondaries are AVAILABLE', () => {
      expect(deriveReplicationStatus(['AVAILABLE'])).toBe('SYNCED');
      expect(deriveReplicationStatus(['AVAILABLE', 'AVAILABLE'])).toBe(
        'SYNCED',
      );
      expect(
        deriveReplicationStatus(['AVAILABLE', 'AVAILABLE', 'AVAILABLE']),
      ).toBe('SYNCED');
    });

    it('returns QUEUED when all active secondaries are QUEUED', () => {
      expect(deriveReplicationStatus(['QUEUED'])).toBe('QUEUED');
      expect(deriveReplicationStatus(['QUEUED', 'QUEUED'])).toBe('QUEUED');
    });

    it('returns FAILED when all active secondaries are FAILED', () => {
      expect(deriveReplicationStatus(['FAILED'])).toBe('FAILED');
      expect(deriveReplicationStatus(['FAILED', 'FAILED'])).toBe('FAILED');
    });

    it('returns PARTIAL when there are no QUEUED or IN_PROGRESS and a mix of AVAILABLE and FAILED', () => {
      expect(deriveReplicationStatus(['AVAILABLE', 'FAILED'])).toBe('PARTIAL');
      expect(deriveReplicationStatus(['FAILED', 'AVAILABLE'])).toBe('PARTIAL');
      expect(
        deriveReplicationStatus(['AVAILABLE', 'AVAILABLE', 'FAILED']),
      ).toBe('PARTIAL');
      expect(deriveReplicationStatus(['FAILED', 'FAILED', 'AVAILABLE'])).toBe(
        'PARTIAL',
      );
    });

    it('returns IN_PROGRESS for any combination containing IN_PROGRESS or mixed QUEUED states', () => {
      // Contains IN_PROGRESS
      expect(deriveReplicationStatus(['IN_PROGRESS'])).toBe('IN_PROGRESS');
      expect(deriveReplicationStatus(['IN_PROGRESS', 'AVAILABLE'])).toBe(
        'IN_PROGRESS',
      );
      expect(deriveReplicationStatus(['IN_PROGRESS', 'QUEUED'])).toBe(
        'IN_PROGRESS',
      );
      expect(deriveReplicationStatus(['IN_PROGRESS', 'FAILED'])).toBe(
        'IN_PROGRESS',
      );

      // Mix of QUEUED and AVAILABLE
      expect(deriveReplicationStatus(['QUEUED', 'AVAILABLE'])).toBe(
        'IN_PROGRESS',
      );

      // Mix of QUEUED and FAILED
      expect(deriveReplicationStatus(['QUEUED', 'FAILED'])).toBe('IN_PROGRESS');

      // Mix of QUEUED, AVAILABLE, and FAILED
      expect(deriveReplicationStatus(['QUEUED', 'AVAILABLE', 'FAILED'])).toBe(
        'IN_PROGRESS',
      );
    });

    it('Exhaustive truth-table test for all combinations of up to 4 secondaries', () => {
      const activeStatuses: ReplicaStatus[] = [
        'QUEUED',
        'IN_PROGRESS',
        'AVAILABLE',
        'FAILED',
      ];

      function generateCombinations(depth: number): ReplicaStatus[][] {
        if (depth === 1) {
          return activeStatuses.map((s) => [s]);
        }
        const smaller = generateCombinations(depth - 1);
        const result: ReplicaStatus[][] = [];
        for (const list of smaller) {
          for (const s of activeStatuses) {
            result.push([...list, s]);
          }
        }
        return result;
      }

      // Generate all 1, 2, 3, and 4 replica combinations (4 + 16 + 64 + 256 = 340 combinations)
      const allCombinations = [
        ...generateCombinations(1),
        ...generateCombinations(2),
        ...generateCombinations(3),
        ...generateCombinations(4),
      ];

      expect(allCombinations.length).toBe(340);

      for (const combo of allCombinations) {
        const derived = deriveReplicationStatus(combo);

        // Verification against formal rule specifications:
        const allAvailable = combo.every((s) => s === 'AVAILABLE');
        const allQueued = combo.every((s) => s === 'QUEUED');
        const allFailed = combo.every((s) => s === 'FAILED');
        const hasQueuedOrInProgress = combo.some(
          (s) => s === 'QUEUED' || s === 'IN_PROGRESS',
        );

        let expected: ReplicationStatus;
        if (allAvailable) {
          expected = 'SYNCED';
        } else if (allQueued) {
          expected = 'QUEUED';
        } else if (allFailed) {
          expected = 'FAILED';
        } else if (!hasQueuedOrInProgress) {
          expected = 'PARTIAL';
        } else {
          expected = 'IN_PROGRESS';
        }

        expect(derived).toBe(expected);
      }
    });
  });

  describe('isReplicaLeaseStale Helper', () => {
    it('correctly identifies stale vs active replica leases', () => {
      const now = new Date('2026-09-29T12:00:00.000Z');

      // Lease active: 300 seconds ago (lease is 600s)
      const activeDate = new Date('2026-09-29T11:55:00.000Z');
      expect(isReplicaLeaseStale(activeDate, 600, now)).toBe(false);

      // Lease expired: 601 seconds ago
      const staleDate = new Date('2026-09-29T11:49:59.000Z');
      expect(isReplicaLeaseStale(staleDate, 600, now)).toBe(true);

      // Exactly at lease boundary: not stale
      const boundaryDate = new Date('2026-09-29T11:50:00.000Z');
      expect(isReplicaLeaseStale(boundaryDate, 600, now)).toBe(false);
    });
  });
});
