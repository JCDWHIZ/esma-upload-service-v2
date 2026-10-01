#!/usr/bin/env bash
# scripts/setup-pulsar.sh
# Production Apache Pulsar tenant, namespace, retention and topic provisioning for esma-upload-service-v2
# Usage:
#   PULSAR_ADMIN_URL=http://localhost:8085 PULSAR_TENANT=esma PULSAR_NAMESPACE=uploads ./scripts/setup-pulsar.sh
#
# References: ARCH §8.3, §8.7, P5-03, P5-04

set -euo pipefail

ADMIN_URL="${PULSAR_ADMIN_URL:-http://localhost:8085}"
TENANT="${PULSAR_TENANT:-esma}"
NAMESPACE="${PULSAR_NAMESPACE:-uploads}"
PULSAR_ADMIN="${PULSAR_ADMIN_CMD:-pulsar-admin}"

echo "==> Configuring Apache Pulsar for esma-upload-service-v2"
echo "    Admin URL: ${ADMIN_URL}"
echo "    Tenant:    ${TENANT}"
echo "    Namespace: ${NAMESPACE}"
echo ""

# 1. Ensure Tenant
echo -n "==> Ensuring tenant '${TENANT}' exists... "
if "${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" tenants list 2>/dev/null | grep -q "^${TENANT}$"; then
  echo "EXISTS"
else
  "${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" tenants create "${TENANT}" \
    --allowed-clusters standalone 2>&1 && echo "CREATED" || echo "FAILED"
fi

# 2. Ensure Namespace
FULL_NAMESPACE="${TENANT}/${NAMESPACE}"
echo -n "==> Ensuring namespace '${FULL_NAMESPACE}' exists... "
if "${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" namespaces list "${TENANT}" 2>/dev/null | grep -q "${FULL_NAMESPACE}"; then
  echo "EXISTS"
else
  "${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" namespaces create "${FULL_NAMESPACE}" 2>&1 && echo "CREATED" || echo "FAILED"
fi

# 3. Enable Deduplication
echo -n "==> Enabling message deduplication on '${FULL_NAMESPACE}'... "
"${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" namespaces set-deduplication "${FULL_NAMESPACE}" --enable 2>&1 && echo "OK" || echo "FAILED"

# 4. Configure Message Retention (7 days, 50 GB)
echo -n "==> Setting retention policy (size: 50G, time: 7d) on '${FULL_NAMESPACE}'... "
"${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" namespaces set-retention "${FULL_NAMESPACE}" \
  --size 50G \
  --time 7d 2>&1 && echo "OK" || echo "FAILED"

# 5. Configure Backlog Quota (10 GB, retention policy: producer_exception)
echo -n "==> Setting backlog quota on '${FULL_NAMESPACE}'... "
"${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" namespaces set-backlog-quota "${FULL_NAMESPACE}" \
  --limit 10G \
  --policy producer_exception 2>&1 && echo "OK" || echo "FAILED"

# 6. Create Topics
TOPICS=(
  "replication"
  "processing"
  "audit"
  "dlq"
)

echo ""
echo "--- Ensuring partitioned/persistent topics ---"
for topic in "${TOPICS[@]}"; do
  TOPIC_FQN="persistent://${FULL_NAMESPACE}/${topic}"
  echo -n "  Creating topic ${TOPIC_FQN}... "
  "${PULSAR_ADMIN}" --admin-url "${ADMIN_URL}" topics create-partitioned-topic "${TOPIC_FQN}" \
    --partitions 4 2>&1 && echo "OK" || echo "EXISTS/SKIPPED"
done

echo ""
echo "==> Done. Pulsar tenant, namespace, retention policies, and topics configured."
echo ""
echo "Verify topics with:"
echo "  ${PULSAR_ADMIN} --admin-url ${ADMIN_URL} topics list ${FULL_NAMESPACE}"
