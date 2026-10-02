# ESMA Upload Service: Generic Architecture & Evolution Roadmap (v2)

> **Status:** Revised 2026-09-23 (v2.3). Supersedes v1 and v2.2.
> **Key Architecture Decision (2026-09-23):** Legacy facade endpoints (`/api/tenant/upload/*` and `/api/admin/upload/*`) and their baggage (dual error formats, legacy public_id mapping, `x-school-id` headers) have been **dropped entirely**. All clients unify on the modern `/api/v1/files/*` API. Authentication is unified through the live ESMA Identity Service (`https://api.esma.elsoft.ng/identity`) via standard OIDC / JWKS (RS256).
> **Workspace layout:** `esma-upload-services/esma-upload-service/` is the frozen legacy Express v1 app — reference only, never edited or ported from. `esma-upload-services/esma-upload-service-v2/` is the NestJS rewrite where all work happens, built from the functional requirements below. `esma-upload-services/docs/` contains all documentation.
> **Companion documents:** `CURRENT_ARCHITECTURE_AND_IMPLEMENTATION (1).md` (as-is, legacy Express app), `REVIEW_FINDINGS_AND_DECISIONS.md` (every change from v1 and why), `BACKEND_TASKS.md` (executable task list).
> References such as `F-17` point to findings and `ADR-04` to decisions in the review document. Section references such as `ARCH §5.1` are used by the task list.

---

## 1. Vision, Objectives, Non-Goals

The ESMA Upload Service is evolving from a Cloudinary-only file handler into a **Generic Upload Service (GUS)**: a multi-tenant, storage-agnostic service that any ESMA component or partner can use for uploads, retrieval and deletion.

### 1.1 Objectives

1. **Domain-agnostic core.** The core never mentions `schoolId` or `branchId`. It works on a `RequestContext` (ARCH §3.1).
2. **Pluggable storage.** `local`, `cloudinary`, `seaweedfs` behind one driver interface (ARCH §6.1), selectable alone or as a replicated topology (`hybrid`).
3. **Fast-path replication.** The client waits for one durable write (the primary). Other copies are made asynchronously.
4. **Pluggable event pipeline.** `memory` (dev/test), Apache Kafka and Apache Pulsar behind one broker interface with identical retry and dead-letter behavior (ARCH §8).
5. **System of record in PostgreSQL.** File metadata, replica state, outbox and audit trail live in one transactional store (ADR-01).
6. **Unified modern API.** `/api/v1/files/*` is the sole entry point, replacing legacy Express facades. All authentication goes through the centralized OIDC Identity Service (`https://api.esma.elsoft.ng/identity`).
7. **Secure by default.** Every route is authenticated, every file has a visibility, every read is authorized, every upload is content-verified.

### 1.2 Non-goals (for this roadmap)

- Resumable uploads (tus) and browser direct-to-storage presigned uploads. They are listed as future work in ARCH §14.
- A general CDN. Cloudinary remains the image-delivery CDN.
- Full-text search over file contents. OCR output is stored as derivative metadata only (P5-09, optional).

---

## 2. Architecture Overview

### 2.0 Application framework: NestJS (ADR-21)

The HTTP and worker processes are built on **NestJS** (`@nestjs/core`, `@nestjs/platform-express`), written from scratch starting at P1-01. `CURRENT_ARCHITECTURE_AND_IMPLEMENTATION.md` describes the previous plain-Express implementation, which is **frozen** and not touched again: it is read only to confirm what each route is expected to do (ADR-02). No file from that implementation is copied, ported or imported into `esma-upload-service-v2`; every module is implemented directly from the functional requirements in this document.

Nest runs on the **Express platform adapter**, not Fastify. Reasons: the driver and ingestion design (`IngestedFile.openReadStream()`, ADR-09; `Range` handling in `FileReadService`, ARCH §7.2) is written against Node's `http.IncomingMessage`/`ServerResponse` and Express's request/response extensions, which the Express adapter preserves; `multer` is chosen independently as Nest's supported upload mechanism via `@nestjs/platform-express`'s `FileInterceptor`/`FilesInterceptor`, so the ingestion design in ARCH §4.4 and ADR-09 can rely on it without a second review; and the legacy facades (ARCH §9.4) need Express's `path-to-regexp`-based wildcard routes (`/*publicId`) during the compatibility window, which Nest exposes unchanged when the Express adapter is used. Fastify is not ruled out for a later performance push (ARCH §14), but it would need a second ingestion review (its multipart handling and streaming model differ) and is out of scope here.

Concept mapping used throughout this document and in `BACKEND_TASKS.md`:

