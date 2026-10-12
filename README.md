# ESMA Upload Service v2 (GUS: Generic Upload Service)

[![Build & Test](https://img.shields.io/badge/CI%2FCD-passing-brightgreen)]()
[![Node Version](https://img.shields.io/badge/node-%3E%3D22.0.0-blue)]()
[![Framework](https://img.shields.io/badge/framework-NestJS%2010-red)]()
[![Version](https://img.shields.io/badge/version-2.0.0-green)]()

> The canonical, multi-tenant file ingestion, replication, scanning, lifecycle, and event streaming engine for the ESMA platform. Built on **NestJS 10** and Node.js 22.
> Fully compliant with **Platform Requirements v2 (UR-01 through UR-32)** and the **Browser-Direct Upload Contract**.

---

## 📑 Table of Contents

- [1. Overview & Architecture](#1-overview--architecture)
- [2. Quick Start & Deployment](#2-quick-start--deployment)
- [3. Configuration & Environment Variables](#3-configuration--environment-variables)
- [4. Namespace Catalogue](#4-namespace-catalogue)
- [5. API Specifications & Contracts](#5-api-specifications--contracts)
- [6. Public Domain Events & Outbox](#6-public-domain-events--outbox)
- [7. Operational CLI Tools & Runbooks](#7-operational-cli-tools--runbooks)
- [8. Testing & Verification](#8-testing--verification)

---

## 1. Overview & Architecture

ESMA Upload Service v2 is the **sole platform gateway** for storing, scanning, claiming, reading, and purging files across all ESMA products (SIS, LMS, Assessment, Operations, Identity, Backoffice).

### Core Architectural Guarantees

1. **System of Record in PostgreSQL:** Transactional metadata, multi-replica state, soft-delete tombstones, quota tracking, and transactional outbox rows.
2. **Zero-RAM Disk Staging (ADR-09):** Streaming multipart ingestion directly to an encrypted scratch directory, allowing rewindable MIME sniffing, chunked SHA-256 hashing, and non-blocking uploads without heap starvation.
3. **Pluggable Multi-Tier Storage (`IStorageDriver`):** Standardized drivers for SeaweedFS (primary S3 blob store), Cloudinary (CDN), and local disk.
4. **Antivirus Scanning with Fail-Closed Semantics:** ClamAV daemon integration with synchronous `waitForScan` polling, asynchronous worker quarantine, and strict fail-closed production mode (`SCAN_FAIL_MODE=closed`).
5. **Browser-Direct Upload & Backend Claim Flow (UR-29, UR-30):** Frontends upload directly with user bearer tokens; backends claim files with `POST .../claim` (`ownerType`, `ownerId`, `kind`). Unclaimed files are swept after 24 hours.
6. **Strict Tenant Isolation & RFC 9457 Errors:** Scoped lookups (`findByIdForTenant`), cross-tenant access returns HTTP 404, standardized `application/problem+json` error responses.
7. **Lifecycle Automation (UR-18, UR-19):** Complete tenant purge orchestrator with batch-500 deletion, legal hold checks, PKWARE ZIP tenant export bundles with `manifest.jsonl`, and usage/egress metering.

---

## 2. Quick Start & Deployment

### Ports & Global Routing
- **API Server:** Port `7030`, Global Prefix `/uploads` (e.g. `http://localhost:7030/uploads/api/v1/files/...`).
- **Worker Process:** Health & Metrics on port `8081` (`/health/live`, `/health/ready`, `/metrics`).
- **Kubernetes / Gateway:** Gateway mounts `/uploads/**` to `esma-upload-service:7030`. `GET`/`HEAD /uploads/api/v1/files/{id}` is open at the gateway (signed URLs and public files carry their own proof).

### Starting the Service
```bash
# Run database migrations with owner role
npm run migrate:up

# Start API server
npm run start:prod

# Start background worker
npm run start:worker:prod
```

---

## 3. Configuration & Environment Variables

All settings are validated at boot with strict Zod runtime schemas ([`src/config/schema.ts`](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/src/config/schema.ts)).

| Variable | Default | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Runtime environment (`development`, `test`, `production`) |
| `PORT` | `7030` | HTTP listener port |
| `APP_BASE_URL` | `http://localhost:7030/uploads` | Public base URL used for absolute signed URLs |
| `AUTO_MIGRATE` | `true` (dev) / `false` (prod) | Production startup guard refusing startup if migrations are pending |
| `DATABASE_URL` | - | PostgreSQL connection URI |
| `IDENTITY_JWKS_URI` | `https://api.esma.elsoft.ng/identity/.well-known/jwks.json` | OIDC JWKS public key endpoint (RS256) |
| `IDENTITY_ISSUER` | `https://api.esma.elsoft.ng/identity` | Expected JWT issuer claim (`iss`) |
| `JWT_AUDIENCE` | `esma-files` | Expected JWT audience claim (`aud`) |
| `JWT_ALGORITHMS` | `RS256` | Supported JWT algorithms (`RS256`, optional `HS256` in dev) |
| `SIGNED_URL_SECRET` | - | Active secret key for HMAC-SHA256 signed download tokens |
| `SIGNED_URL_SECRET_PREVIOUS` | - | Previous secret during secret rotation (UR-26) |
| `STORAGE_DRIVER` | `seaweedfs` | Primary storage provider (`seaweedfs`, `local`, `cloudinary`, `hybrid`) |
| `EVENT_BROKER` | `kafka` | Messaging broker (`kafka`, `pulsar`, `memory`) |
| `KAFKA_BROKERS` | `localhost:9092` | Comma-separated Kafka broker addresses |
| `CLAMAV_HOST` / `PORT` | `localhost:3310` | ClamAV antivirus daemon address |
| `SCAN_FAIL_MODE` | `closed` | Fail mode (`closed` blocks file access if scanner is offline) |
| `METRICS_TOKEN` | - | Bearer token required for `/metrics` when set |
| `WORKER_HEALTH_PORT` | `8081` | Dedicated worker health & metrics port |

---

## 4. Namespace Catalogue

Every file uploaded belongs to a namespace governed by catalogue rules (UR-03, §4.3):

| Namespace | Max Size | Allowed Types (Sniffed) | Default Visibility | Scan | Allowed Principals | Retention |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `imports` | 25 MB | xlsx, xls, csv, ods | `private` | Yes | User, Service | 30 d / 90 d |
| `generated-documents` | 200 MB | pdf, zip, xlsx, csv, json, txt, docx | `private` | No | Service | 30 d / 365 d |
| `student-documents` | 20 MB | pdf, jpg, png, webp, docx | `private` | Yes | User, Service | Permanent |
| `support-attachments` | 10 MB | jpg, png, webp, gif, pdf, txt, log, csv, zip | `private` | Yes | User, Service | 730 d / 3650 d |
| `case-evidence` | 50 MB | jpg, png, pdf, mp3, m4a, wav, mp4, docx | `private` | Yes | User, Service | Permanent |
| `branding` | 10 MB | png, jpg, webp, svg (sanitized) | `public` | Yes | User, Service | Permanent |
| `coursework-submissions` | 50 MB | pdf, docx, xlsx, pptx, jpg, png, zip, txt | `private` | Yes | User, Service | Permanent |
| `learning-media` | 500 MB | jpg, png, webp, gif, mp3, m4a, mp4, webm, pdf | `tenant` | Yes | User, Service | Permanent |
| `session-recordings` | 5 GiB | mp4, webm, mkv, m4a | `private` | Yes (async) | Service | 365 d / 1825 d |
| `tenant-exports` | 5 GiB | zip, bin, enc, json | `private` | No | Service (Platform) | 14 d / 30 d |
| `platform-archives` | 1 GiB | json, jsonl, gz, zip, parquet | `private` | No | Service (Platform) | 2,555 d (7 yrs) |

---

## 5. API Specifications & Contracts

Interactive documentation: `/uploads/api/docs` (OpenAPI 3.1 JSON at `/uploads/api/docs-json` and [`openapi/esma-upload-v1.json`](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/openapi/esma-upload-v1.json)).

### Standard Request Headers
- `Authorization: Bearer <jwt>` — User token or service-to-service token.
- `X-Organization-Id: <uuid>` — Mandatory for service principals.
- `X-Namespace: <namespace>` — Selected catalogue namespace.
- `Idempotency-Key: <key>` — Prevents duplicate uploads across network retries.
- `traceparent` / `X-Correlation-Id` — Distributed trace propagation.

### Primary Endpoints
1. **Direct Upload (`POST /uploads/api/v1/files/upload`)**
   - Form-data: `file` (1..10), `folder`, `visibility`, `tags`, `attributes`, `retentionDays`, `waitForScan`.
   - Response: `201 Created` with manifest `{ data: { fileId, filename, mimetype, size, scanStatus, claimed, ... } }`.
2. **Metadata Lookup (`GET /uploads/api/v1/files/:id/metadata`)**
   - Returns manifest. Allowed for the uploader even while `scanStatus=PENDING`.
3. **Signed Download URL (`POST /uploads/api/v1/files/:id/signed-url`)**
   - Generates an absolute download URL with HMAC-SHA256 signature (TTL ≤ 10 minutes).
4. **Content Download (`GET /uploads/api/v1/files/:id?redirect=never`)**
   - Supports HTTP `Range: bytes=...` with `206 Partial Content`, `ETag`, and byte egress counting.
5. **Backend Claim (`POST /uploads/api/v1/files/:id/claim`)**
   - Service principals bind browser-uploaded files to business records (`ownerType`, `ownerId`, `kind`). Idempotent.
6. **Large File Multipart (`/uploads/api/v1/files/uploads/*`)**
   - `POST .../uploads` (init), `PUT .../parts/:partNumber` (stream part), `POST .../complete` (assemble manifest), `DELETE ...` (abort).
7. **Owner Query & Deletion (`GET / DELETE /uploads/api/v1/files?ownerType=...&ownerId=...`)**
   - Query and batch delete by indexed owner attributes.
8. **Tenant Storage Quota (`GET / PATCH /uploads/api/v1/admin/tenants/:org/quota`)**
   - Admin quota management and dynamic commercial plan overrides.

---

## 6. Public Domain Events & Outbox

All external events follow the canonical envelope emitted to `esma.files.events.v1` (partition key: `organizationId`):

```json
{
  "eventId": "<uuid>",
  "eventType": "file.uploaded.v1",
  "occurredAt": "2026-10-12T00:00:00Z",
  "organizationId": "<uuid>",
  "producer": "esma-upload-service",
  "traceId": "<w3c-trace-id>",
  "correlationId": "<correlation-id>",
  "actor": { "type": "USER", "id": "<sub-id>", "actingService": null },
  "data": { ... }
}
```

Validated against JSON schemas in [`docs/events/`](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/docs/events/):
- `file.uploaded.v1.schema.json`
- `file.scanned.v1.schema.json`
- `file.deleted.v1.schema.json`
- `file.claimed.v1.schema.json`
- `file.quota.threshold.v1.schema.json`
- `files.tenant.exported.v1.schema.json`

---

## 7. Operational CLI Tools & Runbooks

Operational runbooks are documented in [`docs/runbook.md`](file:///c:/Users/PC/Documents/React%20and%20js/esma-upload-services/esma-upload-service-v2/docs/runbook.md):
- **Startup Failure Diagnosis**: Resolving missing migrations (`AUTO_MIGRATE=false`) and configuration errors.
- **DLQ Triage & Redrive**: Inspecting poisoned messages and re-dispatching them via `npm run dlq:redrive`.
- **Storage Replica Recovery**: Automatic drift resolution via `npm run reconcile:orphans`.
- **Signed URL Secret Rotation**: Zero-downtime rotation using `SIGNED_URL_SECRET` and `SIGNED_URL_SECRET_PREVIOUS`.

---

## 8. Testing & Verification

The test suite covers unit logic, contract tests, security abuse vectors, and full platform requirement acceptance:

```bash
# Execute full unit & contract test suite (60 test suites, 574 tests)
npm test

# Verify TypeScript compilation and NestJS build
npm run build
```
