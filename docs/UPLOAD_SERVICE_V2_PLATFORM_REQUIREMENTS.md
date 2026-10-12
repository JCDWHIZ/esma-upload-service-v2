---
title: esma-upload-service-v2 — What the platform needs from you
subtitle: Requirements, contracts and acceptance criteria for the upload-service team
date: 11 October 2026
author: Elsoft Engineering — Platform Architecture
target: esma-upload-service-v2 @ 1c2f446 (8 Oct 2026). NOT the older `esma-upload-service` (v1) repository.
status: Issued for implementation. Replaces the discussion points in `upload-service-integration-observations-2026-10-11.md`.
---

# esma-upload-service-v2 — What the platform needs from you

## 0. How to read this document

**Decision.** The upload service becomes the **only** way any ESMA product stores a file (decision D-10). The Java services stop writing to SeaweedFS directly. Files and storage also become a platform module that every tenant has (tiered quota), billed by the BackOffice as `storage.bytes`.

**What you are asked to do.** Make the changes in section 3, to the contracts in section 4. Everything is numbered `UR-nn` ("upload requirement"). The older `U-nn` numbers from the observations document are mapped in section 8.

**We build against this document now.** The platform side is being implemented on the assumption that every requirement below is delivered as written. If you need to change a contract (a field name, a status code, a header), change this document first, tell us, and we adapt. Silent deviations break the callers.

**Words.** MUST = the platform cannot go live without it. SHOULD = needed for the first production month. MAY = nice to have.

**Priority bands.**

| Band | Meaning | Requirements |
|---|---|---|
| **M1 — unblock** | Nothing works end to end without these. | UR-01, UR-02, UR-03, UR-04, UR-05, UR-06, UR-07, UR-08, UR-29, UR-30 |
| **M2 — go-live** | Needed before a real tenant stores a real file. | UR-09 to UR-17, UR-31 |
| **M3 — lifecycle** | Needed before the first tenant offboards or the first large video is uploaded. | UR-18 to UR-23 |
| **Hygiene** | Do alongside. | UR-24 to UR-28 |

### 0.1 What the platform side has already done (do not redo)

| Item | Where | Notes |
|---|---|---|
| Java client | repo `platform-storage` (`UploadServiceClient`, `JobFileStore`) | Calls `/api/v1/files/upload`, `/{id}` (with `?redirect=never`), `/{id}/metadata`, `/{id}/signed-url`, `DELETE /{id}`. Client-credentials token, scope `internal.files`. Will move to the contract in section 4 (headers, namespaces). |
| Callers | SIS (`esma-tenant-service`), LMS, assessment, operations, identity | Job files, support attachments, case evidence, branding. Others follow once UR-05 and UR-09 are delivered. |
| Identity client | `esma-storage-client` (client credentials, scope `internal.files`) | Seeded in identity's baseline. Secret = `PLATFORM_STORAGE_CLIENT_SECRET`. |
| Kubernetes | `esma-deployment/k8s/services/upload-service/` | API + worker Deployments, migrate Job, ClamAV, SeaweedFS (single node), HPA, PDB, NetworkPolicy; secrets; DB `esma_upload_db` with owner/app roles; the ten `esma.files.*` Kafka topics; gateway env `UPLOADS_SERVICE_URI`. Image name assumed: `gitea.infra.elsoft.ng/esma/esma-upload-service-v2:<tag>`. |
| Gateway | `/uploads/**` → `esma-upload-service:7030` | `APP_BASE_URL` is set to `<public gateway>/uploads`, so signed URLs come out as `<gateway>/uploads/api/v1/files/...`. Keep it that way. |

### 0.2 How the service is deployed (so you can test the same way)

- API: `node dist/main.js`, port 7030, global prefix `/uploads`. Worker: `node dist/worker.js`, health on 8081.
- Postgres **direct** (not through PgBouncer: you use advisory locks and `LISTEN/NOTIFY`). The runtime role is DML-only; a migrate Job runs first as the owner role.
- `EVENT_BROKER=kafka` against the platform Kafka. Topic auto-create is **off** in production; topics come from the platform topics-init job.
- `NODE_ENV=production`, `SWAGGER_ENABLED=false`, `STORAGE_DRIVER=seaweedfs`, ClamAV at `esma-upload-clamav:3310`, `SCAN_FAIL_MODE=closed`.

---

## 1. Why these changes (one paragraph each)

1. **Trust.** Today identity tokens are rejected by default (HS256 vs RS256), have no audience check, ignore revocation, and have no path for service-to-service calls. Without these the service is either unreachable or too permissive.
2. **Authorisation belongs to the owning domain.** A student document is visible to that student's guardians and class teacher, an exam paper only after release. The upload service cannot know that. The owning service decides, then asks you for a short-lived URL. `tenant` visibility ("any logged-in user of the school") must not be the working default for anything sensitive.
3. **Different files need different rules.** One 20 MB / one MIME list / no virus scan for everything is wrong for avatars, spreadsheets, report-card ZIPs, exam videos and tenant exports.
4. **The service is now part of billing, quota, offboarding and audit.** It must publish usage, take its quota from the commercial plan, purge a tenant on command, and emit events other services react to.
5. **Operability.** Migrations, config, metrics and health must behave like the rest of the platform so a pod either runs correctly or refuses to start.

---

## 2. Summary table

| ID | Band | Requirement (short) |
|---|---|---|
| UR-01 | M1 | RS256 against identity's JWKS is the default; HS256 is opt-in; `aud` and `iss` enforced |
| UR-02 | M1 | Service-to-service calls: client-credentials tokens, scope `internal.files`, `X-Organization-Id`, actor = calling service |
| UR-03 | M1 | Namespace selection by `X-Namespace`; the namespace catalogue in 4.3 |
| UR-04 | M1 | `private` is the default and means "owner service decides": grants / signed URLs for service callers |
| UR-05 | M1 | Scan semantics and `waitForScan`; `scanStatus` values; virus scan on for user content |
| UR-06 | M1 | Owner attributes are indexed and queryable; list/delete by owner |
| UR-07 | M1 | Problem+json error codes (4.9) that the client maps to message keys |
| UR-08 | M1 | Migration and start-up behaviour: `AUTO_MIGRATE`, fixed CLI path, mandatory production config |
| UR-09 | M2 | Revocation and permission-version checks; `act` / support grant audit |
| UR-10 | M2 | Admin by permission, not by role-name strings; one permission vocabulary |
| UR-11 | M2 | Public domain events on `esma.files.events.v1` |
| UR-12 | M2 | Usage metering to `esma.platform.usage.v1` (`storage.bytes`) |
| UR-13 | M2 | Quota from the tenant entitlement event; admin override audited; 507 contract |
| UR-14 | M2 | Retention: `retentionDays`, TTL sweeper, tombstones |
| UR-15 | M2 | Branding/public files: stable public URL, derivatives, cache headers |
| UR-16 | M2 | Idempotency and conditional behaviour needed by callers (4.4) |
| UR-17 | M2 | Correlation: `traceparent`, `X-Correlation-Id` end to end |
| UR-18 | M3 | Tenant purge command and receipt |
| UR-19 | M3 | Tenant export bundle command and event |
| UR-20 | M3 | Presigned multipart upload for large files, range reads |
| UR-21 | M3 | Platform-owned namespace `platform-archives` (cross-tenant cold storage) |
| UR-22 | M3 | Tenant isolation hardening (scoped lookups, row-level security) |
| UR-23 | M3 | Egress metering `storage.egress.bytes` |
| UR-24 | Hygiene | Published, versioned OpenAPI 3.1 |
| UR-25 | Hygiene | Remove `schoolId`/`x-school-id` fallbacks and misspelled permission aliases |
| UR-26 | Hygiene | Documentation and configuration generated from `schema.ts` |
| UR-27 | Hygiene | Metrics port, health, graceful shutdown details |
| UR-28 | Hygiene | NestJS 11 and Kafka client plan |
| UR-29 | M1 | **Direct browser upload**: user-token uploads through the gateway, uploader-readable status, unclaimed-upload limits, CORS left to the gateway |
| UR-30 | M1 | **Claim**: the owning backend verifies a client-sent file id and binds it to its record; unclaimed uploads are swept |
| UR-31 | M2 | Browser reads: signed URLs through the gateway, public files, absolute URLs |
| UR-32 | M3 | Large files from the browser: parts through the service (no public storage host) |

