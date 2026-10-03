import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { ApiClientRepository } from '../db/repositories/api-client.repository.js';
import { ApiKeyAuthenticatorService } from '../auth/apikey/apikey-authenticator.service.js';

interface CliParsedArgs {
  command: string;
  name?: string;
  namespace?: string;
  tenants?: string[];
  anyTenant?: boolean;
  scopes?: string[];
  expires?: Date;
  prefix?: string;
  id?: string;
}

function parseCliArgs(argv: string[]): CliParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? 'help';
  const result: CliParsedArgs = {
    command,
    scopes: ['files:read', 'files:write'],
    namespace: 'generic',
    anyTenant: false,
    tenants: [],
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--name' && args[i + 1]) {
      result.name = args[++i];
    } else if (arg === '--namespace' && args[i + 1]) {
      result.namespace = args[++i];
    } else if (arg === '--tenants' && args[i + 1]) {
      result.tenants = args[++i]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (arg === '--any-tenant') {
      result.anyTenant = true;
    } else if (arg === '--scopes' && args[i + 1]) {
      result.scopes = args[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--expires' && args[i + 1]) {
      const val = args[++i];
      const parsedDays = parseInt(val, 10);
      if (!isNaN(parsedDays)) {
        result.expires = new Date(Date.now() + parsedDays * 86_400_000);
      } else {
        result.expires = new Date(val);
      }
    } else if (arg === '--prefix' && args[i + 1]) {
      result.prefix = args[++i];
    } else if (arg === '--id' && args[i + 1]) {
      result.id = args[++i];
    }
  }

  return result;
}

async function run(): Promise<void> {
  const parsed = parseCliArgs(process.argv);

  if (
    parsed.command === 'help' ||
    !['create', 'revoke', 'list'].includes(parsed.command)
  ) {
    process.stdout.write(`
ESMA Upload Service v2 - API Key CLI Utility
=============================================
Usage:
  node dist/src/scripts/apikey-cli.js <command> [options]

Commands:
  create   Generate a new API client key
    --name <name>            (Required) Human-readable client name
    --namespace <namespace>  (Default: generic) Scope namespace
    --tenants <a,b,c>        Comma-separated allowed tenant IDs
    --any-tenant             Allow client to access any tenant
    --scopes <read,write>    Comma-separated scopes (Default: files:read,files:write)
    --expires <days | ISO>   Key expiration (e.g. 365 or 2027-01-01)

  revoke   Revoke an existing API client key
    --prefix <prefix>        8-character key prefix
    --id <id>                Client UUID

  list     List all registered API client keys
\n`);
    process.exit(0);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  try {
    const repo = app.get(ApiClientRepository);

    if (parsed.command === 'create') {
      if (!parsed.name) {
        process.stderr.write(
          'Error: --name is required for creating an API key.\n',
        );
        process.exit(1);
      }

      const generated = ApiKeyAuthenticatorService.generateKey();

      const created = await repo.create({
        name: parsed.name,
        keyPrefix: generated.keyPrefix,
        keyHash: generated.keyHash,
        namespace: parsed.namespace ?? 'generic',
        tenantIds: parsed.tenants ?? [],
        allowAnyTenant: parsed.anyTenant ?? false,
        scopes: parsed.scopes ?? ['files:read', 'files:write'],
        expiresAt: parsed.expires ?? null,
      });

      process.stdout.write(`
========================================================================
NEW API KEY GENERATED (Save this now - it will never be displayed again)
========================================================================
API Key:        ${generated.rawKey}
Key Prefix:     ${created.keyPrefix}
Client ID:      ${created.id}
Client Name:    ${created.name}
Namespace:      ${created.namespace}
AllowAnyTenant: ${String(created.allowAnyTenant)}
Tenants:        ${created.tenantIds.length > 0 ? created.tenantIds.join(', ') : '(None)'}
Scopes:         ${created.scopes.join(', ')}
Expires At:     ${created.expiresAt ? created.expiresAt.toISOString() : 'Never'}
Created At:     ${created.createdAt.toISOString()}
========================================================================
\n`);
    } else if (parsed.command === 'revoke') {
      if (!parsed.prefix && !parsed.id) {
        process.stderr.write(
          'Error: either --prefix or --id is required for revocation.\n',
        );
        process.exit(1);
      }

      let revoked = false;
      if (parsed.prefix) {
        revoked = await repo.revokeByPrefix(parsed.prefix);
      } else if (parsed.id) {
        revoked = await repo.revoke(parsed.id);
      }

      if (revoked) {
        process.stdout.write(
          `Success: API key (${parsed.prefix ?? parsed.id}) has been revoked.\n`,
        );
      } else {
        process.stderr.write(
          `Warning: No active API key found matching ${parsed.prefix ?? parsed.id}.\n`,
        );
      }
    } else if (parsed.command === 'list') {
      const clients = await repo.list({ limit: 100 });
      if (clients.length === 0) {
        process.stdout.write('No registered API clients found.\n');
      } else {
        process.stdout.write(`Registered API Clients (${clients.length}):\n\n`);
        for (const c of clients) {
          process.stdout.write(
            `[${c.status}] Prefix: ${c.keyPrefix} | Name: ${c.name} | Namespace: ${c.namespace} | AnyTenant: ${String(c.allowAnyTenant)} | Scopes: ${c.scopes.join(',')} | Created: ${c.createdAt.toISOString()}\n`,
          );
        }
      }
    }
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`CLI execution failed: ${message}\n`);
  process.exit(1);
});
