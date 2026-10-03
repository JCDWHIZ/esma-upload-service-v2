import { Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '../auth/context.js';
import type { UploadPolicy, Visibility } from '../config/policies.js';
import { StorageUnavailableError } from '../core/errors/app-error.js';
import { StorageRegistry } from './registry.js';
import type { ProviderName } from './types.js';

export interface StoragePlacementPlan {
  readonly primaryCandidates: ProviderName[];
  readonly secondaries: ProviderName[];
}

export interface FilePlacementMetadata {
  readonly size: number;
  readonly detectedMime?: string;
  readonly visibility: Visibility;
}

@Injectable()
export class StoragePlacementService {
  private readonly logger = new Logger(StoragePlacementService.name);

  constructor(private readonly registry: StorageRegistry) {}

  /**
   * Plans primary candidates and secondary replication targets for a file.
   * Conforms to ARCH §6.3, §7.1 and BACKEND_TASKS P4-01.
   *
   * Rules:
   * 1. Primary candidates: primary, then failovers, filtered by health and maxObjectBytes.
   * 2. Secondaries: topology secondaries filtered by policy overrides, by cloudinaryReplication,
   *    and by driver capabilities (size limits, privateDelivery).
   * 3. Security invariant: Never return cloudinary as a secondary or primary for non-public files
   *    unless the driver reports privateDelivery=true.
   */
  plan(
    ctx: RequestContext,
    policy: UploadPolicy,
    file: FilePlacementMetadata,
  ): StoragePlacementPlan {
    const topology = this.registry.getTopology();

    // ── 1. Determine Initial Primary Candidate Order ─────────────────────────
    // If policy specifies a storage.primary override, that takes precedence.
    const initialCandidates: ProviderName[] = [];
    if (policy.storage?.primary) {
      initialCandidates.push(policy.storage.primary);
      if (topology.primary !== policy.storage.primary) {
        initialCandidates.push(topology.primary);
      }
    } else {
      initialCandidates.push(topology.primary);
    }

    for (const failover of topology.primaryFailover) {
      if (!initialCandidates.includes(failover)) {
        initialCandidates.push(failover);
      }
    }

    // ── 2. Filter Primary Candidates by Health, Size, and Security ───────────
    const primaryCandidates: ProviderName[] = [];
    for (const candidate of initialCandidates) {
      if (!this.registry.has(candidate)) {
        continue;
      }

      if (!this.registry.isHealthy(candidate)) {
        this.logger.debug(
          `Skipping candidate "${candidate}": driver is unhealthy`,
        );
        continue;
      }

      const driver = this.registry.get(candidate);

      // Max object size check
      if (
        driver.capabilities.maxObjectBytes !== undefined &&
        file.size > driver.capabilities.maxObjectBytes
      ) {
        this.logger.debug(
          `Skipping candidate "${candidate}": file size ${file.size} exceeds maxObjectBytes ${driver.capabilities.maxObjectBytes}`,
        );
        continue;
      }

      // Security invariant: non-public files must never go to public CDN without privateDelivery
      if (file.visibility !== 'public' && candidate === 'cloudinary') {
        if (!driver.capabilities.privateDelivery) {
          this.logger.debug(
            `Skipping candidate "${candidate}": non-public visibility "${file.visibility}" cannot use public CDN without privateDelivery`,
          );
          continue;
        }
      }

      primaryCandidates.push(candidate);
    }

    if (primaryCandidates.length === 0) {
      throw new StorageUnavailableError(
        `No healthy primary storage candidate available satisfying file size (${file.size} bytes) and visibility ("${file.visibility}") constraints.`,
      );
    }

    // ── 3. Determine Secondary Candidates ────────────────────────────────────
    let initialSecondaries: ProviderName[] = [];
    if (policy.storage?.replicas) {
      if (policy.storage.replicas === 'auto') {
        const all: ProviderName[] = ['local', 'cloudinary', 'seaweedfs'];
        initialSecondaries = all.filter(
          (d) => this.registry.has(d) && !primaryCandidates.includes(d),
        );
      } else {
        initialSecondaries = policy.storage.replicas.filter(
          (d) => !primaryCandidates.includes(d),
        );
      }
    } else {
      initialSecondaries = topology.secondaries.filter(
        (d) => !primaryCandidates.includes(d),
      );
    }

    // Deduplicate
    initialSecondaries = Array.from(new Set(initialSecondaries));

    // ── 4. Filter Secondaries by Policy, Health, Capabilities & Security ─────
    const secondaries: ProviderName[] = [];
    for (const secondary of initialSecondaries) {
      if (!this.registry.has(secondary)) {
        continue;
      }

      if (!this.registry.isHealthy(secondary)) {
        continue;
      }

      const driver = this.registry.get(secondary);

      // Max object size check
      if (
        driver.capabilities.maxObjectBytes !== undefined &&
        file.size > driver.capabilities.maxObjectBytes
      ) {
        continue;
      }

      // Cloudinary replication policy filter
      if (secondary === 'cloudinary') {
        if (policy.cloudinaryReplication === 'never') {
          continue;
        }
        if (
          policy.cloudinaryReplication === 'public-only' &&
          file.visibility !== 'public'
        ) {
          continue;
        }
        // Security check
        if (
          file.visibility !== 'public' &&
          !driver.capabilities.privateDelivery
        ) {
          continue;
        }
      }

      secondaries.push(secondary);
    }

    return {
      primaryCandidates,
      secondaries,
    };
  }
}
