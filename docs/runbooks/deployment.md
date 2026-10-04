# Operational Runbook: CI/CD Pipeline and Server Deployment

> **Service:** ESMA Upload Service v2  
> **Target Path:** `~/server-setup/esma`  
> **Deployment Runner:** `deploy/deploy.sh`

---

## 1. Overview & Architectural Principles

The ESMA Upload Service v2 deployment strategy guarantees zero downtime and zero data loss by strictly enforcing **Migration Gating** and **Automatic Health Rollback**.

```
[ CI/CD Build & Push ] ──► [ SSH Trigger deploy.sh ] ──► [ 1. Run Migration ] ──(Fail)──► [ Abort Rollout ]
                                                                 │ (OK)
                                                                 ▼
                                                        [ 2. Replace Containers ]
                                                                 │
                                                                 ▼
                                                        [ 3. Health & Smoke Test ] ──(Fail)──► [ Auto Rollback ]
                                                                 │ (OK)
                                                                 ▼
                                                        [ 4. Deploy Success ]
```

---

## 2. Server Setup & Directory Structure

On the deployment host, the service environment resides under `~/server-setup/esma`:

```
~/server-setup/esma/
├── docker-compose.yml           # Base compose stack
├── docker-compose.prod.yml      # Production port isolation override
├── .env                         # Production environment secrets
├── deploy/
│   └── deploy.sh                # Zero-downtime deployment runner
└── scripts/
    └── smoke.sh                 # Operational smoke test script
```

---

## 3. Deployment Script Flow (`deploy/deploy.sh`)

When triggered by CI/CD or executed manually by an operator:

### Phase 1: Database Migration Gate
1. Records current container image tag into `.previous_deploy_tag`.
2. Executes `docker compose run --rm migrate`.
3. If database migration fails (exit code != 0), **rollout is aborted immediately**. Existing running `api` and `worker` instances continue running unchanged.

### Phase 2: Rolling Container Replacement
1. Updates environment variable `DEPLOY_TAG` to target image version.
2. Re-creates `api` and `worker` containers via `docker compose up -d --no-deps api worker`.

### Phase 3: Health Probe & Smoke Test Verification
1. Polls `http://localhost:7030/health/ready` up to 30 seconds.
2. Runs `./scripts/smoke.sh` to test file ingestion, replication, and purge.

### Phase 4: Automatic Rollback Strategy
1. If health probe or smoke test fails:
   - Logs critical failure alert.
   - Reads `PREVIOUS_TAG` from `.previous_deploy_tag`.
   - Re-starts `api` and `worker` containers pinned to `PREVIOUS_TAG`.
   - Exits with non-zero status code (causing CI job failure).

---

## 4. Manual Deployment & Rollback Drills

### Manual Deployment
```bash
cd ~/server-setup/esma
DEPLOY_TAG=v2.1.0 ./deploy/deploy.sh
```

### Force Rollback to Previous Version
If manual intervention is required:
```bash
cd ~/server-setup/esma
PREV_TAG=$(cat .previous_deploy_tag)
DEPLOY_TAG=${PREV_TAG} ./deploy/deploy.sh ${PREV_TAG}
```

---

## 5. CI/CD Pipeline Configuration

### Secret Variables Required in CI/CD (GitLab / GitHub Actions)
- `DOCKER_USERNAME`: Registry username
- `DOCKER_PASSWORD`: Registry access token / password
- `SSH_HOST`: Staging / Production server IP or hostname
- `SSH_USER`: Deployment SSH user account (e.g. `esma`)
- `SSH_PRIVATE_KEY`: Authorized SSH private key
