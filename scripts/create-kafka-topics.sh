#!/usr/bin/env bash
# scripts/create-kafka-topics.sh
# Production Kafka topic provisioning for esma-upload-service-v2
# Usage: KAFKA_BROKERS=broker1:9092 KAFKA_TOPIC_PREFIX=esma.files \
#          KAFKA_PARTITIONS=6 KAFKA_REPLICATION_FACTOR=3 ./create-kafka-topics.sh
#
# Run this once before starting the service in production.
# In non-production, topics are auto-created by the service on startup.

set -euo pipefail

BROKERS="${KAFKA_BROKERS:-localhost:9092}"
PREFIX="${KAFKA_TOPIC_PREFIX:-esma.files}"
PARTITIONS="${KAFKA_PARTITIONS:-6}"
REPLICATION="${KAFKA_REPLICATION_FACTOR:-3}"

# kafka-topics.sh must be on PATH (from Kafka bin dir or a container)
KAFKA_TOPICS="${KAFKA_TOPICS_CMD:-kafka-topics.sh}"

echo "==> Creating Kafka topics for esma-upload-service-v2"
echo "    Brokers: ${BROKERS}"
echo "    Prefix:  ${PREFIX}"
echo "    Partitions: ${PARTITIONS}, Replication: ${REPLICATION}"
echo ""

# Main logical topics
MAIN_TOPICS=(
  "replication"
  "processing"
  "audit"
  "dlq"
)

# Retry tiers (only for topics that use the consumer framework)
RETRY_TOPICS=(
  "replication.retry.10s"
  "replication.retry.1m"
  "replication.retry.10m"
  "processing.retry.10s"
  "processing.retry.1m"
  "processing.retry.10m"
)

create_topic() {
  local name="$1"
  local full="${PREFIX}.${name}"
  echo -n "  Creating ${full}... "
  "${KAFKA_TOPICS}" \
    --bootstrap-server "${BROKERS}" \
    --create \
    --if-not-exists \
    --topic "${full}" \
    --partitions "${PARTITIONS}" \
    --replication-factor "${REPLICATION}" \
    --config retention.ms=604800000 \
    --config cleanup.policy=delete \
    2>&1 && echo "OK" || echo "SKIPPED (already exists)"
}

echo "--- Main topics ---"
for topic in "${MAIN_TOPICS[@]}"; do
  create_topic "${topic}"
done

echo ""
echo "--- Retry tier topics ---"
for topic in "${RETRY_TOPICS[@]}"; do
  create_topic "${topic}"
done

echo ""
echo "==> Done. All topics created (or already existed)."
echo ""
echo "Verify with:"
echo "  ${KAFKA_TOPICS} --bootstrap-server ${BROKERS} --list | grep ${PREFIX}"
