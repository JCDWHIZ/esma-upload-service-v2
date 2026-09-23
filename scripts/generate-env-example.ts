import * as fs from 'node:fs';
import * as path from 'node:path';

interface EnvVarMetadata {
  key: string;
  placeholder: string;
  comment?: string;
}

interface EnvSection {
  title: string;
  vars: EnvVarMetadata[];
}

const sections: EnvSection[] = [
  {
    title: 'Application',
    vars: [
      {
        key: 'NODE_ENV',
        placeholder: 'development',
        comment: 'lowercase: development | test | production',
      },
      {
        key: 'PORT',
        placeholder: '7030',
        comment: 'current service port (v1 docs said 5000; see F-01)',
      },
      { key: 'APP_BASE_URL', placeholder: 'http://localhost:7030' },
      { key: 'LOG_LEVEL', placeholder: 'info' },
      {
        key: 'TRUST_PROXY',
        placeholder: 'loopback',
        comment:
          'trust-proxy setting on the underlying Express adapter (app.set("trust proxy", ...))',
      },
      {
        key: 'CORS_ALLOWED_ORIGINS',
        placeholder: 'http://localhost:3000',
      },
      {
        key: 'SWAGGER_ENABLED',
        placeholder: 'true',
        comment: 'must be false in production unless gated',
      },
      { key: 'INSTANCE_COUNT_HINT', placeholder: '1' },
    ],
  },
  {
    title: 'Auth',
    vars: [
      {
        key: 'JWT_SECRET',
        placeholder: '',
        comment: 'generate: openssl rand -base64 48 (never commit)',
      },
      { key: 'JWT_ALGORITHMS', placeholder: 'HS256' },
      { key: 'JWT_CLOCK_TOLERANCE_SECONDS', placeholder: '5' },
      { key: 'ADMIN_ALLOWED_ROLES', placeholder: 'superadmin' },
      {
        key: 'ADMIN_AUTH_MODE',
        placeholder: 'enforce',
        comment: 'off | report | enforce (report only for one release, P1-09)',
      },
      {
        key: 'SIGNED_URL_SECRET',
        placeholder: '',
        comment: 'different from JWT_SECRET',
      },
      { key: 'SIGNED_URL_MAX_TTL_SECONDS', placeholder: '900' },
      {
        key: 'IDENTITY_JWKS_URI',
        placeholder: 'https://api.esma.elsoft.ng/identity/oauth2/jwks',
      },
      {
        key: 'IDENTITY_ISSUER',
        placeholder: 'http://esma-identity-service:7071/identity',
      },
    ],
  },
  {
    title: 'Database and cache',
    vars: [
      {
        key: 'DATABASE_URL',
        placeholder: 'postgres://gus:gus@localhost:5432/gus',
      },
      { key: 'DATABASE_POOL_MAX', placeholder: '10' },
      { key: 'REDIS_URL', placeholder: 'redis://localhost:6379' },
    ],
  },
  {
    title: 'Ingestion',
    vars: [
      { key: 'STAGING_DIR', placeholder: '/tmp/gus-staging' },
      { key: 'STAGING_MAX_AGE_MINUTES', placeholder: '60' },
      { key: 'DEFAULT_MAX_FILE_SIZE_BYTES', placeholder: '20971520' },
    ],
  },
  {
    title: 'Storage selection: local | cloudinary | seaweedfs | hybrid',
    vars: [
      { key: 'STORAGE_DRIVER', placeholder: 'cloudinary' },
      { key: 'HYBRID_PRIMARY', placeholder: 'seaweedfs' },
      { key: 'HYBRID_PRIMARY_FAILOVER', placeholder: 'local' },
      {
        key: 'HYBRID_REPLICAS',
        placeholder: 'cloudinary,local',
        comment: 'or "auto"',
      },
      { key: 'HYBRID_STRICT', placeholder: 'true' },
      { key: 'DRIVER_HEALTH_INTERVAL_SECONDS', placeholder: '30' },
    ],
  },
  {
    title: 'Local driver (dev / single node only)',
    vars: [
      {
        key: 'LOCAL_STORAGE_PATH',
        placeholder: '/data/storage',
        comment: 'must NOT be under a served path or the staging dir',
      },
    ],
  },
  {
    title: 'SeaweedFS S3 gateway',
    vars: [
      {
        key: 'SEAWEEDFS_S3_ENDPOINT',
        placeholder: 'http://localhost:8333',
      },
      {
        key: 'SEAWEEDFS_PUBLIC_ENDPOINT',
        placeholder: '',
        comment: 'optional, client-reachable endpoint for presigned redirects',
      },
      { key: 'SEAWEEDFS_BUCKET', placeholder: 'esma-uploads' },
      {
        key: 'SEAWEEDFS_ACCESS_KEY',
        placeholder: '',
        comment: 'dev: any value. prod: a real identity',
      },
      { key: 'SEAWEEDFS_SECRET_KEY', placeholder: '' },
      { key: 'SEAWEEDFS_REGION', placeholder: 'us-east-1' },
      { key: 'SEAWEEDFS_AUTO_CREATE_BUCKET', placeholder: 'false' },
    ],
  },
  {
    title: 'Cloudinary',
    vars: [
      { key: 'CLOUDINARY_CLOUD_NAME', placeholder: '' },
      { key: 'CLOUDINARY_API_KEY', placeholder: '' },
      { key: 'CLOUDINARY_API_SECRET', placeholder: '' },
      {
        key: 'CLOUDINARY_ROOT_FOLDER',
        placeholder: 'uploads',
        comment:
          'default root for generic namespaces; esma-tenant and esma-admin roots are fixed by policy',
      },
      { key: 'CLOUDINARY_MAX_OBJECT_BYTES', placeholder: '10485760' },
    ],
  },
  {
    title: 'Event pipeline: memory | kafka | pulsar',
    vars: [
      { key: 'EVENT_BROKER', placeholder: 'memory' },
      { key: 'ALLOW_MEMORY_BROKER', placeholder: 'false' },
      { key: 'KAFKA_BROKERS', placeholder: 'localhost:9092' },
      { key: 'KAFKA_CLIENT_ID', placeholder: 'esma-upload-service' },
      { key: 'KAFKA_GROUP_ID', placeholder: 'esma-upload-workers' },
      {
        key: 'PULSAR_SERVICE_URL',
        placeholder: 'pulsar://localhost:6650',
      },
      { key: 'PULSAR_AUTH_TOKEN', placeholder: '' },
      { key: 'PULSAR_TENANT', placeholder: 'esma' },
      { key: 'PULSAR_NAMESPACE', placeholder: 'uploads' },
    ],
  },
  {
    title: 'Workers',
    vars: [
      {
        key: 'WORKER_ROLES',
        placeholder: 'relay,replication,processing,sweeper',
      },
      { key: 'REPLICATION_MAX_ATTEMPTS', placeholder: '6' },
      { key: 'REPLICATION_CONCURRENCY', placeholder: '4' },
      { key: 'OUTBOX_RETENTION_HOURS', placeholder: '72' },
      { key: 'TOMBSTONE_RETENTION_DAYS', placeholder: '30' },
      { key: 'CLAMAV_HOST', placeholder: '' },
      { key: 'CLAMAV_PORT', placeholder: '3310' },
    ],
  },
  {
    title: 'Rollout flags (removed in P6-10)',
    vars: [
      {
        key: 'LEGACY_ENGINE',
        placeholder: 'legacy',
        comment: 'legacy | core',
      },
      { key: 'LEGACY_DEFAULT_VISIBILITY', placeholder: 'public' },
    ],
  },
];

