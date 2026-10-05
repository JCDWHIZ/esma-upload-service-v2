# ESMA Upload Service: Review Findings & Decision Log

> Date: 2026-09-22 (updated). Original review: 2026-09-21.
> **Update 2026-09-22 (v2 of this document):** The plan changed from "migrate the legacy app to NestJS" to a ground-up rewrite. `esma-upload-service` is now frozen — no further changes, and not a source for new code. `esma-upload-service-v2` is built from scratch from the functional/business requirements, using the legacy app only as a behavioral reference (to confirm what a route is expected to do). Phase 0 ("stabilize and secure the legacy app") is removed; its findings are now day-one requirements of the Phase 1 build instead of fixes applied to legacy code first.
> **Workspace layout (updated 2026-09-22):** The workspace root is `esma-upload-services/`. The frozen legacy Express v1 app lives at `esma-upload-services/esma-upload-service/` (reference only). The NestJS v2 rewrite lives at `esma-upload-services/esma-upload-service-v2/` (scaffold generated via `nest new .`). All documentation now lives at `esma-upload-services/docs/` (previously inside `esma-upload-service/docs/`).
> Scope: cross-review of `ARCHITECTURE_AND_ROADMAP.md` (v1, target) and `CURRENT_ARCHITECTURE_AND_IMPLEMENTATION (1).md` (v1, as-is).
> Output of the review: v2 of the architecture document, a corrected as-is document, and `BACKEND_TASKS.md`.

## 1. Method and limits

The review used only the two documents. **The source code was not available**, so statements about current behavior come from the as-is document and are treated as claims. Where a finding depends on code behavior that the documents do not settle, it is tagged **Verify**, and the task list tells the implementing agent to confirm it before acting (Assumption Register in `BACKEND_TASKS.md`, section 3).

> **Note for implementers (2026-09-22):** The source code of the legacy Express app is now available at `esma-upload-services/esma-upload-service/`, but it is read-only reference material for confirming expected behavior — never a source to copy or port from. v2 is a fresh implementation of the requirements below, not a patched or migrated version of that code. Many assumptions in the register (A-01 through A-10) can be resolved by reading the as-is document or, where needed, inspecting the frozen legacy files purely to confirm documented behavior.

Severity: **Critical** (exploitable now, or data loss), **High** (breaks the plan or a security control), **Medium** (wrong or missing design that will cost rework), **Low** (inconsistency or hygiene).

---

## 2. Findings

IDs are stable references, not a contiguous sequence (some numbers were merged or dropped during review).

### 2.1 Cross-document inconsistencies

