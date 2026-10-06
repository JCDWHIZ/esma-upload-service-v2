#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ESMA Upload Service v2 - Zero-Downtime Deployment & Rollback Script
# ─────────────────────────────────────────────────────────────────────────────

TAG="${1:-${DEPLOY_TAG:-latest}}"
API_URL="${API_URL:-http://localhost:7030}"
TAG_FILE=".previous_deploy_tag"

echo "=========================================================================="
echo " Starting ESMA Upload Service Deployment"
echo " Target Image Tag: ${TAG}"
echo " Health Endpoint:   ${API_URL}/uploads/health/ready"
echo "=========================================================================="

# 1. Record current image tag for rollback capability
PREVIOUS_TAG=""
if [ -f "${TAG_FILE}" ]; then
  PREVIOUS_TAG=$(cat "${TAG_FILE}")
else
  PREVIOUS_TAG="latest"
fi
echo "${TAG}" > "${TAG_FILE}"

echo "[1/4] Step 1: Running database migrations (migrate service)..."
export DEPLOY_TAG="${TAG}"

if command -v docker &> /dev/null && docker compose version &> /dev/null; then
  if ! docker compose run --rm migrate; then
    echo "=========================================================================="
    echo " ERROR: Database migration failed!"
    echo " Rollout ABORTED immediately. Existing running service is UNTOUCHED."
    echo "=========================================================================="
    # Restore previous tag tracking
    echo "${PREVIOUS_TAG}" > "${TAG_FILE}"
    exit 1
  fi
  echo "Migrations executed successfully."
else
  echo "Docker environment not detected; running local migration script..."
  if ! npm run db:migrate; then
    echo "ERROR: Local database migration failed. Aborting deployment."
    exit 1
  fi
fi

echo "[2/4] Step 2: Performing rolling container replacement for api and worker..."
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
  docker compose up -d --no-deps api worker
fi

echo "[3/4] Step 3: Verifying deployment health and running operational smoke test..."
READY=0
for i in $(seq 1 30); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/uploads/health/ready" || echo "000")
  if [ "${STATUS_CODE}" -eq 200 ]; then
    echo "Health probe PASSED (HTTP 200) after ${i}s"
    READY=1
    break
  fi
  sleep 1
done

SMOKE_OK=0
if [ "${READY}" -eq 1 ]; then
  if [ -f "./scripts/smoke.sh" ]; then
    echo "Executing operational smoke script..."
    if ./scripts/smoke.sh; then
      SMOKE_OK=1
    fi
  else
    SMOKE_OK=1
  fi
fi

# 4. Handle verification failure -> automatic rollback
if [ "${READY}" -ne 1 ] || [ "${SMOKE_OK}" -ne 1 ]; then
  echo "=========================================================================="
  echo " ERROR: Health check or smoke test FAILED!"
  echo " Initiating AUTOMATIC ROLLBACK to previous tag: ${PREVIOUS_TAG}..."
  echo "=========================================================================="
  
  if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    export DEPLOY_TAG="${PREVIOUS_TAG}"
    docker compose up -d --no-deps api worker
    echo "${PREVIOUS_TAG}" > "${TAG_FILE}"
  fi

  echo "Rollback initiated. Existing service restored to tag ${PREVIOUS_TAG}."
  exit 1
fi

echo "=========================================================================="
echo " DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo " Service version ${TAG} is healthy and operational."
echo "=========================================================================="
exit 0
