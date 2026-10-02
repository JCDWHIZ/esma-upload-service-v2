#!/usr/bin/env bash
# PostgreSQL Automated Nightly Backup Script for ESMA Upload Services v2
# Usage: ./ops/backup/pg-backup.sh

set -euo pipefail

# Configurable Variables
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-esma_upload_v2}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/esma-postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.dump"
CHECKSUM_FILE="${BACKUP_FILE}.sha256"

echo "=== Starting PostgreSQL Backup at $(date) ==="
mkdir -p "${BACKUP_DIR}"

# 1. Run compressed custom format pg_dump
echo "Creating compressed pg_dump at ${BACKUP_FILE}..."
PGPASSWORD="${DB_PASSWORD:-}" pg_dump \
  -h "${DB_HOST}" \
  -p "${DB_PORT}" \
  -U "${DB_USER}" \
  -F c \
  -b \
  -v \
  -f "${BACKUP_FILE}" \
  "${DB_NAME}"

# 2. Compute SHA256 Checksum for Integrity Verification
echo "Calculating SHA256 checksum..."
sha256sum "${BACKUP_FILE}" > "${CHECKSUM_FILE}"

# 3. Clean up backups older than RETENTION_DAYS
echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -type f -name "${DB_NAME}_*.dump*" -mtime +"${RETENTION_DAYS}" -delete

echo "=== PostgreSQL Backup Completed Successfully: ${BACKUP_FILE} ==="