| ID | Sev | Finding | Resolution | Fixed by |
| :--- | :--- | :--- | :--- | :--- |
| F-01 | Low | Target `.env.example` uses `PORT=5000`. Current service runs on `7030` (`.env`, Dockerfile `EXPOSE`). | v2 uses `7030`. | ARCH §10 |
| F-02 | High | Current Cloudinary folders are `uploads/schools/...` for tenants and `admin/...` for admin (no `uploads/` prefix). The roadmap's mapping table and manifest use `schools/...` and `admin/...` with no root folder, and a single global root would still be wrong for admin. Existing `public_id` values would not match new keys. | Per-namespace `cloudinaryRootFolder` policy field (`uploads` for tenant, empty for admin). Legacy `public_id` computed to match. | ARCH §3.3, P2-03, P3-04 |
| F-03 | High | Roadmap keeps legacy facades but defines a new manifest response and never says how legacy fields (`public_id`, `secure_url`, `next_cursor`, `rate_limit_allowed`) or `:publicId` lookups (delete, inspect) work when the source of truth is no longer Cloudinary. Existing assets are not in any metadata store. | Additive-only facade contract, `legacy_public_id` column, id resolution, Cloudinary backfill script. | ARCH §9.4, P3-02..P3-04 |
| F-04 | Critical | The roadmap refactors the routes without mentioning the five defects listed in the as-is document (admin routes unauthenticated, tenant temp-file leak, `req.file` bug, public `/uploads`, weak MIME filter). Building v2 without addressing them would carry them into the new code. | Every defect is a day-one design requirement of the v2 rewrite in Phase 1, not a fix applied to legacy code or a separate stabilization phase. | ARCH §13, P1-02, P1-09, P1-10, P1-12, P1-15 |
| F-05 | High | Phase dependency inversions: canonical route and manifest (Phase 3) need the metadata store (Phase 5); hybrid publishes events (Phase 3) before a broker exists (Phase 4); legacy facades (Phase 1) precede the storage abstraction (Phase 2). | Re-ordered: DB in Phase 1, drivers before facades, in-process broker and outbox in Phase 4 before Kafka and Pulsar. | ARCH §13 (ADR-03) |
| F-06 | Low | As-is says "16 routes"; the tables list 17 rows (6 tenant, 7 admin, 4 system). Naming differs by actor: tenant `/multiple-fields` vs admin `/fields`; tenant `/files/:publicId` vs admin `/file/:publicId`. | Count corrected. Naming kept for compatibility, documented. New API is uniform under `/api/v1`. | As-is §8 |
| F-07 | Low | As-is uses `validateTenantMiddleware` in routes and describes `validateTokenMiddleware` plus `validateSchoolHeadersMiddleware` in the chain. | Documented as a composition to verify. Task starts by confirming. | As-is §6.2, A-03 |
| F-08 | High | Target local storage path `./uploads/storage` sits inside `./uploads`, which the current code serves publicly with `express.static`. Keeping both would expose "private" local storage. | v2 never has a static route serving storage (designed out from the start, P1-01). Staging dir and storage root are separate, outside any served path. | ARCH §4.4, §10 |
| F-09 | Medium | Topic names differ inside v1: `files.replication` (diagram) vs `esma.files.replication` (text). Event names (`file.replicate`) and topics are conflated. | Logical topic names in code, one `TopicMap` for physical names. Catalog separates commands and events. | ARCH §8.2, §8.3 |
| F-10 | Medium | Replica status vocabulary is inconsistent: `SYNCED` (text), `AVAILABLE` (sample), `QUEUED/IN_PROGRESS/SYNCED/FAILED` (list), aggregate `IN_PROGRESS` in a response the sequence diagram says is `QUEUED`. | Replica: `QUEUED, IN_PROGRESS, AVAILABLE, FAILED, DELETING, DELETED`. Aggregate: derived by one pure function. | ARCH §5.2 |
| F-11 | Medium | Sample manifest shows local copy `AVAILABLE` at +80 ms and SeaweedFS at +120 ms while the text and sequence diagram say only the primary is written synchronously. `primary` duplicates one entry in `replicas`. | Sample redone to match the fast path. `primaryProvider` string replaces the duplicate object. | ARCH §9.2 |
| F-12 | Medium | Sample manifest: `fileId` is 24 characters (ULID is 26). `hash` is the SHA-256 of empty input (`e3b0c442...b855`) next to a 2.4 MB size. Internal cluster URLs (`seaweedfs.internal:8333`) are returned to clients. Hash algorithm unnamed. | UUIDv7, field named `sha256`, illustrative value, no internal URLs in responses. | ARCH §9.2 (ADR-10) |
| F-13 | Medium | Virus scan appears as a synchronous validation step in the layered diagram and as a background job in the objectives. | Magic-byte check synchronous. Virus scan asynchronous with read gating via `scan_status`. | ARCH §4.4 (ADR-15) |
| F-14 | Medium | Metadata store is "PostgreSQL / MongoDB / Redis" (undecided). The compose deliverable lists Redis but not Postgres, and gives Redis no role. | PostgreSQL is the system of record. Redis for rate limits and cache. Compose includes both. | ARCH §5, §11 (ADR-01) |
| F-15 | Low | Two audit sinks: durable Kafka topic `esma.files.audit` and a database audit table in Milestone 5. | Postgres append-only table is the source of truth. The topic is an optional stream fed by the outbox. | ARCH §8.2 (ADR-17) |

### 2.2 Design flaws in the target architecture

