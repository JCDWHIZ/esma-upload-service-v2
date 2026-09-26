import { Request } from 'express';
import { ValidationError } from '../core/errors/app-error.js';
import { ApiClient } from '../core/types.js';

export type ActorType = 'user' | 'service';
export type ContextNamespace =
  'esma-tenant' | 'esma-admin' | 'generic' | (string & {});

export interface TokenAccessScope {
  roles?: string[];
  permissions?: string[];
}

export interface TokenAccessClaims {
  organization?: TokenAccessScope;
  global?: TokenAccessScope;
  client?: TokenAccessScope;
}

export interface VerifiedTokenClaims {
  sub?: string;
  userId?: string;
  organizationId?: string;
  schoolId?: string;
  branchId?: string;
  branches?: Array<{ id: string } | string>;
  role?: string;
  roles?: string[];
  permissions?: string[];
  email?: string;
  access?: TokenAccessClaims;
  platformAdmin?: boolean;
  [key: string]: unknown;
}

export interface AuthenticatedHttpRequest extends Request {
  user?: VerifiedTokenClaims;
  principal?: VerifiedTokenClaims | ApiClient | Record<string, unknown>;
  token?: VerifiedTokenClaims;
  apiClient?: ApiClient;
  ctx?: RequestContext;
}

export interface RequestContextActor {
  readonly id: string;
  readonly type: ActorType;
  readonly roles: readonly string[];
  readonly permissions?: readonly string[];
  readonly scopes: readonly string[];
  readonly isPlatformAdmin?: boolean;
}

export interface RequestContext {
  readonly namespace: string;
  readonly tenantId: string;
  readonly subTenantId?: string;
  readonly actor: RequestContextActor;
  readonly correlationId: string;
  readonly ipAddress: string;
  readonly userAgent?: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface ContextResolver {
  resolve(req: AuthenticatedHttpRequest): Promise<RequestContext>;
}

export const ATTRIBUTES_MAX_KEYS = 20;
export const ATTRIBUTES_MAX_KEY_LENGTH = 256;
export const ATTRIBUTES_MAX_VALUE_LENGTH = 256;

/**
 * Parses and sanitizes client-supplied untrusted attributes.
 * Accepts a JSON-encoded string (from x-attributes header) or an object (from req.body).
 * Enforces:
 * - Max 20 keys
 * - Keys must be 1-256 characters
 * - Values must be strings, max 256 characters
 * - No nested objects, arrays, numbers, or booleans
 */
export function parseAttributes(
  raw: unknown,
): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null || raw === '') {
    return Object.freeze({});
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new ValidationError('Invalid JSON in attributes', {
        cause: err,
        detail: 'The provided attributes could not be parsed as valid JSON',
      });
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError('Attributes must be a valid key-value object', {
      detail: `Received ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
    });
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > ATTRIBUTES_MAX_KEYS) {
    throw new ValidationError(
      `Attributes exceed maximum allowable count of ${ATTRIBUTES_MAX_KEYS} keys`,
      {
        detail: `Received ${entries.length} keys`,
      },
    );
  }

  const result: Record<string, string> = {};

  for (const [key, val] of entries) {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > ATTRIBUTES_MAX_KEY_LENGTH
    ) {
      throw new ValidationError(
        `Attribute key '${key}' is invalid (must be 1-${ATTRIBUTES_MAX_KEY_LENGTH} characters)`,
      );
    }

    if (typeof val !== 'string') {
      throw new ValidationError(
        `Attribute value for '${key}' must be a string`,
        {
          detail: `Expected string, received ${typeof val}`,
        },
      );
    }

    if (val.length > ATTRIBUTES_MAX_VALUE_LENGTH) {
      throw new ValidationError(
        `Attribute value for '${key}' exceeds maximum length of ${ATTRIBUTES_MAX_VALUE_LENGTH} characters`,
        {
          detail: `Length is ${val.length}`,
        },
      );
    }

    result[key] = val;
  }

  return Object.freeze(result);
}

/**
 * Deep-freezes a RequestContext instance to guarantee downstream immutability.
 */
export function freezeContext(ctx: RequestContext): RequestContext {
  if (ctx.actor) {
    if (Array.isArray(ctx.actor.roles)) {
      Object.freeze(ctx.actor.roles);
    }
    if (Array.isArray(ctx.actor.permissions)) {
      Object.freeze(ctx.actor.permissions);
    }
    if (Array.isArray(ctx.actor.scopes)) {
      Object.freeze(ctx.actor.scopes);
    }
    Object.freeze(ctx.actor);
  }

  if (ctx.attributes) {
    Object.freeze(ctx.attributes);
  }

  return Object.freeze(ctx);
}
