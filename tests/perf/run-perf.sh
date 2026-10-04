#!/usr/bin/env bash
set -euo pipefail

# Performance Test Runner for ESMA Upload Service v2
# Tests uploads (1MB, 5MB, 20MB at 10, 50, 100 VUs), reads, mixed load, and pagination.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPORT_DIR="${ROOT_DIR}/docs/perf"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

API_BASE_URL="${API_BASE_URL:-http://localhost:7030}"
TENANT_ID="${TENANT_ID:-perf-tenant}"
NAMESPACE="${NAMESPACE:-esma-tenant}"

echo "=========================================================="
echo " ESMA Upload Service v2 - Performance Benchmark Suite"
echo " Target API: ${API_BASE_URL}"
echo "=========================================================="

# 1. Ensure fixtures exist
echo "--> Checking/Generating test fixtures..."
if [ ! -f "${FIXTURES_DIR}/test-1mb.pdf" ] || [ ! -f "${FIXTURES_DIR}/test-5mb.pdf" ] || [ ! -f "${FIXTURES_DIR}/test-20mb.pdf" ]; then
  npx ts-node "${SCRIPT_DIR}/generate-fixtures.ts"
fi

# 2. Determine K6 execution mechanism
K6_CMD=""
if command -v k6 &> /dev/null; then
  K6_CMD="k6"
elif command -v docker &> /dev/null; then
  echo "--> Local k6 binary not found. Using docker grafana/k6..."
  K6_CMD="docker run --rm -i --net=host -v ${SCRIPT_DIR}:/scripts grafana/k6"
else
  echo "--> Neither k6 nor docker available. Falling back to TypeScript runner: npm run test:perf"
  npm run test:perf
  exit 0
fi

mkdir -p "${REPORT_DIR}"

run_scenario() {
  local scenario_name="$1"
  local script_file="$2"

  echo ""
  echo ">>> Running Scenario: ${scenario_name} (${script_file})"
  
  if [[ "${K6_CMD}" == *"docker"* ]]; then
    ${K6_CMD} run \
      -e API_BASE_URL="${API_BASE_URL}" \
      -e TENANT_ID="${TENANT_ID}" \
      -e NAMESPACE="${NAMESPACE}" \
      "/scripts/scenarios/${script_file}"
  else
    ${K6_CMD} run \
      -e API_BASE_URL="${API_BASE_URL}" \
      -e TENANT_ID="${TENANT_ID}" \
      -e NAMESPACE="${NAMESPACE}" \
      "${SCRIPT_DIR}/scenarios/${script_file}"
  fi
}

# Run all 4 scenarios
run_scenario "Upload Load (1MB, 5MB, 20MB at 10, 50, 100 VUs)" "upload-load.js"
run_scenario "Read Load (Metadata, Content, Range)" "read-load.js"
run_scenario "Mixed Workload (70% Read / 30% Upload)" "mixed-workload.js"
run_scenario "Pagination Keyset Load (100 VUs)" "pagination-load.js"

echo ""
echo "=========================================================="
echo " Performance tests complete. Review docs/perf/report.md"
echo "=========================================================="