---

## 3. Requirements in detail

### UR-01 — Authentication: RS256 by default, audience and issuer enforced (M1)

**Today.** `JWT_ALGORITHMS` defaults to `HS256`; `IDENTITY_JWKS_URI` and `IDENTITY_ISSUER` exist but a default deployment verifies nothing identity signs. In production a `JWT_SECRET` of 32+ characters is demanded even if HS256 is never used. There is no `aud` check; the `iss` check is skipped when `IDENTITY_ISSUER` is empty.

**Required.**
1. `JWT_ALGORITHMS` defaults to `RS256`. HS256 is allowed only when `JWT_ALGORITHMS` explicitly contains `HS256` **and** `JWT_SECRET` is set (≥ 32 chars). Otherwise `JWT_SECRET` is not required.
2. Keys come from `IDENTITY_JWKS_URI` (in cluster: `http://esma-identity-service:7071/identity/oauth2/jwks`). Cache by `kid`, refresh on unknown `kid` (rate limited), tolerate JWKS outage for the cache TTL.
3. `iss` MUST equal `IDENTITY_ISSUER` (in cluster: `http://esma-identity-service:7071/identity`). In production an empty `IDENTITY_ISSUER` fails start-up.
4. `aud` MUST contain `esma-files`. **Identity will add `esma-files` to the audience of user tokens and client-credentials tokens it issues** (platform work; tracked on our side). Until that ships, `JWT_REQUIRED_AUDIENCE` may be set empty in non-production only.
5. Keep rejecting `alg=none`, unexpected `alg`, missing `exp`. Clock tolerance stays 5 s.
6. `exp` of user tokens is ≤ 15 minutes; do not extend it.

**Acceptance.** (a) A token minted by identity (RS256) with the right `iss`/`aud` is accepted with the default config. (b) Same token with another `aud`, or with an `iss` that differs by a trailing slash, is rejected with 401. (c) With `NODE_ENV=production` and no `JWT_SECRET`, the service starts when only RS256 is configured. (d) Start-up fails in production when `IDENTITY_ISSUER` or `IDENTITY_JWKS_URI` is empty.

---

### UR-02 — Service-to-service calls (M1)

**Why.** Java services store files for a tenant on behalf of nobody in particular (a generated report-card ZIP, an imported workbook, a support attachment copied from a ticket). Their client-credentials tokens carry **no** `organizationId`, so `EsmaTenantContextResolver` rejects them.

**Token shape (as identity issues it today, 2026-10-11).** Client-credentials tokens carry: `iss`, `sub` = client id, `azp` = client id, `grant_type=client_credentials`, `scope` (space separated; contains `internal.files` for `esma-storage-client`), `access.{global,organization,client}.{roles,permissions}`, `exp`. They do **not** carry `organizationId`, `sid` or `permissionVersion`.

