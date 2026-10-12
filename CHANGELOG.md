# Changelog

All notable changes to the **ESMA Upload Service (v2)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-10-12

### 🚀 Milestone 2.0.0: ESMA Platform V2 Complete Compliance

This major release implements all requirements defined in `UPLOAD_SERVICE_V2_PLATFORM_REQUIREMENTS.md` (UR-01 through UR-32) and the browser upload contract `s05-browser-upload-frontend-contract-2026-10-12.md`.

---

### Implemented Requirements Breakdown

#### Milestone 1 (M1 — Unblock)
- **UR-01 (RS256 JWT & Identity Validation):** Enforced RS256 JWT validation against Identity Service JWKS endpoint (`IDENTITY_JWKS_URI`), strict `aud` (`esma-files`) and `iss` checking, with opt-in HS256 for local dev.
- **UR-02 (Service-to-Service Authorization):** Added support for client credentials tokens with `internal.files` scope, mandatory `X-Organization-Id` request header, and actor binding to the calling service.
- **UR-03 (Namespace Catalogue):** Implemented catalogue of 11 distinct namespaces (`imports`, `generated-documents`, `student-documents`, `support-attachments`, `case-evidence`, `branding`, `coursework-submissions`, `learning-media`, `session-recordings`, `tenant-exports`, `platform-archives`) selected via `X-Namespace`.
- **UR-04 (Private Visibility & Signed URLs):** Set `private` as strict default visibility; provided short-lived signed URLs (TTL ≤ 10 min) signed with HMAC-SHA256, supporting HTTP 206 `Range` byte-streaming.
- **UR-05 (Scan Semantics & waitForScan):** Integrated asynchronous and synchronous virus scanning via ClamAV daemon with fail-closed production semantics, `waitForScan` polling support, and scan statuses (`CLEAN`, `INFECTED`, `ERROR`, `PENDING`).
- **UR-06 (Owner Attributes Indexing):** Indexed reserved owner attributes (`ownerType`, `ownerId`, `kind`, `origin`) for rapid queryability, listing, and bulk deletion by owner.
- **UR-07 (RFC 9457 Problem Details):** Standardized error envelope to `application/problem+json` across all 19 platform error codes mapped directly to frontend message keys.
- **UR-08 (Startup & Migration Guards):** Added production startup validations requiring migrations to be run by the owner role ahead of runtime (`AUTO_MIGRATE=false`), standardizing `MIGRATION_CLI_PATH`.
- **UR-29 (Browser-Direct Upload Flow):** Implemented direct browser uploads authenticated via user bearer tokens, uploader-only read permissions while scanning, and abuse throttles (50 pending files / 500 MB max).
- **UR-30 (Backend Claim Flow):** Implemented `POST /uploads/api/v1/files/{id}/claim` for service principals to claim browser-uploaded files, with an automated 24-hour unclaimed file sweeper.

#### Milestone 2 (M2 — Go-Live)
- **UR-09 (Token Revocation & Permission Versioning):** Added real-time token revocation lookups via Redis and `permissionVersion` checking, auditing support access via `act` claims.
- **UR-10 (Dot-Notation Platform Permissions):** Replaced legacy role-name checks with standard dot-notation permission evaluation (`files.file.upload`, `files.file.read`, `files.file.delete`, `files.file.read.any`, `platform.files.admin`).
- **UR-11 (Canonical Domain Events):** Published canonical public events on `esma.files.events.v1` (`file.uploaded.v1`, `file.scanned.v1`, `file.deleted.v1`, `file.claimed.v1`, `file.quota.threshold.v1`, `files.tenant.exported.v1`).
- **UR-12 (Usage Metering):** Integrated daily tenant storage usage metering dispatched to `esma.platform.usage.v1` (`storage.bytes`, `aggregation=LAST`).
- **UR-13 (Commercial Quota & Suspension):** Dynamically synced quotas from `tenant-entitlement-changed` events, enforced HTTP 507 `quota_exceeded` error contract, and suspended uploads for inactive tenants (`tenant_suspended`).
- **UR-14 (Retention & Legal Holds):** Enforced retention limits (`retainUntil`), TTL sweepers, soft-delete tombstones, and blocked deletion on tenants subject to legal holds.
- **UR-15 & UR-31 (Branding & Browser Public Reads):** Permanent public URLs for branding assets, raster derivative generation (`thumb`, `medium`), and strict SVG XML sanitization.
- **UR-16 (Idempotency Contract):** Handled `Idempotency-Key` headers via Redis leases with SHA-256 payload conflict detection and `Idempotent-Replayed: true` responses.
- **UR-17 (Trace Correlation):** Propagated W3C `traceparent` and `X-Correlation-Id` across all incoming requests, responses, database logs, and outbox messages.

