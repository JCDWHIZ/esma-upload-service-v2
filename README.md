# ESMA Upload Service v2

> Production-grade file upload, storage replication, security scan, and event distribution service.

---

## 🚀 Quick Start with Docker Compose Profiles

The stack supports standard Docker Compose profiles (`docker-compose.yml`) for local development, testing, and production deployment:

### Profiles Overview

| Profile | Services Included | Purpose |
| :--- | :--- | :--- |
| *(default)* | `postgres`, `redis`, `migrate`, `api`, `worker` | Core database, cache, schema migrator, API server, background worker |
| `seaweedfs` | `seaweedfs`, `seaweedfs-init` | SeaweedFS S3 gateway + filer + volume server & bucket initialization |
| `kafka` | `kafka` | Single-node Apache Kafka KRaft event broker |
| `pulsar` | `pulsar` | Apache Pulsar standalone event broker |
| `scan` | `clamav` | ClamAV antivirus scanner service |
| `observability` | `prometheus`, `grafana` | Prometheus metrics collection & Grafana dashboards |

### Running Docker Compose

```bash
# 1. Start core default services (Postgres, Redis, Migration, API, Worker)
$ docker compose up -d

# 2. Start full local stack with SeaweedFS and Kafka broker
$ docker compose --profile seaweedfs --profile kafka up -d

# 3. Start complete enterprise stack with all services (Observability, Scanner, Brokers)
$ docker compose --profile seaweedfs --profile kafka --profile pulsar --profile scan --profile observability up -d

# 4. Run in production mode with host ports bound strictly internally
$ docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## 🧪 Operational Smoke Testing

Run the end-to-end smoke test script to verify ingest, replication, download, and tombstone purging across storage drivers and message brokers:

```bash
# Run smoke test against SeaweedFS & Kafka (default)
$ ./scripts/smoke.sh

# Run smoke test against Pulsar broker
$ ./scripts/smoke.sh seaweedfs pulsar

# Run smoke test against memory mode
$ ./scripts/smoke.sh memory
```

---

## 🛠 Local Development & CLI

```bash
# Install dependencies
$ pnpm install

# Type check
$ pnpm run typecheck

# Run unit test suite
$ pnpm run test:unit

# Run full test suite
$ pnpm run test:all

# Manage API Keys CLI
$ pnpm run apikey:create -- --name my-client --any-tenant
$ pnpm run apikey:list
$ pnpm run apikey:revoke -- --prefix eus2_xxx

# Manage Dead-Letter Queue CLI
$ pnpm run dlq:stats
$ pnpm run dlq:redrive
```
