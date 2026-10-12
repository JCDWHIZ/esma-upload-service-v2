# ESMA Upload Service v2 — Operations Runbook

This document describes standard operating procedures, failure scenarios, and maintenance runbooks for `esma-upload-service-v2`.

---

## 1. Start-up Failures and Diagnosis

When the API or worker process fails to start, it exits non-zero with structured error messages. Common startup failure modes and resolution steps:

### 1.1 `E_MIGRATION_OUT_OF_SYNC` / Missing Migrations in Production
- **Symptom**: In production (`NODE_ENV=production`), the application refuses to start with:
  `Production startup check failed: Pending migrations detected...`
- **Root Cause**: `AUTO_MIGRATE` is disabled in production to protect the DML-only runtime role (`UR-08`). The migration job has not completed.
- **Remedy**:
  1. Verify the Kubernetes `migrate` Job completed successfully.
  2. Run the migration CLI manually with owner credentials:
     ```bash
     npm run migrate:up
     ```
  3. Ensure `MIGRATION_CLI_PATH` points to the compiled migration runner: `dist/db/migrations/cli.js`.

### 1.2 `E_CONFIG_INVALID` / Missing Mandatory Production Config
- **Symptom**: Process fails during `ConfigModule` initialization with schema validation errors.
- **Root Cause**: In production, parameters such as `APP_BASE_URL`, `DATABASE_URL`, `IDENTITY_JWKS_URI`, `KAFKA_BROKERS`, `SIGNED_URL_SECRET`, and `REDIS_URL` are strictly validated (`UR-08`).
- **Remedy**:
  - Inspect the pod log for the specific missing or invalid key.
  - Verify that `IDENTITY_JWKS_URI` (or `AUTH_JWKS_URI`) points to `https://api.esma.elsoft.ng/identity/.well-known/jwks.json`.
  - Ensure `APP_BASE_URL` is set to `<gateway-url>/uploads`.

### 1.3 `E_STORAGE_DRIVER_UNAVAILABLE` / ClamAV Unreachable in Fail-Closed Mode
- **Symptom**: API/Worker readiness checks (`/health/ready`) fail or the scanner initialization logs an error.
- **Root Cause**: `SCAN_FAIL_MODE=closed` is enabled in production (`UR-05`), and ClamAV on `esma-upload-clamav:3310` is unresponsive.
- **Remedy**:
  1. Inspect ClamAV daemon status: `kubectl get pods -l app=esma-upload-clamav`.
  2. Verify network connectivity from the upload pod to port 3310.

---

## 2. Dead-Letter Queue (DLQ) Handling

The worker writes poison pills and unprocessable messages to the DLQ after exhausting configured exponential backoff retries (e.g. `10s`, `1m`, `10m`).

### 2.1 Inspecting DLQ Status
Check the current depth and error breakdown:
```bash
npm run cli -- dlq:stats
```
Or query Prometheus metrics:
- `upload_service_dlq_messages_total`
- `upload_service_worker_failures_total`

### 2.2 Redriving DLQ Messages
Once the root issue (e.g., downstream storage glitch, transient network partition) is resolved, redrive messages from the DLQ:
```bash
# Redrive all eligible DLQ messages for a specific topic
npm run cli -- dlq:redrive --topic esma.files.replication --limit 500

# Redrive specific message by DLQ record ID
npm run cli -- dlq:redrive --id <dlq-record-id>
```

---

## 3. Restoring a File from a Replica

If the primary storage driver (e.g., SeaweedFS) loses a file object or reports a checksum mismatch, restore it from secondary replicas.

### 3.1 Verification
Locate all replicas for the damaged file:
```sql
SELECT r.replica_id, r.file_id, r.storage_driver, r.status, r.external_reference, f.sha256, f.organization_id
FROM file_replicas r
JOIN files f ON f.file_id = r.file_id
WHERE r.file_id = '<file-uuid>';
```

### 3.2 Automated Storage Reconciler
The storage reconciler automatically scans for replica drift:
```bash
npm run cli -- storage:reconcile --file-id <file-uuid>
```
The reconciler streams bytes from any healthy replica (`status = 'ACTIVE'`), uploads to the primary storage driver, and verifies SHA-256 integrity.

---

## 4. Rotating `SIGNED_URL_SECRET`

To rotate the secret used for signing download and metadata access tokens without invalidating active URLs (UR-26, UR-04):

1. **Phase 1: Dual-Secret Verification**
   - Set the previous secret into `SIGNED_URL_SECRET_PREVIOUS`:
     ```env
     SIGNED_URL_SECRET_PREVIOUS=<old-secret>
     ```
   - Set the new secret into `SIGNED_URL_SECRET`:
     ```env
     SIGNED_URL_SECRET=<new-secret>
     ```
   - Deploy the configuration. All newly generated signed URLs are signed with `SIGNED_URL_SECRET`. Incoming requests signed with either the new or old secret will pass validation seamlessly.

2. **Phase 2: Retirement**
   - After the maximum signed URL TTL has elapsed (default 10 minutes, plus safety margin, e.g. 1 hour):
   - Remove `SIGNED_URL_SECRET_PREVIOUS` from the environment.
   - Deploy the updated configuration. Rotation is complete with zero disruption.