| ID | Sev | Finding | Resolution | Fixed by |
| :--- | :--- | :--- | :--- | :--- |
| F-17 | High | `HybridStorageDriver implements IStorageDriver` but must write the database and publish events (per the sequence diagram). A storage driver would depend on the DB and the broker, contradicting the clean-architecture diagram that places them as siblings under the core. | Drivers are pure I/O. `StoragePlacementService` and `UploadService` own topology, DB and events. "Hybrid" becomes a configuration mode. | ARCH §6.3 (ADR-04) |
| F-18 | Medium | "Fastest responding target" is impossible with one input stream without duplicated I/O, makes the primary non-deterministic, and "auto-discovery" of configured drivers can silently drop replicas when a secret is missing. | Deterministic primary with ordered failover. `auto` allowed but explicit list recommended, strict startup validation. | ARCH §6.3 (ADR-05) |
| F-19 | High | `IStorageDriver` cannot express what real drivers need: Cloudinary `resource_type` for delete and read (today the code probes image, video, raw), range reads (the local driver section promises them), checksum verification after copy, paged listing, transformations, idempotent delete. | Interface v2 with `ProviderRef.meta`, `stat`, `ReadOptions`, capabilities, `DirectUrlOptions`. | ARCH §6.1 |
| F-20 | Critical | Sequence is: save manifest, publish event, respond. A crash or broker outage between save and publish leaves a file with no replication and nothing to notice it. | Transactional outbox plus relay, plus reconciler sweeps. | ARCH §8.4, P4-04, P4-10 (ADR-06) |
| F-21 | High | Delivery semantics are not addressed (duplicates, ordering). Partition key `tenantId` makes hot partitions and gives ordering nobody needs; the ordering that matters is per file (replicate before purge). Pulsar `Failover` for "singleton" replication contradicts horizontal scaling. | At-least-once plus idempotent handlers. Key by `fileId`. `Key_Shared` on Pulsar. | ARCH §8.5..8.7 (ADR-07) |
| F-22 | High | `subscribe(handler)` returns `void`. There is no way to express ack, retry with delay, or dead-letter, yet the milestones require retry with exponential backoff and a DLQ. Kafka has no native delayed retry, Pulsar does. | `HandlerOutcome` plus a broker-neutral consumer framework with identical observable retry behavior. | ARCH §8.5 (ADR-08) |
| F-23 | High | Delete versus in-flight replication race: a late replication job can recreate a replica of a deleted file. | Status checks after claim, `DELETING` state, purge command, tests for the race. | ARCH §7.3, P4-09 |
| F-24 | High | Retrieval design: `Redirect: follow` is a fetch option, not a request header. A 302 to `seaweedfs.internal` is unreachable by clients. There is no read authorization model. `<img src>` cannot send bearer tokens. | `redirect` query parameter, client-reachable URLs only, visibility model, signed URLs. | ARCH §4.3, §7.2 (ADR-11) |
| F-25 | Critical | Generic ingress "reads `x-namespace`, `x-tenant-id`" from headers. Trusting client headers for tenant identity allows tenant spoofing. The API key model (storage, hashing, scopes) is undefined. | API keys bound to namespace and tenant list. Headers can only select within the credential's grants. | ARCH §3.2, §4.1 (ADR-12) |
| F-26 | High | Replicating every file to Cloudinary publishes private school documents on a public CDN URL. No visibility concept exists. Current Cloudinary uploads are already public-by-URL. | `visibility` on every file, policy `cloudinaryReplication`, `type: authenticated` if private delivery is ever needed. | ARCH §3.4, §4.3 |
| F-27 | Medium | Local replica on a multi-node deployment lands on the node that ran the worker. | Documented as single-node or shared-volume only, startup warning. | ARCH §6.4 (ADR-20) |
| F-28 | Medium | Not stated whether workers run inside the API process. | Separate process from the same image. | ARCH §2.1 (ADR-14) |
| F-29 | Medium | Missing entirely: quotas and rate-limit design, idempotency, health and readiness endpoints, CORS policy, observability, CI quality gates, backup and retention, ClamAV infrastructure. | Added as tasks. | P6-01..P6-09, P1-15 |
| F-30 | Medium | `kafkajs` has, to my knowledge, had no release since 2023 (**Verify**). `pulsar-client` is a native binding, and CI builds `linux/arm64` on `node:20-bullseye`. | Client spikes before drivers, both behind `IMessageBroker`. | P5-01, P5-03 |
| F-31 | Medium | Node 20 reached its scheduled end of life in April 2026. Debian 11 (bullseye) standard LTS support was scheduled to end in August 2026 (**Verify** both). | Move to Node 22 LTS or newer on a bookworm-based image. | P1-15 (ADR-18) |
| F-32 | Medium | `RequestContext.userId` is required but `TokenPayload.userId` is optional. `roles[]` vs token `role`. `tenantId` optional in the core. `metadata: any` from clients flows into a trusted object. | Context v2 with defined fallbacks and an untrusted `attributes` bag. | ARCH §3.1 |
| F-33 | Low | Example env has `SEAWEEDFS_ACCESS_KEY=any`. Many variables needed by the plan are missing (DB, Redis, auth, limits). | Full reference with dev-only notes. | ARCH §10 |
| F-35 | Medium | Multi-file semantics on partial failure are undefined. Today `Promise.all` orphans already-uploaded files. | v1: `207` per-file results. Legacy: all-or-nothing with compensation. | ARCH §9.1, §9.4 |
| F-36 | Low | Bulk delete uses `DELETE` with a JSON body. Some proxies and clients drop DELETE bodies. | v1 uses `POST /bulk-delete`. Legacy route kept. | ARCH §9.1 |

