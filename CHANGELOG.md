# Changelog

All notable changes to the **ESMA Upload Service (v2)** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
