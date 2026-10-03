import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ConfigModule } from '../src/config/config.module.js';
import { AppConfigService } from '../src/config/config.service.js';
import {
  DEFAULT_POLICIES,
  PolicyValidationError,
  UploadPolicy,
  validatePolicy,
} from '../src/config/policies.js';
import { PolicyRegistry } from '../src/config/policy-registry.js';

describe('Upload Policy Registry (P1-11)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-registry-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Default Policies Specification (ARCH §3.4, §3.3)', () => {
    it('defines esma-tenant with correct field rules, limits and public-only Cloudinary replication', () => {
      const tenant = DEFAULT_POLICIES['esma-tenant'];
      expect(tenant).toBeDefined();
      expect(tenant.namespace).toBe('esma-tenant');
      expect(tenant.maxFileSizeBytes).toBe(20 * 1024 * 1024);
      expect(tenant.maxFilesPerRequest).toBe(10);
      expect(tenant.defaultVisibility).toBe('tenant');
      expect(tenant.allowedVisibilities).toEqual([
        'private',
        'tenant',
        'public',
      ]);
      expect(tenant.cloudinaryReplication).toBe('public-only');
      expect(tenant.cloudinaryRootFolder).toBe('uploads/schools');
      expect(tenant.fieldRules).toEqual({
        avatar: { maxCount: 1 },
        gallery: { maxCount: 5 },
        documents: { maxCount: 10 },
      });
      expect(tenant.allowedMimeTypes).toContain('image/jpeg');
      expect(tenant.allowedMimeTypes).toContain('image/png');
      expect(tenant.allowedMimeTypes).toContain('application/pdf');
      expect(tenant.allowedMimeTypes).toContain(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(tenant.allowedMimeTypes).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    });

    it('defines esma-admin with correct field rules and public default visibility', () => {
      const admin = DEFAULT_POLICIES['esma-admin'];
      expect(admin).toBeDefined();
      expect(admin.namespace).toBe('esma-admin');
      expect(admin.maxFileSizeBytes).toBe(20 * 1024 * 1024);
      expect(admin.maxFilesPerRequest).toBe(10);
      expect(admin.defaultVisibility).toBe('public');
      expect(admin.allowedVisibilities).toEqual([
        'public',
        'tenant',
        'private',
      ]);
      expect(admin.cloudinaryReplication).toBe('public-only');
      expect(admin.cloudinaryRootFolder).toBe('admin');
      expect(admin.fieldRules).toEqual({
        profile_image: { maxCount: 1 },
        gallery_images: { maxCount: 5 },
        documents: { maxCount: 3 },
      });
    });

    it('defines generic-default fallback policy', () => {
      const generic = DEFAULT_POLICIES['generic-default'];
      expect(generic).toBeDefined();
      expect(generic.namespace).toBe('generic-default');
      expect(generic.defaultVisibility).toBe('private');
      expect(generic.allowedVisibilities).toEqual([
        'private',
        'tenant',
        'public',
      ]);
      expect(generic.cloudinaryRootFolder).toBe('uploads');
      expect(generic.allowedMimeTypes.length).toBeGreaterThan(10);
    });

    it('ensures all default policies pass validation with 0 issues', () => {
      for (const policy of Object.values(DEFAULT_POLICIES)) {
        const issues = validatePolicy(policy);
        expect(issues).toEqual([]);
      }
    });
  });

  describe('Policy Validation Rules (F-51 & Startup Guards)', () => {
    const validBase: UploadPolicy = {
      namespace: 'test-policy',
      maxFileSizeBytes: 10 * 1024 * 1024,
      maxFilesPerRequest: 5,
      allowedMimeTypes: ['image/jpeg', 'image/png'],
      defaultVisibility: 'tenant',
      allowedVisibilities: ['tenant', 'private'],
      cloudinaryReplication: 'never',
      cloudinaryRootFolder: 'tests',
      requireVirusScan: false,
    };

    it('rejects unmapped MIME types not in MIME_TO_EXT', () => {
      const policy: UploadPolicy = {
        ...validBase,
        allowedMimeTypes: ['image/jpeg', 'unregistered/custom-format'],
      };
      const issues = validatePolicy(policy);
      expect(issues.some((i) => i.field === 'allowedMimeTypes')).toBe(true);
      expect(issues[0].message).toContain(
        'has no extension mapping in MIME_TO_EXT',
      );
    });

    it('rejects legacy shortnames (F-51 defect: docx instead of full MIME string)', () => {
      const policy: UploadPolicy = {
        ...validBase,
        allowedMimeTypes: ['docx', 'pdf'],
      };
      const issues = validatePolicy(policy);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => i.message.includes('docx'))).toBe(true);
      expect(issues.some((i) => i.message.includes('pdf'))).toBe(true);
    });

    it('rejects dangerous MIME types: SVG, HTML, scripts and executables', () => {
      const dangerous = [
        'image/svg+xml',
        'text/html',
        'text/xml',
        'application/xml',
        'application/x-msdownload',
        'application/javascript',
      ];
      for (const mime of dangerous) {
        const policy: UploadPolicy = {
          ...validBase,
          allowedMimeTypes: [mime],
        };
        const issues = validatePolicy(policy);
        expect(
          issues.some((i) => i.message.includes('Dangerous MIME type')),
        ).toBe(true);
      }
    });

    it('rejects defaultVisibility not in allowedVisibilities', () => {
      const policy: UploadPolicy = {
        ...validBase,
        defaultVisibility: 'public',
        allowedVisibilities: ['private', 'tenant'],
      };
      const issues = validatePolicy(policy);
      expect(issues.some((i) => i.field === 'defaultVisibility')).toBe(true);
      expect(issues[0].message).toContain(
        'must be included in allowedVisibilities',
      );
    });

    it('rejects invalid visibility strings', () => {
      const policy: UploadPolicy = {
        ...validBase,
        defaultVisibility:
          'forbidden-vis' as unknown as UploadPolicy['defaultVisibility'],
        allowedVisibilities: [
          'tenant',
          'forbidden-vis',
        ] as unknown as UploadPolicy['allowedVisibilities'],
      };
      const issues = validatePolicy(policy);
      expect(issues.some((i) => i.field === 'defaultVisibility')).toBe(true);
      expect(issues.some((i) => i.field === 'allowedVisibilities')).toBe(true);
    });

    it('rejects non-positive maxFileSizeBytes and maxFilesPerRequest', () => {
      const zeroSize: UploadPolicy = { ...validBase, maxFileSizeBytes: 0 };
      expect(
        validatePolicy(zeroSize).some((i) => i.field === 'maxFileSizeBytes'),
      ).toBe(true);

      const negativeCount: UploadPolicy = {
        ...validBase,
        maxFilesPerRequest: -2,
      };
      expect(
        validatePolicy(negativeCount).some(
          (i) => i.field === 'maxFilesPerRequest',
        ),
      ).toBe(true);
    });

    it('rejects unsafe namespace names (e.g. path traversal or non-alphanumeric)', () => {
      const traversal: UploadPolicy = { ...validBase, namespace: '../evil' };
      expect(
        validatePolicy(traversal).some((i) => i.field === 'namespace'),
      ).toBe(true);

      const emptyNs: UploadPolicy = { ...validBase, namespace: '' };
      expect(validatePolicy(emptyNs).some((i) => i.field === 'namespace')).toBe(
        true,
      );
    });

    it('validates fieldRules safely', () => {
      const badFieldRules: UploadPolicy = {
        ...validBase,
        fieldRules: {
          'bad/field/name': { maxCount: 1 },
          valid_field: { maxCount: 0 },
        },
      };
      const issues = validatePolicy(badFieldRules);
      expect(issues.some((i) => i.field === 'fieldRules.bad/field/name')).toBe(
        true,
      );
      expect(
        issues.some((i) => i.field === 'fieldRules.valid_field.maxCount'),
      ).toBe(true);
    });
  });

  describe('PolicyRegistry Operations and Fallback', () => {
    it('returns exact policy for known namespaces in O(1)', () => {
      const registry = PolicyRegistry.create();
      const tenant = registry.get('esma-tenant');
      expect(tenant.namespace).toBe('esma-tenant');

      const admin = registry.get('esma-admin');
      expect(admin.namespace).toBe('esma-admin');
    });

    it('falls back to generic-default when namespace is unknown or not provided', () => {
      const registry = PolicyRegistry.create();
      const fallbackUnknown = registry.get('non-existent-namespace');
      expect(fallbackUnknown.namespace).toBe('generic-default');

      const fallbackNull = registry.get(null);
      expect(fallbackNull.namespace).toBe('generic-default');

      const fallbackUndefined = registry.get(undefined);
      expect(fallbackUndefined.namespace).toBe('generic-default');
    });

    it('has() correctly identifies registered namespaces', () => {
      const registry = PolicyRegistry.create();
      expect(registry.has('esma-tenant')).toBe(true);
      expect(registry.has('esma-admin')).toBe(true);
      expect(registry.has('generic-default')).toBe(true);
      expect(registry.has('other-unknown')).toBe(false);
    });

    it('enforces immutability: registered policies are deeply frozen', () => {
      const registry = PolicyRegistry.create();
      const policy = registry.get('esma-tenant');

      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.allowedMimeTypes)).toBe(true);
      expect(Object.isFrozen(policy.allowedVisibilities)).toBe(true);
      expect(Object.isFrozen(policy.fieldRules)).toBe(true);

      // Mutating frozen object in strict mode throws TypeError
      expect(() => {
        (policy as unknown as Record<string, unknown>).maxFileSizeBytes = 999;
      }).toThrow();
    });
  });

  describe('JSON File Overrides (POLICIES_FILE)', () => {
    it('merges overrides from JSON object file correctly', () => {
      const filePath = path.join(tempDir, 'policies.json');
      const overrides = {
        'esma-tenant': {
          maxFileSizeBytes: 50 * 1024 * 1024,
          fieldRules: {
            custom_doc: { maxCount: 20 },
          },
        },
        'custom-school': {
          namespace: 'custom-school',
          maxFileSizeBytes: 15 * 1024 * 1024,
          maxFilesPerRequest: 3,
          allowedMimeTypes: ['image/jpeg', 'image/png'],
          defaultVisibility: 'tenant',
          allowedVisibilities: ['tenant', 'private'],
          cloudinaryReplication: 'never',
          cloudinaryRootFolder: 'custom',
          requireVirusScan: true,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(overrides), 'utf8');

      const registry = PolicyRegistry.create({ policiesFilePath: filePath });

      // esma-tenant has updated maxFileSizeBytes and merged fieldRules
      const tenant = registry.get('esma-tenant');
      expect(tenant.maxFileSizeBytes).toBe(50 * 1024 * 1024);
      expect(tenant.fieldRules).toHaveProperty('avatar');
      expect(tenant.fieldRules).toHaveProperty('custom_doc');
      expect(tenant.fieldRules?.custom_doc.maxCount).toBe(20);

      // custom-school is registered
      expect(registry.has('custom-school')).toBe(true);
      const custom = registry.get('custom-school');
      expect(custom.namespace).toBe('custom-school');
      expect(custom.requireVirusScan).toBe(true);
    });

    it('merges overrides from JSON array file correctly', () => {
      const filePath = path.join(tempDir, 'policies-arr.json');
      const overrides = [
        {
          namespace: 'array-policy',
          maxFileSizeBytes: 5 * 1024 * 1024,
          maxFilesPerRequest: 2,
          allowedMimeTypes: ['application/pdf'],
          defaultVisibility: 'private',
          allowedVisibilities: ['private'],
          cloudinaryReplication: 'never',
          cloudinaryRootFolder: 'arr',
          requireVirusScan: false,
        },
      ];
      fs.writeFileSync(filePath, JSON.stringify(overrides), 'utf8');

      const registry = PolicyRegistry.create({ policiesFilePath: filePath });
      expect(registry.has('array-policy')).toBe(true);
      expect(registry.get('array-policy').maxFileSizeBytes).toBe(
        5 * 1024 * 1024,
      );
    });

    it('throws PolicyValidationError when policies file does not exist', () => {
      const nonExistent = path.join(tempDir, 'missing.json');
      expect(() => {
        PolicyRegistry.create({ policiesFilePath: nonExistent });
      }).toThrow(PolicyValidationError);
    });

    it('throws PolicyValidationError when JSON file is invalid syntax', () => {
      const malformedPath = path.join(tempDir, 'bad.json');
      fs.writeFileSync(malformedPath, '{ not valid json }', 'utf8');

      expect(() => {
        PolicyRegistry.create({ policiesFilePath: malformedPath });
      }).toThrow(PolicyValidationError);
    });

    it('throws PolicyValidationError when an override contains invalid policy attributes', () => {
      const invalidPolicyPath = path.join(tempDir, 'invalid-policy.json');
      fs.writeFileSync(
        invalidPolicyPath,
        JSON.stringify({
          'esma-tenant': {
            maxFileSizeBytes: -50,
          },
        }),
        'utf8',
      );

      expect(() => {
        PolicyRegistry.create({ policiesFilePath: invalidPolicyPath });
      }).toThrow(PolicyValidationError);
    });
  });

  describe('NestJS DI Integration', () => {
    it('resolves PolicyRegistry cleanly through ConfigModule', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [ConfigModule],
      }).compile();

      const registry = module.get<PolicyRegistry>(PolicyRegistry);
      expect(registry).toBeDefined();
      expect(registry.get('esma-tenant').namespace).toBe('esma-tenant');

      const configService = module.get<AppConfigService>(AppConfigService);
      expect(configService).toBeDefined();
    });
  });
});