#### Milestone 3 (M3 — Lifecycle Operations)
- **UR-18 (Tenant Purge Orchestrator):** Implemented orchestrator consuming `esma.platform.tenant-purge-requested.v1`, cascading deletion in 500-item batches, rejecting purges during legal holds, blocking uploads during purge (`403 tenant_purging`), and emitting completion receipts to `esma.platform.tenant-purge-completed.v1`.
- **UR-19 (Tenant Export Worker):** Implemented export worker consuming `esma.platform.tenant-export-requested.v1`, assembling a streamed PKWARE ZIP archive with root `manifest.jsonl`, storing into `tenant-exports` with 14-day retention, and emitting completion receipts.
- **UR-20 & UR-32 (Large File Multipart Uploads):** Added complete multipart upload workflow (`POST /files/uploads`, `PUT /files/uploads/{id}/parts/{n}`, `POST /files/uploads/{id}/complete`) through the service without requiring third-party storage credentials in browsers.
- **UR-21 (Platform-Archives Namespace):** Hardened cold storage namespace `platform-archives` (exempt from tenant quota and tenant purge, requires `platform.files.admin` for deletion).
- **UR-22 (Tenant Isolation Hardening):** Strict `findByIdForTenant` scoping on all queries, returning 404 for cross-tenant access attempts.
- **UR-23 (Egress Metering):** Counted bytes delivered across streams, ranges, and redirects, publishing `storage.egress.bytes` (`aggregation=SUM`, `unit=bytes`) to `esma.platform.usage.v1`.

#### Hygiene & Operational Governance
- **UR-24 (OpenAPI 3.1 Specification):** Published interactive and machine-readable OpenAPI 3.1 documentation at `/uploads/api/docs-json` and generated `openapi/esma-upload-v1.json`.
- **UR-25 (Deprecate Legacy Keys):** Removed legacy `schoolId` keys and misspelled permission aliases.
- **UR-26 (Operational Documentation & Secret Rotation):** Added operational runbook `docs/runbook.md`, supported seamless secret rotation via `SIGNED_URL_SECRET_PREVIOUS`.
- **UR-27 (Ports, Metrics & Shutdown):** Separated worker health/metrics port (8081), added graceful shutdown draining, and protected metrics endpoints.
- **UR-28 (Modern Ecosystem Readiness):** Isolated message broker interactions behind `IMessageBroker` and prepared NestJS 11 modernization paths.

---

## [1.0.0] - 2026-10-02

### 🚀 Milestone 1.0.0: Production Release (Generic Upload Service)

This release marks the general availability (GA) of **ESMA Upload Service v2**, a complete rewrite from the historical Express v1 service into a resilient, high-throughput, multi-tenant Generic Upload Service (GUS) built on **NestJS 10** and Node.js 22.

---

### Added