export function generateEnvExampleContent(): string {
  const lines: string[] = [
    '# =============================================================================',
    '# ESMA Upload Service v2 - Environment Configuration Reference (.env.example)',
    '# Generated automatically from configuration schema. Do not put real secrets here.',
    '# =============================================================================',
    '',
  ];

  for (const section of sections) {
    lines.push(`# --- ${section.title} ---`);
    for (const v of section.vars) {
      const assignment = `${v.key}=${v.placeholder}`;
      if (v.comment) {
        // align comment nicely
        const padded = assignment.padEnd(36, ' ');
        lines.push(`${padded} # ${v.comment}`);
      } else {
        lines.push(assignment);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function run() {
  const isCheck = process.argv.includes('--check');
  const targetPath = path.resolve(process.cwd(), '.env.example');
  const generated = generateEnvExampleContent();

  if (isCheck) {
    if (!fs.existsSync(targetPath)) {
      console.error('Error: .env.example does not exist.');
      process.exit(1);
    }
    const current = fs.readFileSync(targetPath, 'utf8');
    if (current !== generated) {
      console.error(
        'Error: .env.example is out of date with configuration schema. Run "npm run env:example" to update.',
      );
      process.exit(1);
    }
    console.log('.env.example is up to date.');
  } else {
    fs.writeFileSync(targetPath, generated, 'utf8');
    console.log(`Generated .env.example successfully at ${targetPath}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-env-example.ts')) {
  run();
}
