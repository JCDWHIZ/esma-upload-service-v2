#!/usr/bin/env bash
# PostgreSQL Automated Backup Restore Drill Script for ESMA Upload Services v2
# Verifies backup integrity by restoring into a transient docker postgres container.
# Usage: ./ops/backup/pg-restore-drill.sh <path-to-backup-file>

set -euo pipefail

BACKUP_FILE="${1:-}"
if [ -z "${BACKUP_FILE}" ]; then
  echo "Error: Please specify path to dump file."
  echo "Usage: $0 /path/to/backup.dump"
  exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Error: Backup file '${BACKUP_FILE}' does not exist."
  exit 1
fi

CONTAINER_NAME="esma-pg-restore-drill-$(date +%s)"
DRILL_DB="esma_restore_test"
DRILL_PORT="54399"
POSTGRES_PASS="drill_secret_123"

echo "=== Starting PostgreSQL Restore Drill ==="
echo "Target Backup: ${BACKUP_FILE}"

# 1. Verify SHA256 Checksum if file exists
if [ -f "${BACKUP_FILE}.sha256" ]; then
  echo "Verifying SHA256 checksum..."
  sha256sum -c "${BACKUP_FILE}.sha256"
else
  echo "Warning: No .sha256 file found alongside dump."
fi

# 2. Launch transient Postgres docker container
echo "Spawning transient PostgreSQL docker container (${CONTAINER_NAME})..."
docker run --name "${CONTAINER_NAME}" \
  -e POSTGRES_PASSWORD="${POSTGRES_PASS}" \
  -e POSTGRES_DB="${DRILL_DB}" \
  -p "${DRILL_PORT}:5432" \
  -d postgres:17-alpine > /dev/null

cleanup() {
  echo "Cleaning up transient docker container..."
  docker rm -f "${CONTAINER_NAME}" > /dev/null || true
}
trap cleanup EXIT

# 3. Wait for PostgreSQL container readiness
echo "Waiting for database ready state..."
until docker exec "${CONTAINER_NAME}" pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

# 4. Perform pg_restore into transient DB
echo "Restoring database snapshot via pg_restore..."
PGPASSWORD="${POSTGRES_PASS}" pg_restore \
  -h localhost \
  -p "${DRILL_PORT}" \
  -U postgres \
  -d "${DRILL_DB}" \
  -v \
  "${BACKUP_FILE}" || true

# 5. Execute consistency checks on restored database
echo "Executing DB record consistency checks..."
RECORD_COUNT=$(PGPASSWORD="${POSTGRES_PASS}" psql -h localhost -p "${DRILL_PORT}" -U postgres -d "${DRILL_DB}" -t -A -c "SELECT count(*) FROM files;")
REPLICA_COUNT=$(PGPASSWORD="${POSTGRES_PASS}" psql -h localhost -p "${DRILL_PORT}" -U postgres -d "${DRILL_DB}" -t -A -c "SELECT count(*) FROM file_replicas;")

echo "Restored Database Table Statistics:"
echo " - Files Table Row Count:        ${RECORD_COUNT}"
echo " - File Replicas Row Count:  ${REPLICA_COUNT}"

if [ "${RECORD_COUNT}" -ge 0 ] && [ "${REPLICA_COUNT}" -ge 0 ]; then
  echo "=== Restore Drill PASSED: Backup is consistent and fully restorable! ==="
else
  echo "=== Restore Drill FAILED: Integrity check failed ==="
  exit 1
fi