#### Foundation & Core API (Phase 1 & Phase 3)
- **Unified Modern REST API:** Core endpoints mounted under `/api/v1/files/*` for upload, manifest lookup, HTTP 206 `Range` byte-streaming, and soft/hard deletion.
- **Enterprise Authentication:** Standardized OIDC Bearer token verification using RS256 JWKS against the live ESMA Identity Service (`https://api.esma.elsoft.ng/identity`).
- **API Key Authentication:** SHA-256 hashed API key validation supporting both tenant-scoped service accounts and cross-tenant SuperAdmin operations.
- **Zero-RAM Disk Staging (ADR-09):** Multipart upload streams are buffered directly into a private disk scratch directory, ensuring non-blocking SHA-256 hashing, rewindable MIME sniffing, and predictable Node event loop latency.
- **PostgreSQL System of Record (ADR-01):** Transactional storage of file manifests, multi-replica state tables, transactional outbox messages, and immutable audit logs.
- **Legacy Compatibility Facades:** Drop-in compatibility routes (`/api/tenant/upload/*` and `/api/admin/upload/*`) mapping requests transparently onto the v2 core engine.

#### Pluggable Storage & Multi-Tier Replication (Phase 2 & Phase 4)
- **Storage Driver Abstraction (`IStorageDriver`):** Unified driver contract supporting `local`, `seaweedfs` (S3 API), `cloudinary`, and `hybrid` topologies.
- **Fast-Path Replication:** Synchronous durable write to the primary storage driver with non-blocking, asynchronous replication to secondary drivers.
- **Safe Visibility Controls:** Strict visibility enforcement (`public`, `internal`, `tenant`, `restricted`). Non-public files are mathematically prevented from reaching public CDN drivers (Cloudinary).
- **Online Storage Promotion:** Zero-downtime primary storage promotion CLI (`storage:promote`) with keyset-paginated replica verification.
- **Storage Reconciler:** Background auditor detecting and fixing replica drift and desynchronized records.

#### Enterprise Event Bus & Background Workers (Phase 5)
- **Pluggable Event Brokers (`IMessageBroker`):** Pluggable broker implementation supporting Apache Kafka (KRaft), Apache Pulsar, and an in-memory test broker.
- **Transactional Outbox Relay:** PostgreSQL `LISTEN/NOTIFY` instant wake-up triggering reliable, at-least-once message delivery to brokers.
- **Asynchronous Antivirus Scanning:** ClamAV daemon integration with automated quarantine and manifest rejection for infected streams.
- **Dead-Letter Queue (DLQ) & Redrive:** Exponential backoff retry policies, persistent DLQ storage, and administrative inspection/redrive CLI (`dlq:stats`, `dlq:redrive`).
- **Tombstone Purge & Retention:** Automated deletion cascade purging soft-deleted files and storage objects after configured retention windows.

#### Observability, Security & Production Readiness (Phase 6)
- **Comprehensive Prometheus Metrics:** Exposed at `GET /metrics`, tracking HTTP request duration, upload volume by tenant/namespace, driver latencies, outbox lag, dedup rates, and DLQ depth.
- **Distributed Tracing & Health Probes:** Standardized `GET /healthz` (liveness) and `GET /readyz` (PostgreSQL/Redis dependency readiness).
- **Idempotency & Deduplication:** Client-supplied `Idempotency-Key` tracking via Redis leases with duplicate SHA-256 content hash detection and metric emission.
- **Security Audit & Abuse Suite:** Automated 100% route authorization audit in CI, along with a 21-vector abuse test suite (path traversal, null bytes, polyglot payloads, header injection).
- **Performance Profiling & Chaos Verification:** Automated k6 load benchmarks (`test:perf`) and 7 chaos resilience failure scenarios (`test:chaos`).

---

### Removed

- **Legacy Engine Rollout Flags:** Removed `LEGACY_ENGINE` and `LEGACY_DEFAULT_VISIBILITY` configuration toggles; the service runs exclusively on the hardened v2 core engine.
- **Dead Code Paths:** Decommissioned legacy unauthenticated routes, insecure static file serving, and ad-hoc Multer in-memory buffers.

---

### Changed (Breaking Changes from v1)

- **Default Visibility:** Files default to `tenant` scope rather than global `public`.
- **Enforced Authentication:** All routes require a valid JWT or API key. Unauthenticated access is blocked with HTTP 401.
- **Canonical URLs:** File URLs now point to canonical `/api/v1/files/:fileId` endpoints instead of direct third-party vendor URLs.