**Required.**
1. A token with `grant_type=client_credentials` and scope `internal.files` is a **service principal**. It is accepted on the file endpoints in 4.2 only.
2. The tenant is named by the header **`X-Organization-Id: <uuid>`**. It is **required** for service principals (400 `organization_required` if missing; 403 `organization_mismatch` is not applicable). The header is **ignored** for user tokens (the token's `organizationId` is the tenant); if both are present and differ, reject with 403 `organization_mismatch`.
3. The same header is accepted as an alias of today's `x-tenant-id` for API-key callers.
4. The actor recorded on the file row, audit rows and events is `actor.type=SERVICE`, `actor.id=<azp>`. Add `acting_service` (text) to `files` and the audit log.
5. Allowed namespaces for a service principal are configured per client id (`SERVICE_CLIENT_NAMESPACES` JSON: `{"esma-storage-client":["*"]}`; a platform-only client such as the one used for `platform-archives` may be restricted to `["platform-archives"]`). Anything else: 403 `namespace_not_allowed`.
6. A service principal may: upload, read content, read metadata, list, create signed URLs, delete — always inside the header's organisation. It MUST NOT see any file of another organisation (404, never 403, to avoid existence leaks).
7. API keys stay for non-identity integrations only (external partners), bound to namespace and tenant list as designed. They are not used by ESMA services.

**Acceptance.** (a) Upload with a service token and `X-Organization-Id` stores a file whose tenant is that organisation. (b) The same call without the header is 400. (c) Reading that file with a header naming another organisation is 404. (d) Audit shows `acting_service=esma-storage-client`.

---

### UR-03 — Namespaces (M1)

**Today.** Namespace comes from `X-Namespace` (generic resolver) or the token; only `esma-tenant`, `esma-admin`, `generic-default` exist, all capped at 20 MB with the same MIME list; `requireVirusScan` is false everywhere.

**Required.**
1. The caller selects the namespace with the **`X-Namespace`** header on every upload. It is required for service principals and API keys. A user token without the header uploads into `generic-default` (legacy facade only; ESMA frontends will always send the header). Unknown namespace: 400 `namespace_unknown`.
2. The catalogue in section 4.3 is built in (the file `policies.ts` and an optional `POLICIES_FILE` override). Each namespace has its own size limit, MIME allow-list (checked on **sniffed** type, not the declared one), visibility rules, scan rule, derivative list, retention default, and which principals may use it.
3. Keep `esma-tenant`, `esma-admin` and `generic-default` only as deprecated names, mapped as in 4.3, until the v1 facade is retired (UR-25). New callers never use them.
4. Storage key layout is `<organisationId>/<namespace>/<yyyy>/<mm>/<fileId>`. The old `uploads/schools/...` layout stays readable for legacy rows only.

**Acceptance.** For each namespace in 4.3 a test uploads (i) an allowed file (201), (ii) an oversize file (413), (iii) a disallowed type, including one with a lying `Content-Type` (415), (iv) a visibility not allowed by the namespace (422).

---

### UR-04 — Authorisation model: "private means the owner decides" (M1)

**Required.**
1. New namespaces default to `visibility=private`, except `branding` (default `public`).
2. `GET /files/{id}` (content) and `HEAD`:
   - **Service principal** (in the header's organisation): allowed for any file the principal's namespaces permit.
   - **User token**: for `private` files, allowed only to the uploader or to a user holding permission `files.file.read.any` (see UR-10); for `tenant` files, to any authenticated member of the organisation; for `public` files, to anyone.
   - **Signed URL** (`exp`, `disp`, `sig`): allowed without a token (as today).
3. `POST /files/{id}/signed-url` — body `{ "ttlSeconds": 1..600, "disposition": "inline"|"attachment" }`:
   - Allowed for a service principal (this is the **grant** flow: the owning service has already authorised its caller) and for a user who may read the file under rule 2.
   - TTL is capped at 600 s (config `SIGNED_URL_MAX_TTL_SECONDS`, default 600; today 900).
   - The signature covers `fileId`, `exp`, `disp` **and the organisation id**; a URL signed for one organisation never serves another's file.
   - Response: `{ "fileId", "url", "expiresAt", "disposition" }` (unchanged shape).
4. A signed URL works for `HEAD` and `Range` requests.
5. Never put a user token or the signed URL's query string in logs or in the audit table; log `fileId`, `exp`, `disp` and the first 6 characters of `sig`.

**Acceptance.** (a) A user token that did not upload a `private` file and lacks `files.file.read.any` gets 403 on content, metadata and signed-url. (b) A service principal gets a signed URL, the URL streams the file with `Range`, then returns 401/403 after `exp`. (c) A URL signed for organisation A, replayed with a file id of organisation B, fails.

---

### UR-05 — Scan semantics (M1)

**Required.**
1. `scanStatus` values: `PENDING`, `CLEAN`, `INFECTED`, `ERROR`, `SKIPPED` (policy has scan off). Present in the upload response, the manifest and events.
2. `requireVirusScan=true` for every namespace marked "scan: yes" in 4.3. `SCAN_FAIL_MODE=closed` stays.
3. Reads of `PENDING`, `INFECTED`, `ERROR` files are refused: `PENDING` → 409 `scan_pending` with `Retry-After: 2`; `INFECTED` → 422 `file_infected` (and the file is quarantined, not deleted before `QUARANTINE_RETENTION_DAYS`); `ERROR` → 503 `scan_unavailable`.
4. **`waitForScan`** (form field or query on upload, integer seconds, 0–30, default 0): the upload response is held until the scan finishes or the time elapses; the response then carries the final `scanStatus` (or still `PENDING`). Callers that process an upload immediately (spreadsheet imports) set it to 20.
5. Size ceiling for the scanner: files over `CLAMAV_MAX_BYTES` (default 100 MB) are scanned as a stream; if ClamAV's own limit is lower, the service chunks or marks `ERROR`, never `CLEAN`.
6. The scan result is published as `file.scanned.v1` (UR-11).

**Acceptance.** EICAR test file: upload returns 201, `scanStatus` becomes `INFECTED`, content read is 422, `file.scanned.v1` is published. With `waitForScan=20` the 201 already says `INFECTED`.

---

### UR-06 — Owner attributes are first-class (M1)

**Why.** Callers keep the file id in their own tables, but they must also find files by owner (delete everything of a ticket, find the logo of an organisation, GDPR erasure by person).

**Required.**
1. `attributes` (form field, JSON object, ≤ 20 pairs, key ≤ 64 chars `[A-Za-z0-9_.-]`, value ≤ 256 chars) is stored as `jsonb`. Three keys are **reserved and indexed**: `ownerType`, `ownerId`, `kind`. Add a btree index on `(organization_id, namespace, attributes->>'ownerType', attributes->>'ownerId')`.
2. `GET /api/v1/files?ownerType=&ownerId=&kind=&namespace=&status=&limit=&cursor=` returns `{ "data": [manifest, ...], "nextCursor": "<opaque or null>" }` (cursor pagination, default limit 50, max 200, newest first). Service principals list inside the header's organisation.
3. `DELETE /api/v1/files?ownerType=&ownerId=[&namespace=]` deletes all matching files (soft delete → tombstone → hard delete as today); returns `{ "data": { "deleted": n } }` (same envelope as upload). At least `ownerType` and `ownerId` are required (400 otherwise). Max 1,000 per call; larger sets run async and return 202 with a job id.
4. `GET /files/{id}/metadata` returns the manifest including `attributes`, `namespace`, `acting_service`, `retainUntil`, `scanStatus`, `status`.

**Acceptance.** Upload three files with `ownerType=SUPPORT_TICKET, ownerId=T1` and one with `T2`; list by `T1` returns three; delete by `T1` leaves one; reading a deleted id is 404.

---

### UR-07 — Error contract (M1)

Use RFC 9457 problem+json for every non-2xx, with a stable machine code in `code` (also in `type` as `urn:esma:files:error:<code>`). The Java client maps `code` to the message key `error.storage.<code>`; unknown codes become `error.storage.unexpected`.

The codes and their HTTP status are in 4.9. Do not change them without telling us; add codes freely.

**Acceptance.** Each code in 4.9 has a test asserting status, `code`, `type`, and that `detail` never contains a stack trace, SQL, file path or secret.

---

### UR-08 — Migrations and start-up (M1)

**Today.** `DatabaseService.onModuleInit` migrates whenever `DB_ENABLED=true`; there is no way to turn it off. `package.json` `db:migrate` points at `dist/src/db/migrate.js`, but the Dockerfile compiles `src/` to `dist/` (`dist/main.js`), so the CLI is at `dist/db/migrate.js`. `DB_ENABLED` defaults to `false`, so a production pod that forgets it runs without a database.

**Required.**
1. New env `AUTO_MIGRATE` (default `true` outside production, **`false`** when `NODE_ENV=production`). When false, start-up only *checks* that no migration is pending and refuses to start (exit non-zero, log the pending names) if one is. The platform runs a migrate Job (as owner role) before each rollout, then pods start as the DML-only role.
2. Fix the CLI path in `package.json` (`db:migrate`, `db:status`) so it matches the image, and add `"db:migrate:prod": "node dist/db/migrate.js migrate"`. Exit code 0/1.
3. In production `DB_ENABLED` is forced `true` and `DATABASE_URL` must be set, or start-up fails. `EVENTS_ENABLED=true` and `EVENT_BROKER` ∈ {kafka, pulsar}, or start-up fails (the existing `ALLOW_MEMORY_BROKER` rule stays).
4. Migrations must be additive and re-runnable (`IF NOT EXISTS`), take the existing advisory lock, and never need a role other than the owner.
5. The runtime role needs only `SELECT/INSERT/UPDATE/DELETE` on tables and `USAGE/SELECT/UPDATE` on sequences. If any code path issues DDL at runtime, remove it.
6. `/health/ready` includes: database reachable, **no pending migration**, Kafka producer connected (when enabled), primary storage driver reachable, ClamAV reachable when any scan-required namespace is enabled.

**Acceptance.** In a cluster: run the Job → pods start; skip the Job after adding a migration → pods fail fast with the pending migration listed; `npm run db:migrate:prod` works inside the production image.

---

### UR-09 — Revocation and permission version (M2)

Identity user tokens carry `sid` (session id), `permissionVersion`, and, for support access, `supportAccess=true`, `supportGrantId`, and `act: { sub, ... }`. The Java services and the gateway reject a token whose session was revoked or whose permission version is stale, using the shared Redis revocation store.

**Required.**
1. On every user-token request, consult the same revocation signal the gateway uses (we will document the Redis keys and the `session-revoked` event in your repository's `docs/`; until then treat the key space as `esma:revoked:sid:<sid>` and `esma:org-permission-version:<organisationId>`, **confirm with identity before coding**).
2. Reject with 401 `token_revoked` when the session is revoked, 401 `token_stale` when `permissionVersion` is lower than the organisation's current version.
3. Fail **open for reads, closed for mutations** if Redis is unavailable (as today for rate limiting); count the occurrences in a metric.
4. Persist `act.sub` and `supportGrantId` in audit rows and in event metadata when present.

---

### UR-10 — Permissions: one vocabulary, decided by permission (M2)

**Today.** Admin is decided by role-name strings (`PLATFORM_ADMIN`, `superadmin`, `esma_admin` …), including a misspelled alias table (`upload_quoatas_view`, `quoata_*`).

**Required.** Decide every action from the token's `access.*.permissions` (and the client permissions for service principals). Canonical set (identity will seed exactly these; the old upper-case CLIENT codes remain as aliases until UR-25):

| Permission | Allows |
|---|---|
| `files.file.upload` | upload into namespaces open to users |
| `files.file.read` | read own files |
| `files.file.read.any` | read any file of the organisation, including `private` |
| `files.file.list` | list |
| `files.file.delete` | delete own files |
| `files.file.delete.any` | delete any file of the organisation |
| `files.file.admin` | everything in the organisation, including replicate and permanent delete |
| `files.quota.view` / `files.quota.manage` | read / override the organisation's quota (override audited) |
| `files.audit.view` | read the audit log of the organisation |
| `platform.files.admin` | staff: cross-organisation admin, DLQ, replication status |
| `platform.files.dlq.manage` | staff: DLQ redrive and discard |

Role names are never used for decisions.

---

### UR-11 — Public domain events on `esma.files.events.v1` (M2)

Keep `esma.files.replication|processing|audit|dlq` internal. Publish the externally useful events on **one** topic, `esma.files.events.v1` (dead letters: `esma.files.events.v1.DLT`), through the outbox, key = `organizationId`. The platform registers the topic. Envelope and payloads are in 4.6.

Events: `file.uploaded.v1`, `file.scanned.v1`, `file.deleted.v1`, `file.purged.v1` (tenant purge progress), `file.quota.threshold.v1` (80 %, 95 %, 100 %).

**Acceptance.** A consumer test reads each event, validates against the JSON Schema published in `docs/events/`, and sees one event per state change (no duplicates after outbox retry thanks to a stable `eventId` derived from the outbox row).

---

### UR-12 — Usage metering for billing (M2)

The BackOffice bills storage from `esma.platform.usage.v1`. Same envelope and rules as the other producers (communications, school): one message per organisation, meter and UTC day, idempotent re-publish, keyed by organisation id, via the outbox.

**Required.**
1. Daily job (after 00:10 UTC) publishes for the **previous UTC day**, per organisation that has at least one non-deleted file or had any change in the last 35 days (so a drop to zero is reported):
   - meter `storage.bytes`, `aggregation` = `LAST` (a gauge: bytes stored at the end of that day, original objects + derivatives, **not** counting replicas), `unit` = `bytes`.
   - meter `storage.files`, `aggregation` = `LAST`, `unit` = `files`.
2. Message JSON (exact field names; `quantity` is a decimal string-safe number):

```json
{
  "eventId": "files|<organizationId>|storage.bytes|2026-10-10|<revision>",
  "occurredAt": "2026-10-11T00:12:03Z",
  "eventType": "USAGE_REPORTED",
  "organizationId": "<uuid>",
  "usageDate": "2026-10-10",
  "meter": "storage.bytes",
  "aggregation": "LAST",
  "quantity": 1843200,
  "unit": "bytes",
  "source": "esma-upload-service"
}
```

3. A correction for a past day re-publishes with the same `eventId` stem and `revision + 1`; the consumer keeps the latest.
4. Source of truth: the `tenant_usage` table; the nightly reconciler recomputes from `files` and fixes drift before the job runs.

`aggregation` values accepted by the BackOffice consumer are confirmed in section 7 (open point 3).

---

### UR-13 — Quota follows the commercial plan (M2)

**Today.** Quotas live in the upload service (`/admin/tenants/:id/quota`). Entitlements (plan, modules, limits) live in the platform/BackOffice. Two truths will drift.

**Required.**
1. Consume `tenant-entitlement-changed` (existing compacted topic, one record per organisation). The platform **will add** `limits["storage.quotaBytes"]` (number, bytes; absent = plan default) and module `files` (on for every tenant). On each record, upsert `tenant_quota.plan_quota_bytes`.
2. Effective quota = `override_quota_bytes` if set and not expired, else `plan_quota_bytes`, else `DEFAULT_TENANT_QUOTA_BYTES` (config, default 1 GiB).
3. `PATCH /admin/tenants/:id/quota` sets only the override (with `reason` and optional `expiresAt`), requires `files.quota.manage` or `platform.files.admin`, and writes an audit row.
4. Upload over quota: **507** problem `quota_exceeded` with extension members `quotaBytes`, `usedBytes`, `requestedBytes`. The check is on the content-length / streamed size **before** the object is stored.
5. Publish `file.quota.threshold.v1` when usage crosses 80 %, 95 % and 100 % (once per crossing).
6. Suspended organisations (tenant-lifecycle event `suspended`) may read and delete but not upload (403 `tenant_suspended`); `resumed` lifts it.

---

### UR-14 — Retention (M2)

1. Upload accepts `retentionDays` (integer 1–3650) bounded by the namespace's maximum; default from the namespace (4.3). `retain_until` is stored and returned in the manifest.
2. A sweeper soft-deletes expired files (status `DELETING` → replicas removed → tombstone kept `TOMBSTONE_RETENTION_DAYS`, default 30 → row hard-deleted). Emits `file.deleted.v1` with `reason=RETENTION`.
3. `PATCH /files/{id}` may extend (never shorten below now) `retainUntil` for a service principal.
4. A legal hold flag `held=true` (set by platform staff) blocks deletion, retention sweep and purge (UR-18) until cleared.

---

### UR-15 — Public and branding files (M2)

1. Namespace `branding` allows `public`. Public files return a **stable, cacheable URL** (`publicUrl`, no signature) such as `<gateway>/uploads/api/v1/files/{id}` or the CDN URL when a CDN is configured; response carries `Cache-Control: public, max-age=86400` and a strong `ETag`.
2. Derivatives `thumb` (150 px) and `medium` (600 px) for raster images; `?variant=thumb` selects them. SVG is sanitised (scripts, external references removed) or rejected.
3. Private files are never given a CDN URL.

---

### UR-16 — Idempotency and conditional behaviour (M2)

1. `Idempotency-Key` on upload is honoured for 24 h per `(organisation, key)`; the same key with a different body fingerprint returns 409 `idempotency_conflict`; a replay returns the original response with `Idempotent-Replayed: true` (already implemented — keep, and include `X-Organization-Id` and namespace in the fingerprint).
2. `DELETE /files/{id}` is idempotent: deleting a missing/deleted file returns 204.
3. `GET /files/{id}/metadata` returns 404 for DELETING/DELETED, 200 otherwise (the client's `exists` uses it).
4. `ETag`/`If-None-Match` and `Range` keep working with signed URLs.

---

### UR-17 — Correlation (M2)

Accept `traceparent` and `X-Correlation-Id`; generate when absent; return `X-Correlation-Id`; put both in logs, audit rows and event metadata (`traceId`, `correlationId`). Propagate to ClamAV and storage calls as log context.

---

### UR-18 — Tenant purge (M3)

Used by tenant offboarding (WP-X-02: export → retention hold → legal-hold check → purge per owner → receipt → certificate of deletion).

**Required.**
1. Consume **`esma.platform.tenant-purge-requested.v1`** (platform registers it): `{ "requestId", "organizationId", "requestedAt", "reason", "owners": ["files", ...] }`. Act when `owners` contains `"files"` (or is empty).
2. Refuse while a legal hold exists for the organisation (publish a receipt with `status=REFUSED`, `reason=LEGAL_HOLD`).
3. Delete every file of the organisation in batches of 500: remove all replicas (SeaweedFS **and Cloudinary**), derivatives, tombstones, idempotency keys, usage rows, quota rows; keep **one** audit row `TENANT_PURGED`. Resumable and idempotent (a restart continues).
4. Publish the receipt on **`esma.platform.tenant-purge-completed.v1`**:

```json
{
  "requestId": "<uuid>",
  "organizationId": "<uuid>",
  "owner": "files",
  "status": "COMPLETED",
  "completedAt": "2026-11-01T10:15:00Z",
  "counts": { "files": 18452, "bytes": 9123456789, "replicas": 36904 },
  "checksum": "sha256:<hex of the sorted fileIds joined by newline>",
  "failures": []
}
```

`status` ∈ `COMPLETED`, `PARTIAL` (with `failures`), `REFUSED`. Also emit `file.purged.v1` progress events (optional).
5. While purging, the organisation's uploads are refused (403 `tenant_purging`).

**Acceptance.** Seed 1,000 files across namespaces with replicas; send the command; storage, Cloudinary and tables hold nothing for the organisation; the receipt checksum matches the seeded ids; re-sending the command returns the same receipt.

---

### UR-19 — Tenant export (M3)

1. Consume **`esma.platform.tenant-export-requested.v1`** `{ requestId, organizationId, requestedAt, owners }`.
2. Build a bundle: a ZIP (streamed, multipart to storage) with `manifest.jsonl` (one line per file: `fileId`, `namespace`, `filename`, `mime`, `size`, `sha256`, `attributes`, `createdAt`, path in the ZIP) and the files under `files/<namespace>/<fileId>-<filename>`. Skip `INFECTED`.
3. Store it in namespace `tenant-exports` (private, 14-day retention) and publish **`esma.files.events.v1`** `files.tenant.exported.v1` with `fileId` of the bundle, `counts`, `bytes`; also a receipt on `esma.platform.tenant-export-completed.v1` with the same shape as 18.4 (`owner="files"`).
4. The bundle is downloaded through a signed URL requested by the platform.

---

### UR-20 — Large files: presigned multipart, ranges (M3)

1. `POST /files/presigned-upload` (exists) is extended for multipart: request `{ filename, size, mime, namespace (via header), visibility, attributes, partSize? }` → response `{ fileId, uploadId, parts: [{ partNumber, url, expiresAt }], completeUrl, expiresAt }`. Part size 8–64 MiB, up to 10,000 parts.
2. `POST /files/{id}/complete-upload` with `{ parts: [{ partNumber, etag }] }` verifies size and (optionally) client-supplied `sha256`, then queues the scan (UR-05) and publishes `file.uploaded.v1`.
3. `POST /files/{id}/abort-upload` aborts and frees parts; an expiry sweeper does the same.
4. Range reads (`206`) work against the SeaweedFS driver without buffering the object; `Accept-Ranges: bytes`.
5. Limits for these namespaces are in 4.3 (learning media, recordings, tenant exports).

---

### UR-21 — Platform-owned namespace `platform-archives` (M3)

Some files belong to the platform, not to a tenant (for example the operations changelog partition archive, which spans organisations). Define the namespace so that: it is reachable only by a service principal whose client is allowed `platform-archives`; the organisation is the platform's own organisation (`X-Organization-Id` = the reserved platform organisation id; we supply it); it is **excluded from tenant quota and from tenant purge**; retention default 2,555 days (7 years); delete requires `platform.files.admin`.

---

### UR-22 — Tenant isolation hardening (M3)

1. In tenant namespaces use `findByIdForTenant(id, tenantId)`; keep the unscoped lookup for replication and admin code only.
2. Enable row-level security on `files`, `file_replicas`, `tenant_usage`, `file_derivatives` (policy on `organization_id = current_setting('app.tenant_id')::uuid`, set per request/transaction by the DB layer; the worker sets it per message). A missing filter must fail closed.
3. Add a test that runs every file endpoint with organisation A's token against organisation B's file ids and expects 404 (never 403).

---

### UR-23 — Egress metering (M3)

Count bytes served per organisation per day (content responses, including redirects counted at the signed-URL grant) and publish `storage.egress.bytes` (`aggregation=SUM`, `unit=bytes`) the same way as UR-12.

---

### UR-24 — Published OpenAPI 3.1 (Hygiene)

Generate from the NestJS decorators; publish at `/uploads/api/docs-json` (gated) **and** as a build artifact `openapi/esma-upload-v1.json` on every tag. Every operation has a stable `operationId`, request/response schemas, problem+json responses, security schemes, and the headers in 4.1. Breaking changes require `/api/v2`. We generate the Java and TypeScript clients from it. Mark the legacy v1 facade routes `deprecated: true` with a removal date.

### UR-25 — Remove legacy tenant keys and aliases (Hygiene)

Remove `schoolId` as a tenant key and `x-school-id`/`x-tenant-id` once the v1 facade is retired (date in the OpenAPI deprecation). Remove the misspelled permission aliases. Keep the legacy storage-key layout read-only.

### UR-26 — Docs and config (Hygiene)

Generate the configuration table in `README.md` from `schema.ts` (the generator exists). Fix `AUTH_JWKS_URI` vs `IDENTITY_JWKS_URI`, the workspace paths, and the 7030 port. Add `docs/runbook.md`: start-up failures and what they mean, DLQ handling, restoring a file from a replica, rotating `SIGNED_URL_SECRET` (support two secrets during rotation: `SIGNED_URL_SECRET` and `SIGNED_URL_SECRET_PREVIOUS`).

### UR-27 — Ports, metrics, shutdown (Hygiene)

Either serve metrics on `METRICS_PORT` (9090) or delete the setting (today it is read but unused; metrics are on the API port at `/uploads/metrics`). Protect `/metrics` with `METRICS_TOKEN` when set. Graceful shutdown: stop accepting, finish in-flight uploads (≤ 30 s), flush the outbox batch; the worker finishes its current message. Worker health on `WORKER_HEALTH_PORT` (8081): `/health/live`, `/health/ready`, `/metrics`.

### UR-28 — Dependencies (Hygiene)

Plan NestJS 11. Keep the broker behind `IMessageBroker`; evaluate `@confluentinc/kafka-javascript` because `kafkajs` is unmaintained.

### UR-29 — Direct browser upload (M1)

**Decision.** Frontends upload straight to the upload service and send only the file id (or URL) to the backend with their business request ("create ticket with these attachments", "set this as my logo"). The backend never relays file bytes for user content. The flow is in 5.1; this requirement is what the upload service must do for it.

1. **Path.** Browsers call `POST https://<public gateway>/uploads/api/v1/files/upload` with the user's bearer token and `X-Namespace`. The gateway passes `/uploads/**` through (bearer token still validated there) and now allows unauthenticated `GET`/`HEAD` of `/uploads/api/v1/files/{id}` so that signed URLs and public files work in `<img>`/`<a>`; every other route stays behind the token. The upload service therefore must enforce its own proof on those two methods (signature, token, or `public`) — already the case, keep it.
2. **User principals and namespaces.** A user token may upload only to namespaces whose "Who" column in 4.3 includes **U**, and only with permission `files.file.upload`. Optionally a namespace can demand an extra permission (config `USER_NAMESPACE_PERMISSIONS`, e.g. `{"student-documents":"files.student-documents.upload"}`); default none. Otherwise 403 `namespace_not_allowed`.
3. **CORS.** The gateway answers preflight and adds CORS headers (allowed origins `https://*.esma.elsoft.ng` etc., credentials on, and it exposes `X-Correlation-Id, Idempotent-Replayed, Content-Disposition, Content-Range, Accept-Ranges, ETag, Retry-After, Location`). **The upload service must not add its own CORS headers** when `TRUST_PROXY=true`/behind the gateway (a second `Access-Control-Allow-Origin` makes browsers reject the response). Add `CORS_ENABLED` (default `false` in production, `true` in local dev).
4. **URLs in responses are relative or gateway-absolute, never internal.** `canonicalUrl` is `/uploads/api/v1/files/{id}` (relative to the public gateway origin). Signed URLs are absolute using `APP_BASE_URL` (already `<gateway>/uploads`).
5. **Uploader can see their own file.** `GET /files/{id}/metadata` with a user token succeeds for the **uploader** of a file whatever its visibility, claim state or the caller's read permissions, and returns `scanStatus`, `claimed`, `size`, `mimetype`. That is how the browser polls until `scanStatus` is `CLEAN` (it must not need `files.file.read`). Content `GET` by the uploader is allowed for unclaimed files only while `scanStatus=CLEAN` (preview before submit).
6. **Abuse limits per user** (config, defaults): at most 50 unclaimed files and 500 MB of unclaimed bytes per user per organisation → 429 `too_many_pending_uploads`; upload rate 60/min per user → 429 `rate_limited`.
7. **Manifest additions** (additive): `uploadedBy` (the token's `sub`; the client id for service uploads), `claimed` (boolean), `claimedAt`.
8. **Tenant comes from the token** for user principals; `X-Organization-Id` is ignored (UR-02.2). A browser can therefore never write into another organisation.

**Acceptance.** (a) With a user token and `X-Namespace: support-attachments`, a PDF upload returns 201 with `claimed=false`, `uploadedBy=<sub>`. (b) The uploader polls metadata and sees `PENDING` then `CLEAN`; a different user of the same organisation gets 404. (c) A user token cannot upload to `generated-documents` (403). (d) The 51st unclaimed upload returns 429 `too_many_pending_uploads`. (e) A cross-origin preflight to the service **directly** returns no CORS headers in production mode.

---

### UR-30 — Claim: the backend verifies and takes over a client-sent file (M1)

**Why.** The browser says "the file is `0192…`". The backend must not trust that: the id may belong to another user, another namespace, an infected file, or be reused by two records. The backend asks the upload service, then **claims** the file for the owning record so it is kept.

1. `POST /uploads/api/v1/files/{id}/claim` — **service principals only** (UR-02), with `X-Organization-Id`. Body:

```json
{ "ownerType": "SUPPORT_TICKET", "ownerId": "<public id>", "kind": "attachment" }
```

   Response `200`: the manifest in the usual `{ "data": { ... } }` envelope with `claimed=true`, `claimedAt`, `attributes` containing the three reserved keys (UR-06).
2. **Idempotent for the same owner** (same `ownerType`+`ownerId`+`kind` → 200 again). A different owner → 409 `already_claimed`. `INFECTED`/`ERROR` files → 422 `file_infected`/`scan_unavailable`. Unknown, deleted or other-organisation id → 404. `PENDING` files **can** be claimed (the read gate still refuses their content until clean).
3. Claiming clears the unclaimed expiry and publishes `file.claimed.v1` (`{ fileId, namespace, ownerType, ownerId, kind }`).
4. **Unclaimed sweeper.** A file uploaded by a *user* principal into a claim-required namespace gets `unclaimed_expires_at = created_at + UNCLAIMED_TTL_HOURS` (default **24**, config). The sweeper deletes expired unclaimed files (replicas included) and publishes `file.deleted.v1` with `reason=UNCLAIMED`. Claim-required namespaces: `imports`, `student-documents`, `support-attachments`, `case-evidence`, `branding`, `coursework-submissions`, `learning-media`, `thrift-documents`. Files uploaded by a **service** principal are claimed at creation (the caller passes the owner attributes) and never swept.
5. **Unclaimed files are private to the uploader** and to service principals: not listable by other users, not covered by `files.file.read.any`, not signable by users. Once claimed, normal visibility rules apply.
6. Re-pointing: a backend that replaces a file (new logo) deletes the old one with `DELETE /files/{id}` (existing) — no un-claim endpoint is needed.

**What the backend checks before it calls claim** (so you know the calling pattern; implemented in `platform-storage` `ClientUploadVerifier`): the file exists in this organisation (metadata call), is in the expected namespace, was uploaded by the same subject as the current user, is not `INFECTED`/`ERROR`, and fits the size and type of the feature. Then `claim`.

**Browser-upload limits the callers apply on top (for your tests):** the logo and hero-image endpoints in identity only accept a file uploaded by a user of the *same* organisation (a browser upload is stored under the caller's own organisation); platform staff acting for another school keep using the service-upload path.

**Acceptance.** (a) User A uploads, the backend claims for ticket T1 → 200; claiming again for T1 → 200; claiming for T2 → 409. (b) An unclaimed file disappears after the TTL (test with a 1-minute TTL) and the event is published. (c) User B cannot read, list or sign A's unclaimed file. (d) Claim with a service token of another organisation's header → 404.

---

### UR-31 — Reads from the browser (M2)

1. The owning domain authorises, then asks `POST /files/{id}/signed-url` (UR-04) and returns the URL to the browser; the browser loads it directly (`<img src>`, `<a href>`, `fetch`). The URL is absolute (`APP_BASE_URL` = `<gateway>/uploads`), valid ≤ 10 minutes, supports `Range`, `HEAD` and `Content-Disposition` by `disp`.
2. Public (`branding`) files are fetched from `publicUrl` / `canonicalUrl` with no token and cached (UR-15).
3. Files of the uploader with `tenant`/`public` visibility can also be fetched with the user's bearer token (UR-04.2).
4. For `<video>`/`<audio>` the service must honour `Range` on signed URLs and return `Accept-Ranges: bytes` and correct `Content-Range` (UR-20.4).

---

### UR-32 — Large files from the browser (M3, extends UR-20)

The browser must not need a public storage host or storage credentials. Therefore the multipart flow runs **through the service**:

1. `POST /files/uploads` (user token, `X-Namespace`) with `{ filename, size, mime, partSize? }` → `{ uploadId, fileId, partSize, partCount, expiresAt }`.
2. `PUT /files/uploads/{uploadId}/parts/{n}` (raw bytes, `Content-Length`, optional `Content-MD5`) → `{ etag }`; parts may be sent in parallel and retried; size = `partSize` except the last.
3. `POST /files/uploads/{uploadId}/complete` with `{ parts: [{ n, etag }] }` → the manifest (`claimed=false`, `scanStatus=PENDING`), or `DELETE /files/uploads/{uploadId}` to abort. `GET /files/uploads/{uploadId}` lists received parts so a refreshed page can resume.
4. Same user, namespace limits, quota (UR-13) and unclaimed rules as a normal upload; an expired incomplete upload is aborted by the sweeper after 24 h. Service principals use the same endpoints.
5. If you prefer presigned storage URLs for parts, they must be on a **public** storage hostname with bucket CORS exposing `ETag`; tell us the hostname and we add it to the gateway/CSP. The proxy-through-service design above is the default we will integrate.


---

## 4. Contracts

### 4.1 Headers

| Header | Direction | Who sends | Meaning |
|---|---|---|---|
| `Authorization: Bearer <jwt>` | request | everyone | user token or service token (UR-01, UR-02) |
| `X-Organization-Id` | request | service principals | the tenant; required for them (UR-02) |
| `X-Namespace` | request | everyone (required for service principals and API keys) | namespace (UR-03). A user token without it uses `generic-default` |
| `Idempotency-Key` | request | uploaders | UR-16 |
| `traceparent`, `X-Correlation-Id` | request/response | everyone | UR-17 |
| `Idempotent-Replayed: true` | response | you | replay |
| `Retry-After` | response | you | `scan_pending`, `rate_limited` |

### 4.2 Endpoints the platform calls

| Purpose | Call | Notes |
|---|---|---|
| Upload | `POST /uploads/api/v1/files/upload` | multipart: `file` (1..n), `folder`, `visibility`, `tags` (JSON array), `attributes` (JSON object), `retentionDays`, `waitForScan`. 201, or 207 for multi-file partial |
| Content | `GET /uploads/api/v1/files/{id}?redirect=never[&variant=]` | UR-04 rules |
| Metadata | `GET /uploads/api/v1/files/{id}/metadata` | exists = 200 |
| Signed URL | `POST /uploads/api/v1/files/{id}/signed-url` | UR-04 |
| List | `GET /uploads/api/v1/files?ownerType&ownerId&kind&namespace&limit&cursor` | UR-06 |
| Delete | `DELETE /uploads/api/v1/files/{id}` | 204, idempotent |
| Delete by owner | `DELETE /uploads/api/v1/files?ownerType&ownerId` | UR-06 |
| Multipart | `POST /files/presigned-upload`, `POST /files/{id}/complete-upload`, `POST /files/{id}/abort-upload` | UR-20 |
| Claim | `POST /uploads/api/v1/files/{id}/claim` | UR-30, service principals only |
| Browser multipart | `POST /files/uploads`, `PUT /files/uploads/{uploadId}/parts/{n}`, `POST /files/uploads/{uploadId}/complete`, `DELETE`/`GET /files/uploads/{uploadId}` | UR-32 |
| Quota (staff) | `GET/PATCH /uploads/api/v1/admin/tenants/{org}/quota` | UR-13 |
| Health | `GET /uploads/health/live`, `/ready` | UR-08 |

**Platform client status (11 Oct 2026).** `platform-storage` already sends `X-Namespace`, `retentionDays`, `waitForScan`, `X-Organization-Id`; parses the manifest below including `namespace`, `retainUntil`, `attributes`, `createdAt`; maps problem+json `code` to `error.storage.<code>`; and calls list/delete-by-owner with the envelopes in UR-06.

**Upload response (keep today's shape; the Java client reads these fields from `data`):**

```json
{
  "data": {
    "fileId": "0192f0b2-…-uuidv7",
    "filename": "report-cards.zip",
    "mimetype": "application/zip",
    "size": 1843200,
    "sha256": "…",
    "visibility": "private",
    "canonicalUrl": "/uploads/api/v1/files/0192f0b2-…",
    "publicUrl": null,
    "scanStatus": "CLEAN",
    "namespace": "generated-documents",
    "retainUntil": "2026-11-10T09:00:00Z",
    "attributes": { "ownerType": "JOB_FILE", "ownerId": "…", "kind": "report-cards" },
    "uploadedBy": "esma-storage-client",
    "claimed": true,
    "createdAt": "2026-10-11T09:00:00Z"
  }
}
```

New members (`namespace`, `retainUntil`, `attributes`, `uploadedBy`, `claimed`, `claimedAt`, `createdAt`) are additive. Every JSON response (upload, metadata, claim, list, delete-by-owner) uses the `{ "data": ... }` envelope.

### 4.3 Namespace catalogue

Sizes are per file. "Who" = principal types allowed: **U** user token, **S** service principal. "Scan" = `requireVirusScan`. Retention = default / maximum.

| Namespace | Used for | Max size | Allowed types (sniffed) | Visibility (default / allowed) | Scan | Who | Retention |
|---|---|---|---|---|---|---|---|
| `imports` | user-supplied spreadsheets for bulk onboarding and data jobs | 25 MB | xlsx, xls, csv, ods | private / private | yes | U, S | 30 d / 90 d |
| `generated-documents` | report-card PDFs and ZIPs, statements, data-job exports, onboarding result sheets, bulk PDF jobs | 200 MB | pdf, zip, xlsx, csv, json, txt, docx | private / private | no | S | 30 d / 365 d |
| `student-documents` | student and guardian documents (birth certificates, results, medical letters) | 20 MB | pdf, jpg, png, webp, docx | private / private, tenant | yes | U, S | until deleted / — |
| `support-attachments` | support-ticket attachments (school and platform desks) | 10 MB | jpg, png, webp, gif, pdf, txt, log, csv, zip | private / private | yes | U, S | 730 d / 3650 d |
| `case-evidence` | assessment academic-case evidence | 50 MB | jpg, png, pdf, mp3, m4a, wav, mp4, docx | private / private | yes | U, S | until deleted / — |
| `branding` | logos, hero images, avatars, favicons | 10 MB (hero images; logos and avatars are held to 5 MB by the calling service) | png, jpg, webp, svg (sanitised) | public / public, tenant, private | yes | U, S | until deleted / — |
| `coursework-submissions` | LMS/SIS homework and assignment submissions | 50 MB | pdf, docx, xlsx, pptx, jpg, png, zip, txt | private / private | yes | U, S | until deleted / — |
| `learning-media` | LMS lesson and question media | 500 MB (multipart) | jpg, png, webp, gif, mp3, m4a, mp4, webm, pdf | tenant / private, tenant | yes | U, S | until deleted / — |
| `session-recordings` | live-session recordings (communications) | 5 GiB (multipart) | mp4, webm, mkv, m4a | private / private | yes (async) | S | 365 d / 1825 d |
| `tenant-exports` | encrypted tenant export packages and file bundles | 5 GiB (multipart) | zip, bin, enc, json | private / private | no | S (platform) | 14 d / 30 d |
| `platform-archives` | platform-owned cold storage (e.g. changelog partitions) — UR-21 | 1 GiB (multipart) | json, jsonl, gz, zip, parquet | private / private | no | S (platform client only) | 2,555 d / — |
| `thrift-documents` | Thrift product documents (receipts, KYC images) | 10 MB | pdf, jpg, png | private / private | yes | U, S | until deleted / — |
| `generic-default` | **deprecated**, legacy v1 facade only | 20 MB | as today | private / any | as today | U | as today |
| `esma-tenant`, `esma-admin` | **deprecated** aliases (→ `student-documents`, `branding`) | as above | as above | as above | as above | U | as above |

Rules for all namespaces: derivatives only for raster images in `branding`, `student-documents` (`thumb`, `medium`); max files per request 10; filenames are sanitised, never trusted for the storage key; the declared `Content-Type` must agree with the sniffed type or the request is 415.

### 4.4 Visibility semantics

| Value | Read by |
|---|---|
| `private` | uploader, holders of `files.file.read.any`, service principals (same organisation), anyone with a valid signed URL |
| `tenant` | any authenticated member of the organisation, service principals, signed URL |
| `public` | anyone (CDN-cacheable), only where the namespace allows it |

### 4.5 Attributes (reserved keys)

| Key | Meaning | Example |
|---|---|---|
| `ownerType` | kind of owning record | `SUPPORT_TICKET`, `STUDENT_DOCUMENT`, `JOB_FILE`, `ORG_LOGO`, `CASE_EVIDENCE` |
| `ownerId` | owning record id (UUID or string ≤ 64) | the ticket's public id |
| `kind` | purpose within the owner | `attachment`, `logo`, `result-zip` |
| `origin` | `USER` or `GENERATED` (informational) | `GENERATED` |

### 4.6 Event envelope and payloads

Topic `esma.files.events.v1`, key = `organizationId`, value = JSON:

```json
{
  "eventId": "<uuid, stable per outbox row>",
  "eventType": "file.uploaded.v1",
  "occurredAt": "2026-10-11T09:00:00Z",
  "organizationId": "<uuid>",
  "producer": "esma-upload-service",
  "traceId": "<w3c trace id or null>",
  "correlationId": "<id or null>",
  "actor": { "type": "USER|SERVICE|SYSTEM", "id": "<id>", "actingService": "esma-storage-client|null" },
  "data": { }
}
```

| `eventType` | `data` |
|---|---|
| `file.uploaded.v1` | `{ fileId, namespace, filename, mimetype, size, sha256, visibility, scanStatus, attributes, retainUntil }` |
| `file.scanned.v1` | `{ fileId, namespace, scanStatus: "CLEAN\|INFECTED\|ERROR", signature?: "<virus name>" }` |
| `file.deleted.v1` | `{ fileId, namespace, reason: "USER\|OWNER\|RETENTION\|PURGE\|INFECTED\|UNCLAIMED", attributes }` |
| `file.claimed.v1` | `{ fileId, namespace, ownerType, ownerId, kind }` |
| `file.quota.threshold.v1` | `{ thresholdPercent: 80\|95\|100, usedBytes, quotaBytes }` |
| `files.tenant.exported.v1` | `{ requestId, bundleFileId, files, bytes }` |

Consumers must ignore unknown members; you only ever add members within `v1`.

### 4.7 Kafka topics owned or read by the upload service

| Topic | Direction | Owner of definition | Notes |
|---|---|---|---|
| `esma.files.replication`, `.processing`, `.audit`, `.dlq`, `.retry.{10s,1m,10m}` | internal | you | **already registered** by the platform (6 partitions, 7 d) |
| `esma.files.events.v1`, `.DLT` | publish | you (schema), platform (creation) | UR-11 |
| `esma.platform.usage.v1` | publish | platform | UR-12 |
| `tenant-entitlement-changed` | consume | platform | UR-13 |
| `esma.platform.tenant-lifecycle.v1` | consume | platform | UR-13.6 (`suspended`, `resumed`, `offboarded`) |
| `esma.platform.tenant-purge-requested.v1` | consume | platform | UR-18 |
| `esma.platform.tenant-purge-completed.v1` | publish | platform (shared receipt) | UR-18 |
| `esma.platform.tenant-export-requested.v1`, `…-completed.v1` | consume / publish | platform | UR-19 |

Naming follows `<domain>.<entity>.<event>.v1`; dead letters end `.DLT`. Tell us the partition count and retention you want for the new topics; defaults are 6 partitions, 7 days (`events.v1`: 14 days).

### 4.8 Identity claims you may rely on

User token (`iss` = identity): `sub`, `azp`, `organizationId`, `membershipId`, `branchId`, `branches[]`, `name`, `email`, `loginId`, `groups[]`, `permissionVersion`, `sid`, `access.{global,organization,client}.{roles[],permissions[]}`, `exp`; support access adds `supportAccess=true`, `supportGrantId`, `act{sub,…}`.
Service token: `sub`=`azp`=client id, `grant_type=client_credentials`, `scope`, `access.client.permissions`, `exp`.
Audience `esma-files` will be added to both (UR-01.4).

### 4.9 Error codes (problem+json)

| `code` | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | missing/invalid/expired token |
| `token_revoked`, `token_stale` | 401 | UR-09 |
| `forbidden` | 403 | action not permitted |
| `organization_required` | 400 | service principal without `X-Organization-Id` |
| `organization_mismatch` | 403 | header and token disagree |
| `namespace_unknown` | 400 | `X-Namespace` not in catalogue |
| `namespace_not_allowed` | 403 | principal may not use it |
| `not_found` | 404 | missing, deleted, or another organisation's file |
| `scan_pending` | 409 | read before scan finished (`Retry-After`) |
| `file_infected` | 422 | scan found malware |
| `scan_unavailable` | 503 | scanner down in fail-closed mode / scan error |
| `idempotency_conflict` | 409 | same key, different request |
| `payload_too_large` | 413 | over the namespace limit |
| `unsupported_media_type` | 415 | sniffed type not allowed or disagrees with declared |
| `validation_failed` | 422 | bad field (`errors[]` lists them) |
| `quota_exceeded` | 507 | UR-13 (`quotaBytes`, `usedBytes`, `requestedBytes`) |
| `tenant_suspended`, `tenant_purging` | 403 | UR-13.6, UR-18.5 |
| `rate_limited` | 429 | `Retry-After` |
| `legal_hold` | 409 | delete/purge blocked |
| `already_claimed` | 409 | UR-30: file is bound to another owner |
| `too_many_pending_uploads` | 429 | UR-29.6 |
| `unexpected` | 500 | anything else (no internals in `detail`) |

---

## 5. How the platform side uses this (so you can see the effect of your choices)

### 5.1 The browser flow (most user files)

```
Browser                    Gateway/Upload service                Backend (owning service)
   | 1 POST /uploads/api/v1/files/upload  (user token, X-Namespace)         |
   |---------------------------------------------->  201 {fileId, scanStatus:PENDING, claimed:false}
   | 2 poll GET .../files/{id}/metadata (user token) until CLEAN            |
   | 3 POST /<service>/api/v1/... { ..., fileId }  (the business request)   |
   |----------------------------------------------------------------------->|
   |                           4 GET .../{id}/metadata  (service token, X-Organization-Id)
   |                           5 checks: same org, namespace, uploader, not infected, size/type
   |                           6 POST .../{id}/claim {ownerType, ownerId, kind}
   |<-----------------------------------------------------------------------| 200 (saved with fileId)
   | later: GET /<service>/api/v1/.../attachments/{n}/url  → backend authorises → signed URL
   | 7 GET <signed url>  (no token)                                          |
```

The backend keeps the file id (never the URL). If the user abandons the form, the unclaimed sweeper removes the file after 24 h.

### 5.2 Per-caller table

"Browser" = flow 5.1 (the frontend uploads directly, the backend verifies and claims). "Service" = the backend uploads with its service token (`ownerType`/`ownerId` passed at upload, claimed at creation). During migration the backends accept **both** a multipart file (service flow) and a `fileId`/URL (browser flow) on the same endpoints.

| Caller | Namespace | Flow |
|---|---|---|
| SIS / LMS data-job and onboarding workbooks | `imports` | Browser: upload, send `fileId` with the job request; the backend verifies, claims (`ownerType=JOB_FILE`), keeps the id on the job row, the consumer reads by id. Service fallback: multipart through the backend with `waitForScan=20` |
| Job results (data-job exports, onboarding result sheets, bulk report-card ZIPs) | `generated-documents` | Service only; the user downloads through the owning service → signed URL (10 min) |
| Operations support attachments (school and platform desks) | `support-attachments` | Browser; claim with `ownerType=SUPPORT_TICKET` / `PLATFORM_TICKET`; reads via signed URL after the desk authorises |
| Assessment case evidence | `case-evidence` | Browser; claim with `ownerType=CASE_EVIDENCE`; same reads |
| Identity logos, hero images, avatars | `branding` | Browser; backend claims (`ORG_LOGO`, `ORG_AUTH_HERO_IMAGE`, `PERSON_AVATAR`); `publicUrl` stored for public ones |
| SIS student documents / homework | `student-documents`, `coursework-submissions` | Browser; SIS stores the file id on the document row; reads via SIS grants → signed URL |
| LMS lesson media | `learning-media` | Browser, large files via UR-32 |
| Operations changelog archive | `platform-archives` | Service (platform client) |
| Tenant export | `tenant-exports` | Service (platform client), multipart |
| Communications recordings | `session-recordings` | Service, multipart |

---

## 6. Definition of done and verification

You are done with a requirement when:
1. The behaviour in its **Acceptance** text is covered by an automated test in your repository (unit or integration), and passes in CI.
2. The OpenAPI document (UR-24) and `docs/events/*.schema.json` reflect it.
3. `CHANGELOG.md` names the requirement ids.
4. For M1: a tagged image is pushed and we run the **platform contract suite** against it. The suite (owned by platform, lives in `platform-storage`'s integration tests, runs against docker-compose with your image + Postgres + Kafka + SeaweedFS + ClamAV + a stub identity JWKS) covers: RS256 acceptance and `aud`/`iss` rejection; service upload with `X-Organization-Id`; cross-organisation 404; namespace limits and type sniffing; EICAR with `waitForScan`; owner list/delete; signed-URL grant and expiry; every error code in 4.9; quota 507; usage message shape; purge receipt.

**Suggested order:** UR-01 → UR-02 → UR-03 → UR-07 → UR-08 → UR-04/05/06 → UR-29/30 (M1 complete, tag `v0.2.0`) → UR-09/10/13/14 → UR-11/12 → UR-15/16/17 → M3.

---

## 7. Open points (answers from Upload Service team)

1. **Revocation keys (UR-09).** Confirmed. The upload service checks Redis keys `esma:revoked:sid:<sid>` and `esma:org-permission-version:<organizationId>`. If either key exists or if the token's `permissionVersion` is less than the active version, the request fails with 401 `token_revoked` / `token_stale`.
2. **Platform organisation id (UR-21).** Confirmed. `platform-archives` is strictly scoped to the reserved platform organisation id, requires service principal with `platform-archives` client permission, is exempt from quota and purge, and deletion requires `platform.files.admin`. No separate bucket is required; prefix isolation is handled inside SeaweedFS.
3. **Usage `aggregation` values (UR-12, UR-23).** Confirmed. `storage.bytes` uses `aggregation: "LAST"`, and `storage.egress.bytes` uses `aggregation: "SUM"` with `unit: "bytes"`.
4. **Image name and registry.** Confirmed. CI pushes `gitea.infra.elsoft.ng/esma/esma-upload-service-v2:<tag>` with immutable `<branch>-<sha8>` tags.
5. **Topic sizing.** Confirmed. Default 6 partitions, 7 days retention (`esma.files.events.v1`: 14 days retention).
6. **Storage topology.** Confirmed. Cloudinary replicas are strictly disabled for `private` namespaces; all private files reside exclusively on SeaweedFS with replication to local/backup stores. Daily backup cadence via `ops/backup/seaweed-backup.sh`.
7. **v1 facade retirement date (UR-25).** Marked as deprecated with target retirement date `2027-01-01`.
8. **Uploader identity (UR-29/30).** Stored as `uploadedBy` = token's `sub`. Support impersonation tokens record `act.sub` in the `acting_service` / audit context while `uploadedBy` remains the person `sub`.
9. **Gateway.** Confirmed. `GET`/`HEAD /uploads/api/v1/files/*` is the only open route. `CORS_ENABLED` defaults to `false` in production behind the gateway to prevent duplicate `Access-Control-Allow-Origin` headers.

## 8. Mapping from the observations document

| Old | New | Old | New |
|---|---|---|---|
| U-01 | UR-01 | U-12 | UR-13 |
| U-02 | UR-01 | U-13 | UR-18, UR-19 |
| U-03 | UR-09 | U-14 | UR-10, UR-25 |
| U-04 | UR-02 | U-15 | UR-25 |
| U-05 | UR-04 | U-16 | UR-22 |
| U-06 | UR-05 | U-17 | UR-26 |
| U-07 | UR-03 | U-18 | UR-24 |
| U-08 | done on platform side (4.7); new topics in UR-11/18/19 | U-19 | UR-20 |
| U-09 | UR-11 | U-20 | UR-28 |
| U-10 | done on platform side (0.1) | U-21 | UR-17 |
| U-11 | UR-12, UR-23 | U-22 | UR-10 |
| O-23 | UR-08.2 | O-26 | UR-08.3 |
| O-24 | UR-08.1 | O-27 | UR-10 |
| O-25 | UR-27 | | |

Questions to: Platform Architecture, Elsoft Engineering.
