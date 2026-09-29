import type { ProviderName } from './types.js';
import type { AppConfigService } from '../config/config.service.js';
import { PermanentError } from '../core/errors/app-error.js';

export interface StorageTopology {
  mode: 'single' | 'replicated';
  primary: ProviderName;
  primaryFailover: ProviderName[];
  secondaries: ProviderName[];
  strict: boolean;
}

/**
 * Resolves the active storage topology based on configuration (ARCH §6.3).
 */
export function resolveTopology(config: AppConfigService): StorageTopology {
  const driverMode = config.storageDriver;

  if (
    driverMode === 'local' ||
    driverMode === 'cloudinary' ||
    driverMode === 'seaweedfs'
  ) {
    return {
      mode: 'single',
      primary: driverMode,
      primaryFailover: [],
      secondaries: [],
      strict: true,
    };
  }

  if (driverMode === 'hybrid') {
    const primary = config.hybridPrimary;
    const failoverRaw = config.hybridPrimaryFailover?.trim() ?? '';
    let primaryFailover: ProviderName[] = [];

    if (failoverRaw.length > 0) {
      primaryFailover = Array.from(
        new Set(
          failoverRaw
            .split(',')
            .map((s) => s.trim() as ProviderName)
            .filter((s) => s.length > 0 && s !== primary),
        ),
      );
    }

    let secondaries: ProviderName[] = [];
    const replicasRaw = config.hybridReplicas.trim();

    if (replicasRaw === 'auto') {
      const all: ProviderName[] = ['local', 'cloudinary', 'seaweedfs'];
      secondaries = all.filter((d) => d !== primary);
    } else if (replicasRaw.length > 0) {
      secondaries = Array.from(
        new Set(
          replicasRaw
            .split(',')
            .map((s) => s.trim() as ProviderName)
            .filter((s) => s.length > 0),
        ),
      );
    }

    return {
      mode: 'replicated',
      primary,
      primaryFailover,
      secondaries,
      strict: config.hybridStrict,
    };
  }

  throw new PermanentError(
    `Unsupported STORAGE_DRIVER configuration: "${String(driverMode)}"`,
  );
}