### 2.3 Gaps and new defects in the as-is document

| ID | Sev | Finding | Resolution | Fixed by |
| :--- | :--- | :--- | :--- | :--- |
| F-40 | Critical | Section 11.1 prints a JWT secret and Cloudinary API key and secret in plain text. If `.env` was ever committed (the `.gitignore` description does not list it), these are in git history. **Verify.** | Values removed from the document. v2 is configured with fresh credentials, never the retired ones; secret scanning built in from the start. | P1-02 |
| F-41 | High | On tenant routes Multer writes the upload to disk **before** authentication runs (visible in both the flow diagram and the sequence diagram). Any unauthenticated client can fill the disk. Not listed in the bug section. | v2's ingestion pipeline runs `AuthGuard` before the file interceptor by construction. | P1-12 |
| F-42 | High | Delete authorization uses `publicId.startsWith("uploads/schools/" + schoolId)`. School `SCH_1` matches assets of `SCH_10`. Branch-level tokens can delete other branches' files. | v2 authorizes by a DB-backed tenant/sub-tenant check from the start, never a string-prefix match. | P1-10 |
| F-43 | High | Admin `?folder=` is passed into the Cloudinary folder path with no described sanitization. | Validate against `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, no `..`. | P1-12 |
| F-44 | Medium | JWT verification: no algorithm pinning described, `exp` checked manually (a token with no `exp` may pass), one shared secret for tenant and admin with no role or audience separation. | Pin `HS256`, require `exp`, separate role check for admin, key ring. | P1-09 |
| F-45 | Medium | Bulk delete accepts an unbounded `publicIds` array. | Cap at 100. | P1-12 |
| F-46 | Low | `/api/test` returns "Hello World" as a health check. Swagger UI and `/docs.json` are public. CORS configuration is not described. | `/health/live`, `/health/ready`, gated docs, explicit CORS allowlist. v2 exposes no `/api/test`-style trivial check. | P1-15 |
| F-47 | Low | `__dirname` is not defined in ES modules unless derived from `import.meta.url`. Compiled `dist/index.js` resolves `__dirname` to `dist`, while Multer writes to `process.cwd()/uploads`. The static route and the scratch directory may point at different places in Docker. **Verify.** | Moot: v2 is an ESM NestJS project from the start with no `__dirname`/static-route ambiguity to inherit. | P1-01 |
| F-48 | Low | `NODE_ENV=Development` (capitalized). Libraries compare against lowercase. | Lowercase, validated by config schema. | P1-02 |
| F-49 | Low | Dockerfile: `npm i` instead of `npm ci`, both stages use the full `node:20-bullseye` image, apparent root user, no `HEALTHCHECK`. | Written fresh for v2 with these practices from the first commit. | P1-15 |
| F-50 | Medium | CI has build and deploy stages only: no tests, lint, type check, dependency audit or image scan. Image is `arm64` only. The `restart` script is outside the repo and will need to run migrations. | New pipeline, built for v2 from the first commit. | P1-13, P6-06 |
| F-51 | Low | MIME list has `image/jpg` (not a real type) and refers to `docx`/`pdf`/`xlsx` without the full MIME strings. Error text says only JPEG, PNG and GIF are allowed. Filtering trusts client-declared types. | Detected-type allowlist with full MIME strings. | P1-12 |
| F-52 | Low | Listing and inspection depend on the Cloudinary Search and Admin APIs (rate limited, hence the `rate_limit_allowed` field). | Database-backed listing. | P3-03 |
| F-53 | Low | `getAdminFileDetails` probes three resource types (up to three API calls). | `resource_type` stored in `provider_meta`. | P2-03 |
| F-54 | Low | `publicId` contains slashes. As a path parameter it must be URL-encoded. Some proxies decode `%2F`. | Support the Express 5 wildcard form as well. | P3-02 |
| F-55 | Low | The architecture flowchart in the as-is document does not render: the edge label `Bearer Token (optional in routes)` contains parentheses and is unquoted, which is a Mermaid syntax error. Found by parsing every diagram with Mermaid. | Label quoted. All diagrams in the four documents now parse. | As-is §4 |
| F-56 | High (planning) | Mid-review, the plan changed twice: first from plain Express to NestJS, then from "migrate the framework, carry legacy code forward" to a ground-up rewrite with the legacy app frozen and used only as a behavioral reference. Every task needed re-reading against this, not just a find-and-replace, because a rewrite changes not only which framework primitive is used but where each requirement is even implemented. | ADR-21, plus a concept-mapping table (ARCH §2.0) so every reference to "middleware" or "route" has one agreed Nest equivalent. There is no Phase 0 and no wrapped legacy code: P1-01 onward is Nest-native and requirements-driven from the first task. | ARCH §2.0, BACKEND_TASKS.md §1.7, P1-01 |

---

## 3. Decision Log

Status **Proposed** means the decision was made in this review to keep the plan moving. Override it before the phase that depends on it begins by editing this table and the affected sections.

| ADR | Decision | Rationale | Alternatives considered | Affects |
| :--- | :--- | :--- | :--- | :--- |
| ADR-01 | PostgreSQL is the metadata system of record. Redis is auxiliary only. | Transactions (state plus outbox), relational filtering, keyset pagination, append-only audit. | MongoDB (no multi-row atomic outbox pattern as simple), Redis as store (durability, querying). | Phase 1 |
| ADR-02 | Security and correctness defects found in the legacy app are treated as day-one design requirements of the v2 rewrite, not fixes applied to the legacy code. The legacy app is frozen and never patched. | They are exploitable in the legacy app, but that app is being replaced outright, not incrementally repaired; building v2 correctly from the start removes them without spending effort on code that will be discarded. | Patch the legacy app first as a separate phase (delays the rewrite, and the fix is thrown away anyway once legacy is retired); fix during refactor of legacy code (there is no such refactor — v2 is a rewrite, not a refactor). | Phase 1 |
| ADR-03 | Roadmap phases re-ordered as in ARCH §13. | Removes dependency inversions (F-05). | Keep v1 order (not buildable). | All |
| ADR-04 | Drivers are pure I/O. Replication and events live in core services. No `HybridStorageDriver`. | Layering, testability, F-17. | Keep hybrid as a driver. | Phases 2 and 4 |
| ADR-05 | Deterministic primary with ordered failover. Replica list explicit in production. | Predictability, F-18. | Race writers, or infer topology only. | Phase 4 |
| ADR-06 | All events go through a transactional outbox. | Removes lost-event window, F-20. | Direct publish plus reconciler only (still loses events until the sweep). | Phase 4 |
| ADR-07 | At-least-once delivery, idempotent handlers, partition key `fileId`. | Per-file ordering is the real need, F-21. | Exactly-once semantics (not portable across both brokers). | Phases 4 and 5 |
| ADR-08 | Retry and DLQ behavior is defined by a broker-neutral consumer framework and verified by one contract suite. | Same behavior on Kafka and Pulsar, F-22. | Rely on each broker's native features (behavior diverges). | Phases 4 and 5 |
| ADR-09 | Ingestion keeps Multer 2, staging to a private directory with guaranteed cleanup. True streaming is deferred behind an `IngestedFile.openReadStream()` abstraction. | Retry and failover need a re-readable source. Sniffing, hashing and later virus scanning are simpler on a file. | Multer custom StorageEngine or raw busboy streaming (revisit if disk I/O becomes the bottleneck, P6-08). | Phase 1 |
| ADR-10 | File ids are UUIDv7. Content hash is SHA-256, field named `sha256`. | Time-ordered, native `uuid` column. v1 left "UUIDv7 or ULID" open, and its sample was neither. | ULID. | Phase 1 |
| ADR-11 | Every file has a visibility. Reads are authorized. Signed URLs for embedding. Private files never go to public CDN delivery. | F-24, F-26. | Everything public (status quo). | Phases 2 and 3 |
| ADR-12 | Generic ingress uses API keys bound to a namespace and tenants. | F-25. | Trust headers. | Phase 1 |
| ADR-13 | Legacy facades are additive-only and preserve `public_id` semantics. Existing assets are backfilled. | F-03. | Break legacy contract. | Phase 3 |
| ADR-14 | Workers run as a separate process. | Independent scaling and failure domains, F-28. | In-process workers. | Phase 4 |
| ADR-15 | Virus scanning is asynchronous through ClamAV. Reads are gated by `scan_status` when the policy requires it. | F-13. | Synchronous scan (adds latency to the fast path). | Phase 5 |
| ADR-16 | Tooling: `pg` with Kysely, `zod`, `pino` (via `nestjs-pino`), `vitest`, `supertest` (Nest e2e convention), `testcontainers`, `prom-client`, OpenTelemetry, `rate-limiter-flexible`, `file-type`, `helmet`. | Small, well known, works with ESM, TypeScript and NestJS's DI container. | Prisma, Jest, Winston. | All |
| ADR-17 | Audit trail is a Postgres append-only table. The Kafka/Pulsar audit topic is an optional stream fed from the outbox. | F-15. | Topic as the only sink. | Phase 6 |
| ADR-18 | Runtime target is Node 22 LTS minimum on a bookworm-based image, moving to the current LTS when native modules allow. | F-31. | Stay on Node 20. | Phase 1 |
| ADR-19 | `LEGACY_ENGINE=legacy|core` flag keeps the old controllers until the new engine is proven. | Fast rollback. | Big-bang cutover. | Phase 3 |
| ADR-20 | The local driver is for development and single-node deployments (or shared volume). | F-27. | Make local a first-class multi-node replica. | Phase 4 |
| ADR-21 | The service is built from scratch on **NestJS**, on the **Express platform adapter** (`@nestjs/platform-express`), not Fastify. There is no framework "migration" step: P1-01 is a greenfield build, not a port of the legacy Express app. | Nest gives the project a standard module/DI structure, first-class testing (`@nestjs/testing`), guards/interceptors/pipes/filters that map cleanly onto the auth, validation and error-handling design already in this document (ARCH §2.0), and an OpenAPI generator (`@nestjs/swagger`). The Express adapter keeps `multer`-based ingestion (a deliberate library choice for v2, ADR-09), Node stream semantics used throughout the storage and read-path design (ARCH §6, §7.2), and the legacy wildcard route needed for `:publicId` compatibility (F-54) — these are independent design decisions for v2, not code carried over from the legacy app. | Stay on plain Express with a lighter DI library (`tsyringe`, `awilix`); switch straight to Fastify; treat the legacy app as a starting point to migrate or patch incrementally instead of a frozen reference. | Phase 1 (all of Phase 2 onward builds on it) |

---

## 4. Open Questions for the Owner

Each has a default the task list assumes. Answer these early. Q1 and Q2 block the safe rollout of P1-09.

| # | Question | Assumed default |
| :--- | :--- | :--- |
| Q1 | What are the SuperAdmin JWT claims (issuer, role claim name and value, same secret as school tokens)? | RS256-signed via JWKS. Admin role lives in `access.global.roles` (e.g. `PLATFORM_ADMIN`). Admin capabilities live in `access.global.permissions`. No `platformAdmin` boolean. Configurable through `ADMIN_ALLOWED_ROLES=PLATFORM_ADMIN`. |
| Q2 | Does the SuperAdmin dashboard already send `Authorization: Bearer` to `/api/admin/upload/*`? | Unknown. Roll out with `ADMIN_AUTH_MODE=report` for one release, then enforce. |
| Q3 | Do other ESMA services store Cloudinary `secure_url` strings in their own databases? | Yes. Existing Cloudinary assets stay where they are, so those URLs keep working. |
| Q4 | Roughly how many assets exist in Cloudinary today? | Under 100k. The backfill script is resumable regardless. |
| Q5 | Is production a single server or several nodes? | Single arm64 server (matches the CI deploy). |
| Q6 | May documents become non-public? Today every Cloudinary URL is public. | Legacy facades keep `public` for compatibility (`LEGACY_DEFAULT_VISIBILITY=public`). A later phase moves documents to `tenant` with signed URLs once clients are updated. |
| Q7 | Are both Kafka and Pulsar required in production, or is one enough at first? | Kafka first. Pulsar follows and may slip without blocking release. |
| Q8 | Is PostgreSQL acceptable as a new dependency to operate and back up? | Yes. |
| Q9 | Retention and deletion obligations (for example data protection law) for student documents? | 30-day tombstone retention, hard delete afterwards. |
| Q10 | Are files above 20 MB or video needed? | No. Limits stay at 20 MB. Policies make this a config change later. |
| Q11 | What runs `~/server-setup/esma/restart`, and can it be changed to run migrations and a compose stack? | It can be changed. |

---

## 5. Changes Made to Each Document

| Document | Change |
| :--- | :--- |
| `ARCHITECTURE_AND_ROADMAP.md` | Rewritten as v2. New security model, data model, state machines, storage topology, outbox, consumer framework, API contracts, full config, deployment topology, re-ordered roadmap, risks. Every v1 diagram was corrected or replaced. Revised (v2.1) to add §2.0, the NestJS/Express-adapter decision and the Express-to-Nest concept mapping (ADR-21). **Updated 2026-09-22 (v2.2):** reframed as a ground-up rewrite — Phase 0 removed, legacy app marked frozen/reference-only, roadmap and milestones recomputed for 6 phases. |
| `CURRENT_ARCHITECTURE_AND_IMPLEMENTATION (1).md` | Secrets removed. Route count corrected. Six new defects added to section 10 (10.6 to 10.14). Node/OS support note. Assumptions requiring verification listed. Cross-links to fix tasks. **Updated 2026-09-22 (Revision 1.2):** workspace layout section added (section 3.0), legacy service layout moved to section 3.1, new NestJS v2 scaffold layout added as section 3.2, `docs/` removed from the legacy directory tree and noted as moved to `esma-upload-services/docs/`. Describes the **frozen legacy app**, kept only as a behavioral reference for the v2 rewrite — never a source to port code from. |
| `BACKEND_TASKS.md` | New. Originally 67 tasks across 7 phases with dependencies, acceptance criteria and tests, including a Phase 0 that patched the legacy app directly. Revised (v2.0): Phase 0 removed entirely; its content became day-one requirements of Phase 1, either folded into existing tasks (P1-02, P1-09, P1-10, P1-12) or split into three new Phase 1 tasks (P1-13 tooling/CI, P1-14 behavior-reference tests, P1-15 HTTP/platform hardening). P1-01 rewritten as a from-scratch build with no legacy code import step. Every task description that referenced copying, porting, wrapping or preserving legacy code was reworded to describe building from the documented functional requirements instead, using the legacy app only as a behavioral reference. Net effect: 58 tasks across 6 phases. |
| `REVIEW_FINDINGS_AND_DECISIONS.md` | New (this document). **Updated 2026-09-22 (v2):** reframed around the rewrite decision — ADR-02 and ADR-21 updated, F-04 and F-56 resolutions updated, files-to-update list no longer includes any legacy-app path. |

Files in the repository that should be updated by the tasks themselves (paths now reflect new layout; nothing under `esma-upload-service/` is ever a task deliverable — it is frozen):
- `esma-upload-service-v2/README.md` (P6-10)
- `esma-upload-service-v2/.env.example` (P1-02)
- `esma-upload-service-v2/Dockerfile` and `esma-upload-service-v2/.dockerignore` (P1-15)
- `esma-upload-service-v2/docker-compose.yml` (P1-04, P6-05)
- `esma-upload-service-v2/.gitlab-ci.yml` (P1-13, P6-06)
- `esma-upload-service-v2/.gitignore` (P1-01)
- OpenAPI annotations in the v2 controllers (P3-06)
- `esma-upload-services/docs/runbooks/rotate-secrets.md` (P1-02)
