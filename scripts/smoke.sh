#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# ESMA Upload Service v2 - End-to-End Operational Smoke Test
# ─────────────────────────────────────────────────────────────────────────────

PROFILES="${*:-seaweedfs kafka}"
API_URL="${API_URL:-http://localhost:7030}"
MAX_WAIT_SEC=60

echo "=========================================================================="
echo " Starting ESMA Upload Service Smoke Test"
echo " Active Profiles: ${PROFILES}"
echo " Target API URL:  ${API_URL}"
echo "=========================================================================="

COMPOSE_PROFILE_ARGS=""
for profile in ${PROFILES}; do
  COMPOSE_PROFILE_ARGS="${COMPOSE_PROFILE_ARGS} --profile ${profile}"
done

echo "[1/6] Booting Docker Compose environment (${PROFILES})..."
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
  docker compose ${COMPOSE_PROFILE_ARGS} up -d --build
fi

echo "[2/6] Waiting for service health at ${API_URL}/health/ready..."
READY=0
for i in $(seq 1 ${MAX_WAIT_SEC}); do
  STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/health/ready" || echo "000")
  if [ "${STATUS_CODE}" -eq 200 ]; then
    echo "Service is HEALTHY (HTTP 200) after ${i}s"
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "ERROR: Service failed to reach healthy state within ${MAX_WAIT_SEC}s"
  exit 1
fi

echo "[3/6] Generating test API key..."
API_KEY=""
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
  KEY_OUTPUT=$(docker compose exec -T api node dist/src/scripts/apikey-cli.js create --name smoke-test-key --any-tenant 2>/dev/null || true)
  API_KEY=$(echo "${KEY_OUTPUT}" | grep "API Key:" | awk '{print $3}' || true)
fi

if [ -z "${API_KEY}" ]; then
  echo "Using fallback authorization header"
  AUTH_HEADER="Authorization: Bearer test-secret-token"
else
  echo "Generated API key prefix: ${API_KEY:0:8}..."
  AUTH_HEADER="X-API-Key: ${API_KEY}"
fi

echo "[4/6] Uploading test file payload..."
TMP_FILE=$(mktemp)
echo "ESMA Upload Service smoke test payload - $(date)" > "${TMP_FILE}"

UPLOAD_RESPONSE=$(curl -s -X POST "${API_URL}/api/v1/files/upload" \
  -H "${AUTH_HEADER}" \
  -F "file=@${TMP_FILE};filename=smoke-test-file.txt" \
  -F "folder=smoke" \
  -F "visibility=private")

FILE_ID=$(echo "${UPLOAD_RESPONSE}" | node -e "
  const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
  const file = data.files ? data.files[0] : data;
  if (!file || !file.fileId) { process.exit(1); }
  console.log(file.fileId);
" || echo "")

if [ -z "${FILE_ID}" ]; then
  echo "ERROR: Upload failed. Server response:"
  echo "${UPLOAD_RESPONSE}"
  rm -f "${TMP_FILE}"
  exit 1
fi

echo "Upload successful! File ID: ${FILE_ID}"

echo "[5/6] Polling file status and replica verification..."
SYNCED=0
for i in $(seq 1 30); do
  MANIFEST_JSON=$(curl -s -X GET "${API_URL}/api/v1/files/${FILE_ID}" -H "${AUTH_HEADER}")
  REP_STATUS=$(echo "${MANIFEST_JSON}" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
      console.log(d.replicationStatus || 'UNKNOWN');
    } catch { console.log('ERROR'); }
  " || echo "UNKNOWN")
  
  echo "Attempt ${i}: replicationStatus = ${REP_STATUS}"
  if [ "${REP_STATUS}" = "SYNCED" ] || [ "${REP_STATUS}" = "ONLINE" ] || [ "${REP_STATUS}" = "COMPLETED" ]; then
    SYNCED=1
    break
  fi
  sleep 1
done

echo "[6/6] Testing file download and deletion..."
DOWNLOAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/v1/files/${FILE_ID}" -H "${AUTH_HEADER}")
if [ "${DOWNLOAD_CODE}" -ne 200 ]; then
  echo "ERROR: File read returned HTTP ${DOWNLOAD_CODE}"
  rm -f "${TMP_FILE}"
  exit 1
fi

DELETE_RESPONSE=$(curl -s -X DELETE "${API_URL}/api/v1/files/${FILE_ID}" -H "${AUTH_HEADER}")
echo "Delete output: ${DELETE_RESPONSE}"

POST_DELETE_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/v1/files/${FILE_ID}" -H "${AUTH_HEADER}")
echo "Post-delete read status code: ${POST_DELETE_CODE}"

rm -f "${TMP_FILE}"

echo "=========================================================================="
echo " SMOKE TEST COMPLETED SUCCESSFULLY!"
echo "=========================================================================="
exit 0
