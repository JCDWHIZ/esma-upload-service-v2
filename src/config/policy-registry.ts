import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfigService } from './config.service.js';
import {
  DEFAULT_POLICIES,
  PolicyValidationError,
  PolicyValidationIssue,
  UploadPolicy,
  deepFreeze,
  validatePolicy,
} from './policies.js';

export interface PolicyRegistryOptions {
  policiesFilePath?: string;
  customPolicies?: Record<string, Partial<UploadPolicy>>;
}

@Injectable()
export class PolicyRegistry {
  private readonly logger = new Logger(PolicyRegistry.name);
  private readonly policies = new Map<string, UploadPolicy>();

  constructor(@Optional() private readonly configService?: AppConfigService) {
    this.init();
  }

  /**
   * Initializes and validates all policies, applying overrides from file if specified.
   */
  private init(options?: PolicyRegistryOptions): void {
    const rawPolicies = new Map<string, UploadPolicy>();

    // 1. Seed with default policies
    for (const [ns, policy] of Object.entries(DEFAULT_POLICIES)) {
      rawPolicies.set(ns, { ...policy });
    }

    // 2. Load file overrides if configured
    const filePath =
      options?.policiesFilePath ?? this.configService?.policiesFile;
    if (filePath && filePath.trim().length > 0) {
      this.loadFileOverrides(filePath.trim(), rawPolicies);
    }

    // 3. Apply programmatic custom policies if provided
    if (options?.customPolicies) {
      this.applyPolicyOverrides(options.customPolicies, rawPolicies);
    }

    // 4. Validate all policies and fail fast on any issue
    const allIssues: PolicyValidationIssue[] = [];
    for (const policy of rawPolicies.values()) {
      const issues = validatePolicy(policy);
      allIssues.push(...issues);
    }

    // Ensure fallback generic-default is present
    if (!rawPolicies.has('generic-default')) {
      allIssues.push({
        namespace: 'generic-default',
        field: 'namespace',
        message: 'Missing mandatory fallback policy "generic-default"',
      });
    }

    if (allIssues.length > 0) {
      const error = new PolicyValidationError(allIssues);
      process.stderr.write(`${error.message}\n`);
      const isTest =
        this.configService?.isTest() || process.env.NODE_ENV === 'test';
      if (!isTest) {
        process.exit(1);
      }
      throw error;
    }

    // 5. Deep freeze all policies and store in map for O(1) immutable access
    this.policies.clear();
    for (const [ns, policy] of rawPolicies.entries()) {
      this.policies.set(ns, deepFreeze({ ...policy }));
    }
  }

  /**
   * Loads and merges policy overrides from a JSON file.
   */
  private loadFileOverrides(
    filePath: string,
    targetMap: Map<string, UploadPolicy>,
  ): void {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(process.cwd(), filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new PolicyValidationError([
        {
          namespace: 'config',
          field: 'POLICIES_FILE',
          message: `Policies file not found at: ${resolvedPath}`,
        },
      ]);
    }

    let parsed: unknown;
    try {
      const rawContent = fs.readFileSync(resolvedPath, 'utf8');
      parsed = JSON.parse(rawContent);
    } catch (err: unknown) {
      throw new PolicyValidationError([
        {
          namespace: 'config',
          field: 'POLICIES_FILE',
          message: `Failed to parse policies JSON file (${resolvedPath}): ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new PolicyValidationError([
        {
          namespace: 'config',
          field: 'POLICIES_FILE',
          message: `Policies file content must be a JSON object or array of policies`,
        },
      ]);
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          !item ||
          typeof item !== 'object' ||
          !('namespace' in item) ||
          typeof (item as Record<string, unknown>).namespace !== 'string'
        ) {
          throw new PolicyValidationError([
            {
              namespace: 'config',
              field: 'POLICIES_FILE',
              message: `Each policy item in array must be an object with a "namespace" property`,
            },
          ]);
        }
        const policyItem = item as Partial<UploadPolicy> & {
          namespace: string;
        };
        this.mergeSinglePolicy(policyItem.namespace, policyItem, targetMap);
      }
    } else {
      for (const [ns, override] of Object.entries(parsed)) {
        if (!override || typeof override !== 'object') {
          throw new PolicyValidationError([
            {
              namespace: ns,
              field: 'POLICIES_FILE',
              message: `Policy override for namespace "${ns}" must be an object`,
            },
          ]);
        }
        this.mergeSinglePolicy(
          ns,
          override as Partial<UploadPolicy>,
          targetMap,
        );
      }
    }
  }

  private applyPolicyOverrides(
    overrides: Record<string, Partial<UploadPolicy>>,
    targetMap: Map<string, UploadPolicy>,
  ): void {
    for (const [ns, override] of Object.entries(overrides)) {
      this.mergeSinglePolicy(ns, override, targetMap);
    }
  }

  /**
   * Merges a single policy override into target map.
   */
  private mergeSinglePolicy(
    namespace: string,
    override: Partial<UploadPolicy>,
    targetMap: Map<string, UploadPolicy>,
  ): void {
    const existing = targetMap.get(namespace);
    const base = existing ?? {
      ...DEFAULT_POLICIES['generic-default'],
      namespace,
    };

    const merged: UploadPolicy = {
      ...base,
      ...override,
      namespace,
      fieldRules: {
        ...(base.fieldRules ?? {}),
        ...(override.fieldRules ?? {}),
      },
      storage: override.storage
        ? { ...(base.storage ?? {}), ...override.storage }
        : base.storage,
    };

    targetMap.set(namespace, merged);
  }

  /**
   * O(1) immutable lookup of an upload policy by namespace.
   * If namespace is omitted, null, or unregistered, falls back to generic-default.
   */
  get(namespace?: string | null): UploadPolicy {
    if (namespace && this.policies.has(namespace)) {
      return this.policies.get(namespace)!;
    }
    return this.policies.get('generic-default')!;
  }

  /**
   * Returns true if an explicit policy is registered for the namespace.
   */
  has(namespace: string): boolean {
    return this.policies.has(namespace);
  }

  /**
   * Returns an immutable map of all registered policies.
   */
  getAll(): ReadonlyMap<string, UploadPolicy> {
    return new Map(this.policies);
  }

  /**
   * Static factory to instantiate a PolicyRegistry directly (useful in unit tests).
   */
  static create(options?: PolicyRegistryOptions): PolicyRegistry {
    const registry = new PolicyRegistry();
    registry.init(options);
    return registry;
  }
}