| Express-era term (as-is document) | Nest equivalent (target) | Where |
| :--- | :--- | :--- |
| `routes/*.ts` + hand-wired `express.Router()` | `@Controller()` classes grouped into feature `@Module()`s | ARCH §2.2, §9 |
| Route handler function | Controller method (`@Post()`, `@Get()`, ...) delegating to an injected service | ARCH §7 |
| `validateTokenMiddleware`, `validateTenantMiddleware`, `requireAdmin` | `@Injectable() implements CanActivate` **guards**, applied with `@UseGuards()` or globally via `APP_GUARD` | ARCH §3.2, §4.1 |
| Authorization check inside a controller | A guard or a route-scoped decorator (`@RequireAction('upload')`) evaluated by `AuthorizationGuard`, calling the same `authorize()` function from ARCH §4.2 | ARCH §4.2 |
| Correlation-id / request-logging middleware | An `Interceptor` (`CorrelationIdInterceptor`, wraps the handler, sets `AsyncLocalStorage`) plus Nest's built-in `Logger` | ARCH §9.3, §12 |
| Multer instance mounted per route (`upload.single(...)`) | `@UseInterceptors(FileInterceptor('file', multerOptions))` / `FilesInterceptor` / `FileFieldsInterceptor`, built from the same per-namespace `UploadPolicy` (ARCH §3.4) via a small factory function, not a route-by-route literal | ARCH §4.4 |
| `zod`/manual body validation in a controller | A `ValidationPipe` (Nest's pipe, still backed by the same `zod` schemas through a thin `ZodValidationPipe` adapter — DTOs are `zod` schemas, not `class-validator` decorators, so the schema catalog in ARCH §9 stays the single source of truth) | ARCH §9.1, §9.3 |
| Central Express error-handling middleware (`(err, req, res, next) =>`) | A global `ExceptionFilter` (`@Catch()`) that maps `AppError` subclasses to either the legacy response shape or `problem+json`, chosen by which module the filter is bound to | ARCH §9.3 |
| A driver or service imported directly (`import cloudinaryDriver from ...`) | A `provider` registered in a `StorageModule`/`EventsModule`, injected by constructor (`@Inject(STORAGE_REGISTRY)`), so tests substitute `FakeStorageDriver`/`MemoryBroker` via Nest's `Test.createTestingModule()` overrides instead of module mocks | ARCH §6.3, §8.5 |
| `worker.ts` running hand-rolled consumer loops | A separate Nest **application context** (`NestFactory.createApplicationContext(WorkerModule)`, no HTTP listener) that resolves the same providers (repositories, drivers, broker) as the API process | ARCH §2.1 |
| Swagger annotations in JSDoc comments | `@nestjs/swagger` decorators (`@ApiOperation`, `@ApiResponse`) generating the same OpenAPI document | ARCH §9, task P3-06 |

This table is normative: any task in `BACKEND_TASKS.md` that says "middleware" is read as "guard or interceptor" per this mapping, and "route" is read as "controller method." There is no task scoped to pre-rewrite Express code — the legacy app is never modified.

### 2.1 Processes

> All commands below are run from the `esma-upload-service-v2/` directory.

| Process | Command | Scales | Owns |
| :--- | :--- | :--- | :--- |
| `api` | `node dist/main.js` | Horizontally, stateless | HTTP, auth, ingestion, core services, outbox writes |
| `worker` | `node dist/worker.js` | Horizontally, per consumer group | Outbox relay, replication, processing, sweeper (ADR-14, F-28) |
| `migrate` | `node dist/db/migrate.js` | One-shot | Schema migrations on deploy |

`api` bootstraps with `NestFactory.create(AppModule)` from `esma-upload-service-v2/src/main.ts`; `worker` bootstraps with `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server, so no port, no Express adapter, smaller footprint). Both share the `dist/` output of one build (ADR-14 is unchanged: same image, different entry point).

Both `api` and `worker` are built from the same image. The relay may run inside `worker` only.

### 2.2 Component diagram

```mermaid
flowchart TD
    subgraph Clients["Clients"]
        C1["ESMA tenant client"]
        C2["ESMA SuperAdmin dashboard"]
        C3["Generic service or partner (API key)"]
    end

    subgraph API["API process"]
        R1["/api/tenant/upload/* (legacy facade)"]
        R2["/api/admin/upload/* (legacy facade)"]
        R3["/api/v1/files/* (generic API)"]
        CTX["Context resolution: authN, authZ, policy"]
        LIM["Rate limit and quota"]
        ING["Ingestion: multipart parse, staging, validation"]
        CORE["Core services: Upload, Read, Delete"]
        PLACE["StoragePlacementService"]
    end

    subgraph Stores["State"]
        PG[("PostgreSQL: files, replicas, outbox, audit")]
        RD[("Redis: rate limits, quota cache")]
    end

    subgraph Drivers["Storage drivers (pure I/O)"]
        DL["Local"]
        DS["SeaweedFS (S3)"]
        DC["Cloudinary"]
    end

    subgraph Pipeline["Event pipeline"]
        RELAY["Outbox relay"]
        BR["IMessageBroker: memory, Kafka, Pulsar"]
    end

    subgraph Workers["Worker process"]
        WR["Replication worker"]
        WP["Processing worker: scan, derivatives"]
        WS["Sweeper and reconciler"]
    end

    C1 --> R1
    C2 --> R2
    C3 --> R3
    R1 & R2 & R3 --> CTX --> LIM --> ING --> CORE
    CORE --> PLACE
    CORE --> PG
    LIM --> RD
    PLACE --> DL & DS & DC
    PG --> RELAY --> BR
    BR --> WR & WP
    WR --> DL & DS & DC
    WR --> PG
    WP --> PG
    WS --> PG
    WS --> DL & DS & DC
```

Key differences from v1: there is **no `HybridStorageDriver`**. Drivers do I/O only. Placement, replication planning, database writes and event publication belong to core services (ADR-04, F-17). Events are written to an outbox in the same database transaction as the state change (ADR-06, F-20).

---

## 3. Domain Model & Multi-Tenancy

### 3.1 RequestContext

The core operates only on this object. It is built by a context resolver per ingress profile and is immutable.

```typescript
export type ActorType = "user" | "service";

export interface RequestContext {
  namespace: string;                 // "esma-tenant" | "esma-admin" | any registered API client namespace
  tenantId: string;                  // required. "system" for global/admin scope
  subTenantId?: string;              // e.g. branchId, departmentId
  actor: {
    id: string;                      // token.userId ?? `token:${schoolId}` ; API client id for services
    type: ActorType;
    roles: string[];                 // normalized from token.role or token.roles
    scopes: string[];                // API key scopes, e.g. files:write
  };
  correlationId: string;             // from x-correlation-id if valid, else generated UUIDv7
  ipAddress: string;                 // requires app.set("trust proxy", ...) (see P1-15)
  userAgent?: string;
  attributes: Readonly<Record<string, string>>; // client-supplied, UNTRUSTED, max 20 keys, 256 chars each
}
```

Changes from v1 (F-32): `tenantId` is required; `userId` becomes `actor.id` with a defined fallback because the current `TokenPayload.userId` is optional; `role` and `roles` are normalized; `metadata: any` becomes `attributes`, explicitly untrusted and size-limited.

### 3.2 Ingress profiles

All requests arrive at `/api/v1/files/*` and are resolved into a `RequestContext` by the unified context resolver:

| Ingress | Resolver | Namespace | tenantId | subTenantId | Auth |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/v1/files/*` (User token) | `OidcContextResolver` | `token.organizationId ? "esma-tenant" : "esma-admin"` | `token.organizationId ?? "system"` | `token.branches[0]?.id` (or query filter within user's branch grants) | OIDC Bearer JWT (RS256 via Identity Service JWKS) |
| `/api/v1/files/*` (API key) | `ApiKeyContextResolver` | bound to credential | bound to credential | optional `x-sub-tenant-id` | API key `gus_<prefix>_<secret>` |

**Rule (F-25, ADR-12):** Credentials strictly bind the caller to their allowed `tenantId` and `subTenantId`. A caller with an Identity token for School A (`organizationId = SCH_A`) cannot view or modify assets belonging to School B. Platform admins (`token.platformAdmin = true`) or SuperAdmins (`access.organization.roles` contains `SUPER ADMIN`) operate at `system` scope.

### 3.3 Storage key scheme

`storage_key` is driver-agnostic and generated by `KeyService` (never from user input):

| Scope | Key Pattern |
| :--- | :--- |
| Organization/School scope | `tenants/{tenantId}/{folder}/{fileId}{ext}` |
| Branch scope | `tenants/{tenantId}/branches/{subTenantId}/{folder}/{fileId}{ext}` |
| System/Admin scope | `system/{folder}/{fileId}{ext}` |

Rules:

- Each path component must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and must not be `.` or `..`. Anything else is rejected with `VALIDATION_FAILED`.
- The client filename is stored in `original_filename` only. It never enters a key.
- `ext` comes from the **detected** MIME type through an allowlist map, not from the client filename.
- Provider mapping: Cloudinary prepends `CLOUDINARY_ROOT_FOLDER` (default `uploads`). SeaweedFS uses `{SEAWEEDFS_BUCKET}/{key}`. Local uses `{LOCAL_STORAGE_PATH}/{key}`.

### 3.4 Upload policies

A policy is selected by namespace (fallback: `generic-default`). Policies live in code in `esma-upload-service-v2/src/policies/` and are typed:

```typescript
export type Visibility = "private" | "tenant" | "public";
export type ProviderName = "local" | "seaweedfs" | "cloudinary";

export interface UploadPolicy {
  namespace: string;
  maxFileSizeBytes: number;                 // default 20 MiB
  maxFilesPerRequest: number;               // 10
  allowedMimeTypes: readonly string[];      // detected types, exact match
  defaultVisibility: Visibility;
  allowedVisibilities: readonly Visibility[];
  storage?: { primary?: ProviderName; replicas?: readonly ProviderName[] | "auto" };
  cloudinaryReplication: "never" | "public-only" | "always";
  cloudinaryRootFolder: string;
  requireVirusScan: boolean;
  fieldRules?: Record<string, { maxCount: number }>; // multi-field endpoints
}
```

---

## 4. Security Model

### 4.1 Authentication

| Credential | Verification | Source of Truth |
| :--- | :--- | :--- |
| Identity Service Bearer JWT (RS256) | Asymmetric signature verification using live JWKS (`https://api.esma.elsoft.ng/identity/oauth2/jwks`), caching public keys with `jwks-rsa`. Requires valid `exp`, matching `iss`, and non-empty `sub`. | ESMA Central Identity Service (`https://api.esma.elsoft.ng/identity`) |
| API key `gus_<prefix>_<secret>` | Lookup by `key_prefix`, SHA-256 of secret compared with `timingSafeEqual` against `api_clients.key_hash`, then status, expiry, scopes. Secret shown once at creation. | PostgreSQL table `api_clients` |

### 4.2 Authorization matrix (target)

`esma-tenant`. Where legacy behavior was more permissive, P1-14 records the documented behavior first and P1-10 defines the deliberately tighter v2 rule.

| Action | School-level token (no `branchId`) | Branch-level token | Missing or invalid token |
| :--- | :--- | :--- | :--- |
| Upload at school scope | Allow | Deny (`FORBIDDEN`) | 401 |
| Upload at branch B | Allow | Allow only if B equals token branch | 401 |
| List school scope | Allow | Deny | 401 |
| List branch B | Allow | Allow only if B equals token branch | 401 |
| Delete file | Allow if `file.tenant_id` equals token school | Allow only if `file.sub_tenant_id` equals token branch | 401 |
| Read file (`tenant` visibility) | Same school | Same school | Signed URL only |

`esma-admin`: every route requires a valid JWT whose role is in `ADMIN_ALLOWED_ROLES` (default `superadmin`).

Generic: scopes `files:write`, `files:read`, `files:delete`, `files:admin`. Tenant access is the intersection of the key's tenant list and the requested tenant.

Implementation: a pure function `authorize(ctx, action, resource): Decision` in `esma-upload-service-v2/src/authz/`, table-driven and unit tested against this matrix (P1-10).

### 4.3 Visibility and signed URLs

| Visibility | Who can read `GET /api/v1/files/:fileId` |
| :--- | :--- |
| `public` | Anyone with the URL. |
| `tenant` | Any authenticated actor in the same namespace and tenant. |
| `private` | Uploader, or actors with role `admin`/`superadmin` in the same tenant, or holders of a valid signed URL. |

Signed URL: `GET /api/v1/files/:fileId?exp=<unix>&disp=<inline|attachment>&sig=<base64url>` where `sig = HMAC-SHA256(SIGNED_URL_SECRET, "v1|fileId|exp|disp")`. Maximum TTL `SIGNED_URL_MAX_TTL_SECONDS` (default 900). Minted via `POST /api/v1/files/:fileId/signed-url`. This is what makes `<img src>` and downloads work without a bearer header (F-24). `SIGNED_URL_SECRET` must differ from `JWT_SECRET`.

Provider delivery rules (F-26):

- `private` and `tenant` files are never written to Cloudinary with public delivery. Policy `cloudinaryReplication: "public-only"` skips them.
- Redirects go only to URLs the caller can actually reach: a Cloudinary CDN URL for `public` files, or a short-lived S3 presigned URL when `SEAWEEDFS_PUBLIC_ENDPOINT` is configured. Otherwise the service streams the bytes itself.

### 4.4 Upload validation pipeline (synchronous unless marked)

1. Authenticate and authorize **before** any body is read (F-41).
2. Enforce `Content-Length` against policy, and enforce the limit again while streaming.
3. Stage to a private directory outside any served path (`STAGING_DIR`, default `/tmp/gus-staging`, ADR-09).
4. Detect the real type from magic bytes (`file-type`). Reject if the detected type is not in `allowedMimeTypes`. Reject if the declared MIME or extension contradicts the detected type. SVG, HTML and executables are never allowed.
5. Compute `sha256` and byte count while reading the staged file. (`files.sha256` is nullable only for assets imported by the legacy backfill, which are hashed later by the replication worker.)
6. Sanitize `original_filename` (strip path separators and control characters, cap at 255 bytes).
7. Persist and respond (fast path).
8. **Asynchronous:** virus scan (ClamAV) when `requireVirusScan` is true. `scan_status=PENDING` blocks reads until `CLEAN` (F-13, ADR-15).
9. Always remove the staged file in a `finally`/`res.on("close")` handler, on success and on every error path (F-04).

### 4.5 Response hardening for file delivery

Every content response sets `X-Content-Type-Options: nosniff`, `Content-Disposition` (default `inline` only for images and PDFs, else `attachment`), a `Content-Type` taken from the **stored detected type**, `Cache-Control` (`public, max-age=86400` for public, `private, no-store` otherwise), `Accept-Ranges: bytes`, and `Content-Security-Policy: sandbox` for user content.

---

## 5. Data Model

PostgreSQL is the system of record (ADR-01). Redis holds only rate-limit counters and cache. All migrations are forward-only SQL files under `esma-upload-service-v2/src/db/migrations/`.

### 5.1 Schema (initial migration set)

```sql
CREATE TABLE files (
  id                 uuid        PRIMARY KEY,                       -- UUIDv7, generated in app
  namespace          text        NOT NULL,
  tenant_id          text        NOT NULL,
  sub_tenant_id      text,
  folder             text        NOT NULL DEFAULT '',
  storage_key        text        NOT NULL,
  original_filename  text        NOT NULL,
  mimetype           text        NOT NULL,                          -- detected
  declared_mimetype  text,
  size_bytes         bigint      NOT NULL CHECK (size_bytes >= 0),
  sha256             char(64),                                      -- NULL only for backfilled legacy assets until hashed (P4-07)
  visibility         text        NOT NULL CHECK (visibility IN ('private','tenant','public')),
  status             text        NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE','QUARANTINED','DELETING','DELETED')),
  scan_status        text        NOT NULL DEFAULT 'NOT_REQUIRED'
                     CHECK (scan_status IN ('NOT_REQUIRED','PENDING','CLEAN','INFECTED','ERROR')),
  replication_status text        NOT NULL DEFAULT 'NOT_REQUIRED'
                     CHECK (replication_status IN ('NOT_REQUIRED','QUEUED','IN_PROGRESS','SYNCED','PARTIAL','FAILED')),
  primary_provider   text        NOT NULL CHECK (primary_provider IN ('local','seaweedfs','cloudinary')),
  uploaded_by        text        NOT NULL,
  tags               text[]      NOT NULL DEFAULT '{}',
  attributes         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  legacy_public_id   text,
  idempotency_key    text,
  correlation_id     text        NOT NULL,
  version            integer     NOT NULL DEFAULT 1,                -- optimistic concurrency
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX files_legacy_public_id_uq ON files (legacy_public_id) WHERE legacy_public_id IS NOT NULL;
CREATE UNIQUE INDEX files_idem_uq ON files (namespace, tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX files_scope_created_idx ON files (namespace, tenant_id, sub_tenant_id, created_at DESC, id DESC) WHERE status <> 'DELETED';
CREATE INDEX files_folder_idx ON files (namespace, tenant_id, folder, created_at DESC);
CREATE INDEX files_sha_idx ON files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX files_repl_pending_idx ON files (updated_at) WHERE replication_status IN ('QUEUED','IN_PROGRESS','PARTIAL');
CREATE INDEX files_deleting_idx ON files (updated_at) WHERE status = 'DELETING';

CREATE TABLE file_replicas (
  file_id       uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  provider      text        NOT NULL CHECK (provider IN ('local','seaweedfs','cloudinary')),
  role          text        NOT NULL CHECK (role IN ('primary','secondary')),
  status        text        NOT NULL CHECK (status IN ('QUEUED','IN_PROGRESS','AVAILABLE','FAILED','DELETING','DELETED')),
  provider_key  text        NOT NULL,
  provider_meta jsonb       NOT NULL DEFAULT '{}'::jsonb,           -- e.g. {"resource_type":"raw","type":"upload"}
  url           text,                                               -- internal use; not returned to clients except public CDN URLs
  etag          text,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  synced_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, provider)
);
CREATE INDEX file_replicas_work_idx ON file_replicas (status, updated_at) WHERE status IN ('QUEUED','IN_PROGRESS','FAILED','DELETING');

CREATE TABLE outbox_events (
  id            uuid        PRIMARY KEY,
  topic         text        NOT NULL,                                -- logical topic: replication|processing|audit
  partition_key text        NOT NULL,
  event_type    text        NOT NULL,
  envelope      jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  available_at  timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  consumer      text        NOT NULL,
  event_id      uuid        NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE audit_log (
  id             uuid        PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  action         text        NOT NULL,       -- FILE_UPLOAD, FILE_READ, FILE_DELETE, FILE_LIST, AUTH_DENIED, ...
  outcome        text        NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  actor_id       text        NOT NULL,
  actor_type     text        NOT NULL,
  roles          text[]      NOT NULL DEFAULT '{}',
  namespace      text        NOT NULL,
  tenant_id      text,
  file_id        uuid,
  ip_address     inet,
  user_agent     text,
  correlation_id text        NOT NULL,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_tenant_time_idx ON audit_log (namespace, tenant_id, occurred_at DESC);
CREATE INDEX audit_file_idx ON audit_log (file_id, occurred_at DESC) WHERE file_id IS NOT NULL;
-- The application role gets INSERT and SELECT only on audit_log. No UPDATE, no DELETE.

CREATE TABLE api_clients (
  id               uuid        PRIMARY KEY,
  name             text        NOT NULL,
  key_prefix       text        NOT NULL UNIQUE,
  key_hash         text        NOT NULL,                             -- hex SHA-256 of the secret part
  namespace        text        NOT NULL,
  tenant_ids       text[]      NOT NULL DEFAULT '{}',
  allow_any_tenant boolean     NOT NULL DEFAULT false,
  scopes           text[]      NOT NULL,
  status           text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  expires_at       timestamptz,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);

CREATE TABLE tenant_usage (
  namespace   text        NOT NULL,
  tenant_id   text        NOT NULL,
  bytes_used  bigint      NOT NULL DEFAULT 0,
  file_count  bigint      NOT NULL DEFAULT 0,
  max_bytes   bigint,                     -- null = unlimited
  max_files   bigint,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, tenant_id)
);
```

Later migrations add `dead_letters` (P5-06) and `files.derivatives jsonb` (P5-08). Listing uses keyset pagination on `(created_at DESC, id DESC)`. The opaque cursor is base64url of `{createdAt, id}`. Offset pagination is not used.

### 5.2 State machines

**Replica** (`file_replicas.status`). Vocabulary is unified: `AVAILABLE`, not `SYNCED`, at replica level (F-10). All transitions are compare-and-set updates (`UPDATE ... WHERE status = $expected`).

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE: primary written at ingest
    [*] --> QUEUED: secondary planned at ingest
    QUEUED --> IN_PROGRESS: worker claims
    IN_PROGRESS --> AVAILABLE: copy verified
    IN_PROGRESS --> QUEUED: retryable failure
    IN_PROGRESS --> FAILED: attempts exhausted
    FAILED --> QUEUED: redrive
    QUEUED --> DELETED: file deleted before copy
    AVAILABLE --> DELETING: file delete requested
    IN_PROGRESS --> DELETING: file deleted during copy
    DELETING --> DELETED: driver delete ok
```

**File** (`files.status`): `ACTIVE -> DELETING -> DELETED`, and `ACTIVE -> QUARANTINED -> DELETING`. Reads are served only for `ACTIVE`. `scan_status` is independent: when a policy requires scanning, reads are blocked unless `scan_status = CLEAN`.

**Aggregate `replication_status`** is derived from secondary replicas only (primary excluded, `DELETED` excluded):

| Secondary replicas | Aggregate |
| :--- | :--- |
| none | `NOT_REQUIRED` |
| all `AVAILABLE` | `SYNCED` |
| all `QUEUED` | `QUEUED` |
| all `FAILED` | `FAILED` |
| no `QUEUED`/`IN_PROGRESS`, mix of `AVAILABLE` and `FAILED` | `PARTIAL` |
| anything else | `IN_PROGRESS` |

The derivation is one pure function with a truth-table unit test (P4-02).

---

## 6. Storage Layer

### 6.1 Driver interface (v2)

Changes from v1 (F-19): opaque `ProviderRef` with driver metadata (Cloudinary needs `resource_type`), a re-openable source so retries and replication can re-read, range reads, `stat` for post-copy verification, idempotent `delete`, paged `list`, capabilities, and transform options for image delivery.

```typescript
import type { Readable } from "node:stream";

export type ProviderName = "local" | "seaweedfs" | "cloudinary";

export interface ProviderRef {
  provider: ProviderName;
  key: string;                                // e.g. S3 object key, Cloudinary public_id, local relative path
  meta?: Record<string, unknown>;             // cloudinary: { resource_type, type }
}

export interface StorageUploadInput {
  key: string;                                // from KeyService
  source: () => Readable;                     // factory: can be called again on retry
  size: number;
  sha256: string;
  mimetype: string;
  visibility: Visibility;
  tags?: string[];
  attributes?: Record<string, string>;
}

export interface DriverUploadResult {
  ref: ProviderRef;
  size: number;
  etag?: string;
  url?: string;                               // provider URL, internal use unless public CDN
}

export interface ReadOptions { range?: { start: number; end?: number }; signal?: AbortSignal }
export interface StorageObjectStat { size: number; etag?: string; contentType?: string }

export interface DirectUrlOptions {
  expiresInSeconds?: number;
  disposition?: "inline" | "attachment";
  transform?: { width?: number; height?: number; format?: "auto" | "webp" | "jpg" | "png"; quality?: "auto" | number };
}

export interface DriverCapabilities {
  rangeReads: boolean;
  presignedUrls: boolean;
  publicCdn: boolean;
  imageTransforms: boolean;
  privateDelivery: boolean;
  maxObjectBytes?: number;
}

export interface DriverHealth { ok: boolean; latencyMs: number; detail?: string }

export interface IStorageDriver {
  readonly name: ProviderName;
  readonly capabilities: DriverCapabilities;
  isConfigured(): boolean;
  healthCheck(signal?: AbortSignal): Promise<DriverHealth>;
  upload(input: StorageUploadInput): Promise<DriverUploadResult>;
  downloadStream(ref: ProviderRef, opts?: ReadOptions): Promise<{ stream: Readable; size?: number; contentType?: string }>;
  stat(ref: ProviderRef): Promise<StorageObjectStat | null>;
  getDirectUrl(ref: ProviderRef, opts?: DirectUrlOptions): Promise<string | null>;  // null = not supported for this file
  delete(ref: ProviderRef): Promise<void>;                                          // idempotent
  list?(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<{ items: ProviderObjectInfo[]; nextCursor?: string }>;
}
```

`list` exists for reconciliation and migration tooling only. Public list endpoints read PostgreSQL, which also removes the dependence on Cloudinary Search and Admin API rate limits (F-52).

### 6.2 Drivers

| Driver | Library | Notes |
| :--- | :--- | :--- |
| `local` | `node:fs` | Atomic write (temp file plus `rename`), path-traversal guard (`resolved.startsWith(root + sep)`), file mode `0640`, `fs.createReadStream({start,end})` for ranges. Never served by a static route. |
| `seaweedfs` | `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` | Path-style S3 against the SeaweedFS S3 gateway. `PutObject` with known `ContentLength` (files are staged, so length is known); `lib-storage` multipart above 100 MiB. `HeadObject` for `stat`. Bucket existence is verified at startup, created only when `SEAWEEDFS_AUTO_CREATE_BUCKET=true`. |
| `cloudinary` | `cloudinary` v2 | `upload_stream` or `upload` from staged path with `resource_type: "auto"`; the resolved `resource_type` and delivery `type` are stored in `provider_meta`. Private/tenant files use `type: "authenticated"` if ever written. `delete` uses stored `resource_type`, removing today's three-way probing (F-53). Transform URLs (`f_auto`, `q_auto`) via `getDirectUrl({transform})`. |

### 6.3 Storage topology (replaces "HybridStorageDriver")

`StorageTopology` is resolved once at startup by `StoragePlacementService` from configuration:

```typescript
export interface StorageTopology {
  mode: "single" | "replicated";
  primary: ProviderName;
  primaryFailover: ProviderName[];          // ordered, tried if the primary is unhealthy or errors
  secondaries: ProviderName[];              // replication targets
}
```

Resolution rules:

| `STORAGE_DRIVER` | Result |
| :--- | :--- |
| `local` / `cloudinary` / `seaweedfs` | `mode=single`, that driver is primary, no secondaries. |
| `hybrid` | `mode=replicated`. `HYBRID_PRIMARY` (required), `HYBRID_PRIMARY_FAILOVER` (optional list), `HYBRID_REPLICAS` (list, or `auto`). |

- The primary is **deterministic**, not "the fastest responder" (F-18). One staged file cannot be raced across writers without duplicating I/O, and a non-deterministic primary makes behavior hard to reason about. Failover is ordered and explicit.
- `auto` means: every configured and healthy driver that is not the primary. It is convenient in development. In production `HYBRID_REPLICAS` should be explicit, and startup **fails** if a listed driver is unconfigured, unless `HYBRID_STRICT=false`. This stops a missing Cloudinary secret from silently dropping a replica.
- Per-file replica targets are `topology.secondaries` filtered by the namespace policy (`cloudinaryReplication`) and file visibility.
- Health probes run at startup and every `DRIVER_HEALTH_INTERVAL_SECONDS` (default 30). A cached result feeds `/health/ready` and primary selection.

### 6.4 Constraints

- **Local driver:** valid for development and single-node deployments only. A local *secondary* is written by whichever worker node picks up the job, so on multi-node deployments it lands on the wrong disk (F-27). Multi-node use requires a shared read-write volume, or the driver is excluded from `HYBRID_REPLICAS`. Startup logs a warning when `local` is combined with more than one `api` replica (`INSTANCE_COUNT_HINT`).
- **Cloudinary:** account plan limits on raw file size and total storage apply. `DriverCapabilities.maxObjectBytes` is read from `CLOUDINARY_MAX_OBJECT_BYTES`. Files above it are not planned for Cloudinary replication.
- **SeaweedFS:** production needs a replication setting on volumes (for example `-defaultReplication=001`) and real S3 identities. The `any/any` credentials in the v1 example are development only (F-33).

---

## 7. Core Flows

### 7.1 Upload (fast path)

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as API (auth, ingestion)
    participant Core as UploadService
    participant Place as StoragePlacement
    participant Pri as Primary driver
    participant DB as PostgreSQL
    participant Relay as Outbox relay
    participant Broker as Broker
    participant W as Replication worker
    participant Sec as Secondary driver

    Client->>API: POST multipart
    API->>API: authenticate, authorize, policy, rate limit
    API->>API: stage to private dir, sniff type, sha256
    API->>Core: upload(ctx, stagedFile, options)
    Core->>Place: plan(ctx, policy, file)
    Place-->>Core: primary, failover list, secondaries
    Core->>Pri: upload(source factory)
    alt primary fails
        Core->>Place: next failover driver
        Core->>Pri: upload to failover
    end
    Pri-->>Core: DriverUploadResult
    Core->>DB: one transaction: insert files, replicas, outbox events, usage
    Core-->>API: manifest
    API-->>Client: 201 Created (fileId, canonicalUrl, replicationStatus QUEUED)
    API->>API: delete staged file (always)
    Relay->>DB: poll unpublished (SKIP LOCKED)
    Relay->>Broker: publish
    Broker->>W: file.replicate
    W->>DB: claim replica (CAS QUEUED to IN_PROGRESS), check file ACTIVE
    W->>Pri: downloadStream
    W->>Sec: upload
    W->>Sec: stat and verify size
    W->>DB: replica AVAILABLE, recompute aggregate, outbox(file.replicated)
```

If the database commit fails after the primary write, `UploadService` deletes the primary object (compensation) and returns `503`. If that compensation fails, the orphan is logged with its key and picked up by the orphan scan in P4-10.

### 7.2 Read (`GET /api/v1/files/:fileId`)

```mermaid
flowchart TD
    A["Request"] --> B["Load file and replicas from DB"]
    B --> C{"status ACTIVE and scan allows?"}
    C -- "no" --> C1["404 / 403 FILE_QUARANTINED / 409 FILE_NOT_READY"]
    C -- "yes" --> D{"Authorized by visibility or valid signature?"}
    D -- "no" --> D1["401 / 403"]
    D -- "yes" --> E["Pick replica: requested provider if AVAILABLE, else best AVAILABLE by preference"]
    E --> F{"redirect allowed and driver can give a client-reachable URL?"}
    F -- "yes" --> G["302 to CDN URL or presigned URL"]
    F -- "no" --> H["Stream through service with Range support"]
    G --> I["Audit read"]
    H --> I
```

- Redirect is controlled by the query parameter `redirect=auto|always|never` (default `auto`). v1 described a `Redirect: follow` request header. That is a fetch-API option, not an HTTP header (F-24).
- Preference order for `auto`: `public` files go to Cloudinary if `AVAILABLE`, otherwise stream from primary. Non-public files always stream (or use a presigned SeaweedFS URL when a public S3 endpoint is configured).
- `?provider=x` is allowed for `files:admin` only. If that replica is not `AVAILABLE`, respond `409 REPLICA_NOT_AVAILABLE` with `Retry-After: 30` (v1 said "fall back or retry header" without choosing).
- If a chosen replica fails mid-request before headers are sent, try the next `AVAILABLE` replica.

### 7.3 Delete

1. Authorize. In one transaction set `files.status = DELETING`, set every non-`DELETED` replica to `DELETING` (or `DELETED` if still `QUEUED`), decrement `tenant_usage`, and insert `file.purge` into the outbox. Respond `204` immediately. The file is no longer readable.
2. The worker deletes each replica through its driver (idempotent), marks replicas `DELETED`, then sets `files.status = DELETED`, `deleted_at = now()`, and emits `file.deleted`.
3. Replication handlers must check `files.status = ACTIVE` after claiming a job and abort otherwise. This prevents a late replication from resurrecting a deleted file (F-23).
4. A retention job hard-deletes `DELETED` tombstones older than `TOMBSTONE_RETENTION_DAYS` (default 30).

---

## 8. Event Pipeline

### 8.1 Envelope (v2)

```typescript
export interface EventEnvelope<T = unknown> {
  eventId: string;            // UUIDv7, used for dedup
  eventType: string;          // see catalog
  schemaVersion: number;      // starts at 1
  timestamp: string;          // ISO 8601
  correlationId: string;
  causationId?: string;       // eventId that caused this event
  namespace: string;
  tenantId: string;
  partitionKey: string;       // fileId (ADR-07)
  attempt: number;            // 0 on first delivery
  payload: T;
}
```

### 8.2 Catalog

Commands are instructions for a specific consumer. Events are facts.

| Type | Kind | Topic | Producer | Consumer | Payload (key fields) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `file.replicate` | command | replication | UploadService, sweeper, redrive | replication worker | `fileId`, `targetProvider` |
| `file.purge` | command | replication | DeleteService | replication worker | `fileId` |
| `file.scan` | command | processing | UploadService | processing worker | `fileId` |
| `file.process` | command | processing | UploadService or `file.uploaded` handler | processing worker | `fileId`, `operations[]` |
| `file.uploaded` | event | audit | UploadService | audit sink, subscribers | `fileId`, `size`, `mimetype`, `primaryProvider` |
| `file.replicated` | event | audit | replication worker | audit sink, subscribers | `fileId`, `provider` |
| `file.replication_failed` | event | audit | replication worker | audit sink, alerting | `fileId`, `provider`, `error` |
| `file.deleted` | event | audit | replication worker | audit sink, subscribers | `fileId` |
| `file.scanned` | event | audit | processing worker | audit sink | `fileId`, `result` |
| `file.processed` | event | audit | processing worker | subscribers | `fileId`, `derivatives[]` |

### 8.3 Topics (one logical name, two physical mappings) (F-09)

| Logical | Kafka | Pulsar |
| :--- | :--- | :--- |
| `replication` | `esma.files.replication` (+ `.retry.10s`, `.retry.1m`, `.retry.10m`) | `persistent://esma/uploads/replication` |
| `processing` | `esma.files.processing` (+ retry tiers) | `persistent://esma/uploads/processing` |
| `audit` | `esma.files.audit` | `persistent://esma/uploads/audit` |
| `dlq` | `esma.files.dlq` | `persistent://esma/uploads/dlq` |

Code uses only logical names. A single `TopicMap` module owns the physical mapping.

### 8.4 Transactional outbox (F-20)

- `UploadService`, `DeleteService` and the worker write events into `outbox_events` in the same transaction as the state change.
- The relay (in `worker`) runs: `SELECT ... FROM outbox_events WHERE published_at IS NULL AND available_at <= now() ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED`, publishes, then sets `published_at`. On failure it increments `attempts` and pushes `available_at` out with backoff.
- Delivery is **at-least-once**. Duplicates are expected and handled by consumers.
- A retention job deletes published rows older than `OUTBOX_RETENTION_HOURS` (default 72).

### 8.5 Broker interface (v2) and consumer framework (F-22)

```typescript
export interface PublishOptions { headers?: Record<string, string>; deliverAfterMs?: number }

export type HandlerOutcome =
  | { kind: "ack" }
  | { kind: "retry"; delayMs?: number; reason: string }
  | { kind: "dead-letter"; reason: string };

export interface SubscribeOptions {
  consumerGroup: string;
  concurrency: number;
  maxAttempts: number;
}

export interface IMessageBroker {
  readonly name: "memory" | "kafka" | "pulsar";
  initialize(): Promise<void>;
  publish<T>(topic: LogicalTopic, partitionKey: string, event: EventEnvelope<T>, opts?: PublishOptions): Promise<void>;
  subscribe<T>(topic: LogicalTopic, opts: SubscribeOptions,
               handler: (event: EventEnvelope<T>, meta: DeliveryMeta) => Promise<HandlerOutcome>): Promise<Subscription>;
  healthCheck(): Promise<boolean>;
  disconnect(): Promise<void>;                 // drains in-flight handlers first
}
```

The consumer framework wraps handlers. Handlers throw `RetryableError` or `PermanentError` (or return an outcome). The framework maps that to the broker's retry mechanism, enforces the retry policy, and sends exhausted or permanent failures to `dlq` with headers (`x-original-topic`, `x-error`, `x-attempts`, `x-first-failed-at`).

Retry policy (both brokers, identical observable behavior): `REPLICATION_MAX_ATTEMPTS=6`, exponential backoff base 10 s, factor 3, jitter plus or minus 20 percent, cap 30 minutes.

Idempotency: replication handlers use compare-and-set on `file_replicas`. Handlers with other side effects record `(consumer, event_id)` in `processed_events` inside the same transaction.

### 8.6 Kafka driver

- Library: chosen in spike P5-01. `kafkajs` was the v1 choice, but to my knowledge it has had no release since 2023. Candidates to evaluate: `@confluentinc/kafka-javascript`, `@platformatic/kafka`. Verify current maintenance status before deciding (F-30).
- Partition key: `fileId` (F-21). Ordering per file is what correctness needs (`replicate` before `purge`). v1's tenant key creates hot partitions for large tenants and gives ordering nobody uses.
- Retry: tiered retry topics with a `x-not-before` header. Retry consumers pause the partition until due, so delayed messages never block the main topic.
- Producer: `acks=all`, idempotent producer on. Consumer: manual offset commit after outcome handling.
- Topic provisioning: an `ensureTopics()` step at startup in dev, and an explicit script for production.

### 8.7 Pulsar driver

- Library: `pulsar-client`, which wraps a native C++ client. Prebuilt binaries and the arm64 Debian image (the CI target is `linux/arm64`) must be verified in spike P5-03 (F-30).
- Subscription: `Key_Shared` for replication and processing, keyed by `fileId`. v1's `Failover` for "strict singleton" is dropped: it contradicts horizontal scaling and is unnecessary once handlers are idempotent (F-21).
- Retry and DLQ: use the client's dead-letter policy and negative-ack redelivery delay, or retry letter topic if the Node client supports it. The spike documents which primitives exist and how the drivers meet the identical-behavior requirement.
- Deduplication: enable namespace-level broker dedup and set the message `sequenceId`/producer name so `eventId` retries collapse. Application-level idempotency remains the source of truth.

### 8.8 Memory broker

For development and unit/integration tests only. In-process, supports retry delays and DLQ, and is the reference implementation of the contract test suite (P5-05). It is refused when `NODE_ENV=production` unless `ALLOW_MEMORY_BROKER=true`.

---

## 9. API Contracts

### 9.1 v1 endpoints

| Method | Path | Scope | Description |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/files/upload` | `files:write` | Multipart. Field `file` (one or more). Optional fields: `folder`, `visibility`, `tags` (JSON array), `attributes` (JSON object). Header `Idempotency-Key` optional. Returns `201` (all ok) or `207` (partial, per-file results). |
| `POST` | `/api/v1/files/presigned-upload` | `files:write` | **[NEWLY ADDED]** Initiate direct-to-storage upload for large files. Body `{ filename, sizeBytes, mimeType, branchId?, folder?, visibility? }`. Validates quota/branch and returns `{ fileId, uploadUrl, requiredHeaders, expiresAt }`. |
| `POST` | `/api/v1/files/:fileId/complete-upload` | `files:write` | **[NEWLY ADDED]** Finalize direct-to-storage upload after client PUT completes. Verifies object existence via `HeadObject`, registers replica as `AVAILABLE`, commits quota, and returns file manifest. |
| `GET` | `/api/v1/files` | `files:read` | Filters: `folder`, `subTenantId`, `mimetype`, `tag`, `createdFrom`, `createdTo`. `limit` (max 100), `cursor`. |
| `GET` | `/api/v1/files/:fileId` | per visibility | Content (stream or redirect). Query: `redirect`, `disp`, `exp`, `sig`, `provider` (admin). Supports `Range`. |
| `GET` | `/api/v1/files/:fileId/metadata` | `files:read` | Manifest without bytes. |
| `POST` | `/api/v1/files/:fileId/signed-url` | `files:read` | Body `{ttlSeconds, disposition}`. Returns `{url, expiresAt}`. |
| `DELETE` | `/api/v1/files/:fileId` | `files:delete` | `204`. Asynchronous purge. |
| `POST` | `/api/v1/files/bulk-delete` | `files:delete` | Body `{fileIds: string[]}` (max 100). Replaces `DELETE` with a body, which some proxies strip (F-36). |
| `POST` | `/api/v1/files/:fileId/replicate` | `files:admin` | Re-drive replication for failed replicas. |
| `GET` | `/api/v1/admin/replication` | `files:admin` | Counts by replica status, oldest queued age, DLQ depth. |
| `GET` | `/health/live`, `/health/ready` | none | Liveness, and readiness (DB, primary driver, broker when enabled). |
| `GET` | `/health/drivers` | `files:admin` | Detailed driver health. |

### 9.2 Manifest

The upload response and `metadata` share one schema. Corrections from v1 (F-11, F-12): a real hash, UUIDv7, no internal URLs, one `primaryProvider` field instead of a `primary` object duplicating `replicas`, and a sample that matches the fast-path (only the primary is written synchronously).

Upload response, `201`:

```json
{
  "success": true,
  "message": "File uploaded. Replication to secondary storage is queued.",
  "data": {
    "fileId": "0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90",
    "filename": "academic_report_2026.pdf",
    "mimetype": "application/pdf",
    "size": 2458902,
    "sha256": "9f2b5c0a1d7e4b6a8c3f0e1d2a4b6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c",
    "visibility": "tenant",
    "canonicalUrl": "https://upload.esma.example/api/v1/files/0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b90",
    "publicUrl": null,
    "primaryProvider": "seaweedfs",
    "replicas": {
      "seaweedfs":  { "status": "AVAILABLE", "syncedAt": "2026-09-21T12:00:00.120Z" },
      "local":      { "status": "QUEUED",    "syncedAt": null },
      "cloudinary": { "status": "SKIPPED_BY_POLICY", "syncedAt": null }
    },
    "replicationStatus": "QUEUED",
    "scanStatus": "NOT_REQUIRED",
    "createdAt": "2026-09-21T12:00:00.125Z"
  }
}
```

`SKIPPED_BY_POLICY` is a response-only value for targets excluded by policy or visibility. It is not stored. `publicUrl` is set only for `public` files once a CDN replica is `AVAILABLE`. The sample hash above is illustrative. The value in v1 was the SHA-256 of an empty input.

### 9.3 Error envelope (v1 only)

`Content-Type: application/problem+json` (RFC 9457):

```json
{
  "type": "https://errors.esma.example/gus/file-too-large",
  "title": "File too large",
  "status": 413,
  "code": "FILE_TOO_LARGE",
  "detail": "File exceeds the 20971520 byte limit for namespace esma-tenant.",
  "correlationId": "0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b91",
  "errors": []
}
```

Codes: `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `TENANT_MISMATCH` 403, `FILE_NOT_FOUND` 404, `FILE_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `MIME_MISMATCH` 415, `VALIDATION_FAILED` 422, `RATE_LIMITED` 429, `QUOTA_EXCEEDED` 403, `IDEMPOTENCY_CONFLICT` 409, `FILE_NOT_READY` 409, `REPLICA_NOT_AVAILABLE` 409, `FILE_QUARANTINED` 403, `STORAGE_UNAVAILABLE` 503, `INTERNAL` 500. Legacy-facade routes reproduce the documented legacy error shapes (captured in P1-14).

### 9.4 Legacy Facade Retirement (2026-09-23)

> **Decision:** The legacy Express facades (`/api/tenant/upload/*` and `/api/admin/upload/*`) have been retired. All uploads and file queries are now routed directly through `/api/v1/files/*`.

Previous plans maintained additive facades for backward compatibility. Because client applications are adopting the centralized ESMA Identity Service (`https://api.esma.elsoft.ng/identity`), all clients integrate directly with the unified `/api/v1/files/*` endpoint suite:

| Historical Legacy Route | Modern Replacement |
| :--- | :--- |
| `POST /api/tenant/upload/single`, `/multiple`, `/multiple-fields` | `POST /api/v1/files/upload` (multipart with folder, tags, attributes) |
| `GET /api/tenant/upload/files/:schoolId[/:branchId]` | `GET /api/v1/files?subTenantId=...` (automatically scoped to caller's `organizationId`) |
| `DELETE /api/tenant/upload/files/:publicId` | `DELETE /api/v1/files/:fileId` |
| `POST /api/admin/upload/single`, `/multiple`, `/fields` | `POST /api/v1/files/upload?folder=...` |
| `GET /api/admin/upload/files`, `GET /file/:publicId` | `GET /api/v1/files`, `GET /api/v1/files/:fileId/metadata` |
| `DELETE /api/admin/upload/file/:publicId`, `DELETE /files` | `DELETE /api/v1/files/:fileId`, `POST /api/v1/files/bulk-delete` |

### 9.5 Direct-to-Storage Presigned Upload Flow (NEWLY ADDED)

> **Status:** Newly added specification for large files, videos, and bulk archive assets.

For large files (>100 MiB), streaming the payload through the application server incurs unnecessary memory, CPU, and proxy bandwidth overhead. The direct-to-storage flow allows clients to upload bytes directly to the primary storage engine (SeaweedFS S3 gateway or S3-compatible backend) via a time-limited presigned URL while preserving all security, quota, and branch isolation guarantees.

```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant API as Upload Service API
    participant DB as PostgreSQL
    participant S3 as SeaweedFS S3 Gateway

    Note over Client,API: Step 1: Initiate & Reserve
    Client->>API: POST /api/v1/files/presigned-upload<br/>{ filename, sizeBytes, mimeType, branchId?, folder?, visibility? }
    API->>API: Authenticate, authorize branch (evaluateBranchAccess), check quota
    API->>DB: Insert files record (status: PENDING_UPLOAD)
    API->>S3: Generate S3 Presigned PUT URL (getSignedUrl with PutObjectCommand)
    API-->>Client: 201 Created { fileId, uploadUrl, requiredHeaders, expiresAt }

    Note over Client,S3: Step 2: Direct Upload
    Client->>S3: PUT [uploadUrl]<br/>(Sends file payload directly to storage with Content-Type)
    S3-->>Client: 200 OK (ETag header)

    Note over Client,API: Step 3: Confirmation & Commit
    Client->>API: POST /api/v1/files/:fileId/complete-upload<br/>{ clientEtag? }
    API->>S3: HeadObjectCommand(key) to verify existence & actual length
    API->>DB: In transaction: update file status to AVAILABLE,<br/>insert file_replicas primary row, commit tenant_usage,<br/>enqueue replication outbox event (file.uploaded)
    API-->>Client: 200 OK (Standard File Manifest)
```

#### Protocol Details:
1. **Initiate (`POST /api/v1/files/presigned-upload`)**:
   - Scope: `files:write`
   - Request Body:
     ```json
     {
       "filename": "annual_science_fair_2026.mp4",
       "sizeBytes": 524288000,
       "mimeType": "video/mp4",
       "branchId": "branch-north",
       "folder": "media",
       "visibility": "tenant"
     }
     ```
   - Validation & Security:
     - Target `branchId` validated against caller's token grants via `evaluateBranchAccess()`.
     - `mimeType` validated against namespace upload policy allowlist.
     - `sizeBytes` checked against tenant quota (must not exceed available limit).
     - Storage key constructed deterministically via `KeyService.build()`.
   - Output:
     ```json
     {
       "success": true,
       "data": {
         "fileId": "0198f3a2-7c1e-7b40-9d2a-5e6f1a8c3b99",
         "uploadUrl": "https://s3.esma.example/esma-uploads/tenants/sch_01/branches/branch-north/media/0198f3a2...mp4?X-Amz-Signature=...",
         "requiredHeaders": {
           "Content-Type": "video/mp4"
         },
         "expiresAt": "2026-09-26T16:30:00.000Z"
       }
     }
     ```

2. **Complete (`POST /api/v1/files/:fileId/complete-upload`)**:
   - Scope: `files:write`
   - Action:
     - Issues `HeadObject` to SeaweedFS to verify object existence and exact byte size.
     - Commits file status from `PENDING_UPLOAD` to `AVAILABLE`.
     - Records primary replica in `file_replicas`.
     - Updates `tenant_usage` accounting for actual bytes stored.
     - Emits `file.uploaded` outbox event for asynchronous replication to secondary drivers.
   - Output: Returns standard file manifest (`200 OK`).

3. **Orphan & Incomplete Upload Sweeping**:
   - Files lingering in `PENDING_UPLOAD` past `expiresAt + gracePeriod` are automatically purged by the retention worker, removing reserved rows and uncommitted storage keys.

---

## 10. Configuration Reference (`.env.example`)

> Place this file at `esma-upload-service-v2/.env` for local development. **Never commit real secrets, and never reuse a value that appeared in project documentation.** (F-40, P1-02)

All values are placeholders. Real secrets never appear in documentation or the repository (F-40). Configuration is parsed and validated by one typed module at startup (P1-02); invalid or missing required values abort the process.

```env
# --- Application ---
NODE_ENV=development                # lowercase: development | test | production
PORT=7030                           # current service port (v1 docs said 5000; see F-01)
APP_BASE_URL=http://localhost:7030
LOG_LEVEL=info
TRUST_PROXY=loopback                # trust-proxy setting on the underlying Express adapter (app.set("trust proxy", ...))
CORS_ALLOWED_ORIGINS=http://localhost:3000
SWAGGER_ENABLED=true                # must be false in production unless gated
INSTANCE_COUNT_HINT=1

# --- Auth ---
JWT_SECRET=                         # generate: openssl rand -base64 48 (never commit)
JWT_ALGORITHMS=HS256
JWT_CLOCK_TOLERANCE_SECONDS=5
ADMIN_ALLOWED_ROLES=superadmin
ADMIN_AUTH_MODE=enforce             # off | report | enforce (report only for one release, P1-09)
SIGNED_URL_SECRET=                  # different from JWT_SECRET
SIGNED_URL_MAX_TTL_SECONDS=900

# --- Database and cache ---
DATABASE_URL=postgres://gus:gus@localhost:5432/gus
DATABASE_POOL_MAX=10
REDIS_URL=redis://localhost:6379

# --- Ingestion ---
STAGING_DIR=/tmp/gus-staging
STAGING_MAX_AGE_MINUTES=60
DEFAULT_MAX_FILE_SIZE_BYTES=20971520

# --- Storage selection: local | cloudinary | seaweedfs | hybrid ---
STORAGE_DRIVER=cloudinary
HYBRID_PRIMARY=seaweedfs
HYBRID_PRIMARY_FAILOVER=local
HYBRID_REPLICAS=cloudinary,local    # or "auto"
HYBRID_STRICT=true
DRIVER_HEALTH_INTERVAL_SECONDS=30

# --- Local driver (dev / single node only) ---
LOCAL_STORAGE_PATH=/data/storage    # must NOT be under a served path or the staging dir

# --- SeaweedFS S3 gateway ---
SEAWEEDFS_S3_ENDPOINT=http://localhost:8333
SEAWEEDFS_PUBLIC_ENDPOINT=          # optional, client-reachable endpoint for presigned redirects
SEAWEEDFS_BUCKET=esma-uploads
SEAWEEDFS_ACCESS_KEY=               # dev: any value. prod: a real identity
SEAWEEDFS_SECRET_KEY=
SEAWEEDFS_REGION=us-east-1
SEAWEEDFS_AUTO_CREATE_BUCKET=false

# --- Cloudinary ---
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
CLOUDINARY_ROOT_FOLDER=uploads       # default root for generic namespaces; esma-tenant and esma-admin roots are fixed by policy
CLOUDINARY_MAX_OBJECT_BYTES=10485760

# --- Event pipeline: memory | kafka | pulsar ---
EVENT_BROKER=memory
ALLOW_MEMORY_BROKER=false
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=esma-upload-service
KAFKA_GROUP_ID=esma-upload-workers
PULSAR_SERVICE_URL=pulsar://localhost:6650
PULSAR_AUTH_TOKEN=
PULSAR_TENANT=esma
PULSAR_NAMESPACE=uploads

# --- Workers ---
WORKER_ROLES=relay,replication,processing,sweeper
REPLICATION_MAX_ATTEMPTS=6
REPLICATION_CONCURRENCY=4
OUTBOX_RETENTION_HOURS=72
TOMBSTONE_RETENTION_DAYS=30
CLAMAV_HOST=
CLAMAV_PORT=3310

# --- Rollout flags (removed in P6-10) ---
LEGACY_ENGINE=legacy                # legacy | core
LEGACY_DEFAULT_VISIBILITY=public
```

---

## 11. Deployment Topology

`docker-compose.yml` (full stack, P6-05) uses profiles so developers start only what they need.

| Service | Profile | Purpose | Host port note |
| :--- | :--- | :--- | :--- |
| `api` | default | Upload API | 7030 |
| `worker` | default | Relay, replication, processing, sweeper | none |
| `migrate` | default | Runs migrations, exits | none |
| `postgres` | default | System of record (v1 compose omitted it, F-14) | 5432 |
| `redis` | default | Rate limits, quota cache | 6379 |
| `seaweedfs` (master, volume, filer, s3) | `seaweedfs` | Primary storage | S3 8333, master 9333, filer 8888. Volume server default 8080 collides with Pulsar's admin port: remap one. |
| `kafka` (KRaft) | `kafka` | Broker | 9092 |
| `pulsar` (standalone) | `pulsar` | Broker | 6650, admin remapped |
| `clamav` | `scan` | Virus scanning | 3310 |

Production notes: the deploy host today is a single arm64 server reached over SSH by the GitLab job. The `restart` script in `~/server-setup/esma` must be updated to run `migrate` before starting new `api` and `worker` containers (P6-06). Images must build for `linux/arm64`, and for `linux/amd64` for developers.

---

## 12. Observability & Targets

- Logs: JSON via `pino`, always with `correlationId`, `namespace`, `tenantId`, `fileId` when known. Never log tokens, API keys, secrets or file contents.
- Metrics (`/metrics`, gated): `gus_upload_duration_seconds{namespace,provider}`, `gus_upload_bytes_total`, `gus_upload_failures_total{code}`, `gus_replication_lag_seconds`, `gus_replica_status{provider,status}`, `gus_outbox_pending`, `gus_dlq_depth`, `gus_driver_health{provider}`, `gus_http_requests_total`.
- Tracing: OpenTelemetry, context propagated in event headers so an upload and its replication share a trace.
- Initial targets, to be validated in P6-08 and adjusted: p95 fast-path latency for a 5 MiB file under 1.5 s on the reference server; p95 replication lag under 60 s; API availability 99.9 percent monthly.

---

## 13. Revised Roadmap

### 13.1 Why the order changed (F-05)

v1 put the metadata store in Phase 5, but the canonical route (Phase 3) and the fast-path manifest cannot exist without it. v1 also had the hybrid engine publish events one phase before any broker existed, and moved legacy routes onto a generic controller before any storage abstraction existed. v1 said nothing about the known security defects. The order below removes those dependency inversions.

```mermaid
gantt
    title ESMA Upload Service Roadmap v2 (working days, three parallel tracks, phases sequential)
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d
    excludes    weekends
    section Phase 1 Foundation
    15 tasks        :p1, 2026-09-22, 24d
    section Phase 2 Storage and core
    8 tasks         :p2, after p1, 19d
    section Phase 3 API and facades
    6 tasks         :p3, after p2, 12d
    section Phase 4 Replication engine
    10 tasks        :p4, after p3, 25d
    section Phase 5 Kafka and Pulsar
    9 tasks         :p5, after p4, 8d
    section Phase 6 Production readiness
    10 tasks        :p6, after p5, 12d
```

How to read the numbers (they are planning estimates, not commitments):

| Phase | Tasks | Effort (person-days) | Longest dependency chain (days) | Calendar with 3 tracks (working days) |
| :--- | :--- | :--- | :--- | :--- |
| 1 Foundation | 15 | about 42 | 24 | 24 |
| 2 Storage and core | 8 | 28 | 19 | 19 |
| 3 API and facades | 6 | 23 | 12 | 12 |
| 4 Replication engine | 10 | 37 | 25 | 25 |
| 5 Kafka and Pulsar | 9 | 24 | 6 | 8 |
| 6 Production readiness | 10 | 37 | 10 | 12 |
| **Total** | **58** | **about 191** | | **about 100** |

- One developer or agent working alone: about 191 working days (roughly 38 weeks).
- Three tracks with strict phase order: about 100 working days (roughly 20 weeks), as charted.
- Overlapping phases where dependencies allow (for example the Kafka and Pulsar spikes P5-01 and P5-03 start in Phase 1, drivers start once P2-01 lands): the longest overall dependency chain is about 43 working days, so a realistic target with three well-coordinated tracks is 13 to 17 weeks.
- Effort weights used: XS 0.25, S 1, M 2.5, L 4.5 person-days. Phase 5 has a short chain because most of its tasks can run in parallel once the consumer framework exists.
- There is no Phase 0. Every requirement that a "stabilize the legacy app first" phase would have covered (secret hygiene, auth-before-parsing, tenant-scope correctness, validation hardening, HTTP/platform hardening) is folded into Phase 1 as day-one design requirements of the v2 build (P1-02, P1-09, P1-10, P1-12, P1-15), so nothing waits on a separate stabilization step and nothing is fixed twice.

### 13.2 Milestones and exit criteria

| Milestone | Phases | Exit criteria |
| :--- | :--- | :--- |
| M1 Foundation and core online | 1 to 3 | No unauthenticated admin routes, no leaked secrets, no temp-file leak (built in from P1-01, not patched later). All legacy-facade routes served by the core engine over the Cloudinary driver with response shapes matching the documented legacy contract (P1-14). `/api/v1` live. Backfill complete. Rollback flag proven. |
| M2 Replicated | 4 | `STORAGE_DRIVER=hybrid` works with the memory broker: fast path, replicas, delete propagation, reconciler. |
| M3 Enterprise bus | 5 | Kafka and Pulsar pass the same contract suite. DLQ tooling. Scan gating. |
| M4 Production | 6 | Audit, quotas, metrics, CI gates, backups, load test report, legacy app decommissioned. |

---

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| Legacy clients depend on undocumented response details | Breaking change | Behavior-reference tests derived from the documented contract first (P1-14), additive-only facade rule, engine flag with rollback, shadow comparison (P3-05) |
| SuperAdmin dashboard does not send a token today | Locking out admins when auth is enforced | `ADMIN_AUTH_MODE=report` for one release, coordinate with dashboard owners (Q2) |
| Kafka client library maintenance (F-30) | Long-term security and bug exposure | Spike P5-01, keep the driver behind `IMessageBroker` |
| Pulsar native client on arm64 (F-30) | Image build failure | Spike P5-03 before committing to the driver. Pulsar can slip without blocking Kafka. |
| Two brokers double test surface | Slower delivery | One parameterized contract suite (P5-05) |
| Cloudinary backfill volume | Long-running migration, API rate limits | Resumable, rate-limited script with checkpointing (P3-04) |
| Private data published to public CDN | Data exposure | Visibility model, `cloudinaryReplication` policy, tests asserting private files never reach Cloudinary (P4-01) |
| Multi-node local replicas (F-27) | Missing files | Documented constraint, startup warning, excluded in multi-node config |
| Outbox growth | DB bloat | Retention job, index on unpublished rows |
| Rewriting from requirements alone misses an undocumented legacy behavior | Breaking change for existing clients | Legacy app stays reachable read-only as a live reference during Phase 1-3; the owner and A-06/A-07 assumptions call out anything the documents don't settle for direct confirmation |

Future work not scheduled: resumable uploads (tus), per-tenant encryption keys, cross-region SeaweedFS replication. *(Note: Direct-to-storage presigned upload for large files is newly scheduled in Section 9.5).*
