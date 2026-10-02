#!/usr/bin/env bash
# SeaweedFS Filer Metadata & Volume Backup Script
# Usage: ./ops/backup/seaweed-backup.sh

set -euo pipefail

SEAWEED_FILER_HOST="${SEAWEED_FILER_HOST:-localhost}"
SEAWEED_FILER_PORT="${SEAWEED_FILER_PORT:-8888}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/seaweedfs}"
TIMESTAMP=$(date -u +"%Y%m%d_%H%M%SZ")

echo "=== Starting SeaweedFS Filer Metadata Backup at $(date) ==="
mkdir -p "${BACKUP_DIR}"

META_BACKUP_FILE="${BACKUP_DIR}/filer_meta_${TIMESTAMP}.json.gz"

echo "Downloading SeaweedFS filer metadata snapshot from http://${SEAWEED_FILER_HOST}:${SEAWEED_FILER_PORT}/dir/list ..."
curl -s "http://${SEAWEED_FILER_HOST}:${SEAWEED_FILER_PORT}/dir/list?limit=100000" | gzip > "${META_BACKUP_FILE}"

echo "SeaweedFS metadata snapshot saved to ${META_BACKUP_FILE}"

# Retention cleanup (retain 14 days of metadata snapshots)
find "${BACKUP_DIR}" -type f -name "filer_meta_*.json.gz" -mtime +14 -delete

echo "=== SeaweedFS Backup Completed Successfully ==="
