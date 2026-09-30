import { Injectable, Logger } from '@nestjs/common';
import type { FileRecord, FileReplica } from '../core/types.js';
import type { ProviderName } from '../storage/types.js';
import { StorageRegistry } from '../storage/registry.js';
import { ReplicaNotAvailableError } from '../core/errors/app-error.js';

export interface ReplicaSelectorOptions {
  preferredProvider?: ProviderName;
  redirectAllowed?: boolean;
}

@Injectable()
export class ReplicaSelector {
  private readonly logger = new Logger(ReplicaSelector.name);

  constructor(private readonly storageRegistry: StorageRegistry) {}

  /**
   * Evaluates the file, its replicas, and driver health to produce an ordered
   * list of replica candidates for reading and fallback.
   *
   * Conforms to ARCH §7.2 and BACKEND_TASKS P4-08:
   * 1. Only AVAILABLE replicas whose drivers are registered and healthy.
   * 2. When preferredProvider is requested (files:admin), only that replica is returned;
   *    if unavailable, ReplicaNotAvailableError (409) with Retry-After: 30 is thrown.
   * 3. For public files with redirect allowed, prefer a CDN replica (e.g. Cloudinary),
   *    otherwise primary, then remaining secondaries.
   * 4. For non-public files (or public when redirect=never), prefer primary, then
   *    other internal secondaries (skipping CDN drivers without privateDelivery).
   */
  selectCandidates(
    file: FileRecord,
    replicas: FileReplica[],
    options?: ReplicaSelectorOptions,
  ): FileReplica[] {
    const redirectAllowed = options?.redirectAllowed ?? true;

    // Helper: is a provider healthy and available in registry
    const isHealthy = (provider: ProviderName): boolean => {
      const has =
        typeof this.storageRegistry?.has === 'function'
          ? this.storageRegistry.has(provider)
          : true;
      const healthy =
        typeof this.storageRegistry?.isHealthy === 'function'
          ? this.storageRegistry.isHealthy(provider)
          : true;
      return has && healthy;
    };

    // Synthesize primary replica only if no replica record exists for primary provider
    const allReplicas = [...replicas];
    const hasPrimaryRecord = allReplicas.some(
      (r) => r.role === 'primary' || r.provider === file.primaryProvider,
    );

    if (!hasPrimaryRecord && isHealthy(file.primaryProvider)) {
      allReplicas.push({
        fileId: file.id,
        provider: file.primaryProvider,
        role: 'primary',
        status: 'AVAILABLE',
        providerKey: file.storageKey,
        providerMeta: {},
        url: null,
        etag: file.sha256,
        attempts: 0,
        lastError: null,
        syncedAt: null,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
      });
    }

    // 1. If preferredProvider is requested (admin override)
    if (options?.preferredProvider) {
      const match = allReplicas.find(
        (r) =>
          r.provider === options.preferredProvider &&
          r.status === 'AVAILABLE' &&
          isHealthy(r.provider),
      );

      if (!match) {
        const error = new ReplicaNotAvailableError(
          `Requested provider replica '${options.preferredProvider}' is not available or unhealthy`,
        );
        (error as unknown as { headers?: Record<string, string> }).headers = {
          'Retry-After': '30',
        };
        throw error;
      }

      return [match];
    }

    // 2. Filter available and healthy replicas
    const available = allReplicas.filter(
      (r) => r.status === 'AVAILABLE' && isHealthy(r.provider),
    );

    if (available.length === 0) {
      return [];
    }

    // 3. Order candidates according to visibility and redirect rules
    const isPublic = file.visibility === 'public';

    if (isPublic) {
      if (redirectAllowed) {
        // Prefer CDN replica (Cloudinary) first, then primary, then remaining
        const cdn = available.filter((r) => r.provider === 'cloudinary');
        const primary = available.filter(
          (r) =>
            r.provider !== 'cloudinary' &&
            (r.role === 'primary' || r.provider === file.primaryProvider),
        );
        const others = available.filter(
          (r) =>
            r.provider !== 'cloudinary' &&
            r.role !== 'primary' &&
            r.provider !== file.primaryProvider,
        );
        return [...cdn, ...primary, ...others];
      } else {
        // Redirect disallowed (redirect=never): prefer primary, then others, then CDN
        const primary = available.filter(
          (r) => r.role === 'primary' || r.provider === file.primaryProvider,
        );
        const nonCdnOthers = available.filter(
          (r) =>
            r.provider !== 'cloudinary' &&
            r.role !== 'primary' &&
            r.provider !== file.primaryProvider,
        );
        const cdn = available.filter((r) => r.provider === 'cloudinary');
        return [...primary, ...nonCdnOthers, ...cdn];
      }
    }

    // Non-public files (tenant, private)
    // Never route to CDN unless the driver explicitly supports privateDelivery
    const allowedForNonPublic = available.filter((r) => {
      try {
        const driver = this.storageRegistry.get(r.provider);
        if (r.provider === 'cloudinary') {
          return Boolean(driver.capabilities?.privateDelivery);
        }
        return true;
      } catch {
        return false;
      }
    });

    const primary = allowedForNonPublic.filter(
      (r) => r.role === 'primary' || r.provider === file.primaryProvider,
    );
    const others = allowedForNonPublic.filter(
      (r) => r.role !== 'primary' && r.provider !== file.primaryProvider,
    );

    return [...primary, ...others];
  }

  /**
   * Convenience method to select the single best candidate replica, or null if none available.
   */
  choose(
    file: FileRecord,
    replicas: FileReplica[],
    options?: ReplicaSelectorOptions,
  ): FileReplica | null {
    const candidates = this.selectCandidates(file, replicas, options);
    return candidates.length > 0 ? candidates[0] : null;
  }
}
