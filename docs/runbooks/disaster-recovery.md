# Disaster Recovery & Operational Runbook

**Service:** ESMA Upload Services v2  
**Task Ref:** P6-07 (`docs/BACKEND_TASKS.md`)  
**Version:** 1.0.0  

---

## 1. Overview & Service Objectives

This runbook defines the disaster recovery (DR) procedures, Recovery Point Objectives (RPO), and Recovery Time Objectives (RTO) for `esma-upload-service-v2`.

### 1.1 RPO & RTO Targets

| Failure Component | Target RPO | Target RTO | Secondary / Fallback Mechanism |
| :--- | :--- | :--- | :--- |
| **API Host / Worker Process** | 0 seconds | < 2 minutes | Multi-instance container auto-scaling & load balancer health checks. |
| **PostgreSQL Primary Database** | < 15 seconds | < 5 minutes | Synchronous DB replication standby or nightly `pg_dump` + WAL recovery. |
| **Primary Storage (SeaweedFS)** | 0 seconds | < 10 minutes | Promotion of AVAILABLE secondary replicas via `npm run storage:promote`. |
| **Cloudinary External Provider**| 0 seconds | < 1 minute | Read path falls back to primary store; background processing retries derivative generation. |
| **Message Broker (Kafka/Pulsar)**| 0 seconds | < 5 minutes | Transactional outbox table buffers events in PostgreSQL until broker recovers. |

---

## 2. Standard Operating Procedures (SOPs)

### 2.1 Scenario 1: Total Loss of API Host / Node Instance
**Symptoms:** 502/503 HTTP Gateway Errors, health check failures on `/health/liveness`.

**Procedure:**
1. Check process monitor / Docker status:
   ```bash
   docker ps -a
   ```
2. If container crashed, review container logs:
   ```bash
   docker logs --tail 200 esma-upload-api
   ```
3. Restart or redeploy API instance:
   ```bash
   docker compose -f docker-compose.prod.yml restart app
   ```
4. Confirm health recovery:
   ```bash
   curl -f http://localhost:7030/health/readiness
   ```

---

### 2.2 Scenario 2: Total Loss of PostgreSQL Primary Database
**Symptoms:** Database connection refused errors, `ECONNREFUSED` on port 5432.

**Procedure A (Standby Failover):**
1. Promote standby database to primary (e.g. Patroni or managed cloud database failover).
2. Update `DATABASE_URL` in environment configuration if host endpoint changed.
3. Restart API & Worker processes.

**Procedure B (Backup Restore from Snapshot):**
1. Locate the latest nightly dump file from `/var/backups/esma-postgres/`.
2. Execute the restore drill script to verify backup integrity:
   ```bash
   ./ops/backup/pg-restore-drill.sh /var/backups/esma-postgres/esma_upload_v2_LATEST.dump
   ```
3. Restore into clean production PostgreSQL database:
   ```bash
   pg_restore -h <db-host> -U postgres -d esma_upload_v2 -v /var/backups/esma-postgres/esma_upload_v2_LATEST.dump
   ```
4. Run migration status check:
   ```bash
   npm run db:status
   ```

---

### 2.3 Scenario 3: Loss of Primary Storage Engine (SeaweedFS / Local Storage)
**Symptoms:** Storage write failures, 500 error on upload API, `StorageDriverError` in logs.

**Procedure:**
1. Assess availability of target secondary replica provider (e.g. `s3` or `cloudinary`).
2. Run storage promotion in dry-run mode to preview affected files:
   ```bash
   npm run storage:promote -- --to s3 --dry-run
   ```
3. Execute live storage promotion to repoint `primary_provider` across all available replicas:
   ```bash
   npm run storage:promote -- --to s3 --batch-size 500
   ```
4. Verify read path routing by fetching a sample file:
   ```bash
   curl -i http://localhost:7030/files/v1/<fileId>/content
   ```

---

### 2.4 Scenario 4: Loss of Cloudinary Provider / External CDN
**Symptoms:** Image derivative generation failures, replication timeout logs.

**Procedure:**
1. The service automatically handles Cloudinary downtime:
   - File reads automatically fall back to primary storage (SeaweedFS).
   - Derivative requests return original image or queued state.
2. Review dead-letter queue (DLQ) for failed replication tasks:
   ```bash
   npm run dlq:stats
   ```
3. When Cloudinary service is restored, redrive failed replication messages:
   ```bash
   npm run dlq:redrive
   ```

---

### 2.5 Scenario 5: Loss of Message Broker (Kafka / Pulsar / Redis)
**Symptoms:** Event publishing errors, replication delay alerts.

**Procedure:**
1. Outbox pattern ensures **zero data loss**: events are safely stored in PostgreSQL table `outbox_events`.
2. Restart or fail over message broker service:
   ```bash
   docker compose -f docker-compose.prod.yml restart kafka
   ```
3. Monitor outbox backlog drain rate via Grafana dashboard or CLI:
   ```bash
   npm run dlq:stats
   ```

---

## 3. Emergency Operations & Legal Erasure (GDPR / Right to be Forgotten)

When a legal erasure request is issued:
1. Execute the hard-delete CLI tool with operator credentials and reason:
   ```bash
   npm run file:hard-delete -- --file-id <FILE_UUID> --operator "legal-team" --reason "GDPR Article 17 Erasure Request"
   ```
2. The tool will:
   - Remove physical objects across all storage providers (`local`, `seaweedfs`, `cloudinary`).
   - Remove DB rows from `files` and `file_replicas`.
   - Record an audit event `file.erased` in `outbox_events`.

---

## 4. Maintenance & Sweeper Configurations

The background `SweeperService` runs continuously to maintain database hygiene:
- **Namespace Retention Overrides:** Configured in `policy-registry` per namespace via `tombstoneRetentionDays`.
- **Global Fallback:** `TOMBSTONE_RETENTION_DAYS` (default 30 days).
- **Manual Trigger / Dry Run:**
  Can be inspected via application logs or unit test suite (`npm run test:unit`).
