# Alert Runbook: ESMA Upload Service (GUS)

> **Document Version:** 1.0  
> **Target Service:** `esma-upload-service-v2`  
> **Prometheus Rule File:** `ops/alerts/prometheus-rules.yml`

---

## Alert Catalog & Remediation

### 1. `ReplicationLagHigh`
* **Severity:** Warning
* **Trigger Condition:** `gus_replication_lag_seconds` p95 > 60s for 15 minutes.
* **Business Impact:** Secondary storage replicas (e.g. Cloudinary / SeaweedFS) are lagging behind primary ingestion. High availability read fallbacks may temporarily fail.
* **Initial Checks:**
  1. Inspect worker process logs: `kubectl logs -l app=esma-worker` or check `docker logs esma-worker`.
  2. Check broker consumer lag (Kafka / Pulsar consumer group `esma-replication-workers`).
  3. Verify secondary storage driver network connectivity and rate limits.
* **Remediation:**
  - Increase worker replica count or concurrency setting (`REPLICATION_CONCURRENCY=8`).
  - If a single worker is stuck on a network timeout, restart the worker container.

---

### 2. `DlqDepthNonZero`
* **Severity:** Critical
* **Trigger Condition:** `gus_dlq_depth > 0` for 10 minutes.
* **Business Impact:** Events (e.g. replication, scan, or derivative processing) have failed permanently after maximum retries and entered the Dead-Letter Queue.
* **Initial Checks:**
  1. List open dead-letter entries via CLI or API:
     ```bash
     npm run dlq:list
     ```
  2. Inspect `error` and `envelope` payload for the dead letters.
* **Remediation:**
  - Fix downstream root cause (e.g., target storage driver credentials or database constraint).
  - Redrive dead letters:
     ```bash
     npm run dlq:redrive -- --id <dead_letter_id>
     ```
  - Or discard invalid/poison pills:
     ```bash
     npm run dlq:discard -- --id <dead_letter_id> --reason "Corrupted test payload"
     ```

---

### 3. `OutboxStuck`
* **Severity:** Warning
* **Trigger Condition:** `gus_outbox_pending > 50` for 5 minutes.
* **Business Impact:** Transactional outbox events are accumulating in PostgreSQL without being relayed to the message broker.
* **Initial Checks:**
  1. Verify relay worker logs for broker connection errors.
  2. Test broker connectivity (`KAFKA_BROKERS` / `PULSAR_SERVICE_URL`).
* **Remediation:**
  - Restart the relay worker process (`WORKER_ROLES=relay`).
  - Ensure message broker is online and reachable.

---

### 4. `PrimaryDriverUnhealthy`
* **Severity:** Critical
* **Trigger Condition:** `gus_driver_health{provider="primary"} == 0` for 2 minutes.
* **Business Impact:** Direct file uploads fail or fall back to secondary storage.
* **Initial Checks:**
  1. Check primary storage health (`GET /health/ready` or `/api/v1/files/health`).
  2. Verify primary disk space or S3 gateway connectivity.
* **Remediation:**
  - Restore primary storage connectivity or clear disk space.
  - If primary driver is permanently lost, promote a healthy secondary driver using the promotion CLI:
     ```bash
     npm run storage:promote -- --to <healthy_provider>
     ```

---

### 5. `UploadErrorRateHigh`
* **Severity:** High
* **Trigger Condition:** File upload error percentage > 2% for 10 minutes.
* **Business Impact:** End-user upload requests are failing.
* **Initial Checks:**
  1. Inspect error codes in logs (`gus_upload_failures_total`).
  2. Check for quota limits (`403 QUOTA_EXCEEDED`), rate limits (`429 RATE_LIMITED`), or payload size violations (`413`).
* **Remediation:**
  - If storage capacity or quota is reached, adjust tenant quotas via admin API (`PATCH /api/v1/admin/tenants/:tenantId/quota`).

---

### 6. `VirusInfectedDetected`
* **Severity:** High
* **Trigger Condition:** `gus_quarantined_files_total > 0`.
* **Business Impact:** An infected file payload (e.g., EICAR signature or malware) was uploaded and blocked.
* **Initial Checks:**
  1. Inspect audit logs for action `FILE_SCAN_QUARANTINE`:
     ```bash
     GET /api/v1/admin/audit?action=FILE_SCAN_QUARANTINE
     ```
  2. Verify file status is `QUARANTINED` and replication was cancelled.
* **Remediation:**
  - File is automatically unreadable (`409 FILE_NOT_READY` / `403 FILE_QUARANTINED`) and will be purged after `QUARANTINE_RETENTION_DAYS` (default 7 days). No manual action required unless security escalation is needed.

---

### 7. `ChecksumMismatchDetected`
* **Severity:** Critical
* **Trigger Condition:** `gus_sha256_mismatches_total > 0`.
* **Business Impact:** Data corruption detected during read/replication stream verification.
* **Initial Checks:**
  1. Check logs for `DATA CORRUPTION ALERT`.
  2. Identify affected file ID and replica provider.
* **Remediation:**
  - Re-replicate file from primary storage or trigger secondary replica re-sync.
