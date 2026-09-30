# P5-01 · Kafka Client Spike and Decision

> **Author:** esma-upload-service-v2 team  
> **Status:** DECISION REACHED  
> **Timebox:** 2 days  
> **References:** ARCH §8.6, ADR-08, P5-01

---

## 1. Goal

Select the Kafka client library for `KafkaBrokerDriver` (P5-02).

**Key requirements for our use case:**

| Requirement | Why |
|---|---|
| ESM + TypeScript support | Project is strict ESM, `"type":"module"` |
| Node 22 support | Runtime target |
| `linux/arm64` prebuilt binaries (or no native deps) | Deployment image on ARM Graviton/Apple Silicon |
| Idempotent producer (`acks=all`) | Prevent duplicate publish under retries |
| Manual offset commit | Required for at-least-once delivery guarantee |
| Partition pause/resume per-partition | Core mechanism for retry-tier consumers |
| Admin API for topic creation | `ensureTopics()` at startup |
| Broker restart survival / reconnect | Resilience requirement |
| Active maintenance | No orphaned libraries in production |

---

## 2. Candidates Evaluated

Three candidates assessed:

1. **`kafkajs`** — historically the dominant pure-JS option
2. **`@confluentinc/kafka-javascript`** — Confluent's official native client wrapping `librdkafka`
3. **`@platformatic/kafka`** — modern pure-JS/TS implementation by the Platformatic team

---

## 3. Evaluation Matrix

| Criterion | kafkajs | @confluentinc/kafka-javascript | @platformatic/kafka |
|---|---|---|---|
| **Maintenance status** | ❌ Abandoned (no releases since 2023, issues unaddressed) | ✅ Actively maintained by Confluent | ✅ Actively maintained |
| **Latest release (approx)** | 2023 (stale) | 2025 (GA, production-supported) | 2025 |
| **TypeScript support** | ✅ Built-in types | ✅ Full TS types | ✅ Written in TS |
| **ESM support** | ✅ Works | ✅ Works (requires import config) | ✅ Native ESM |
| **Node 22 support** | ⚠️ Works but untested upstream | ✅ Officially tested | ✅ Officially tested |
| **arm64 linux — prebuilt binaries** | ✅ No native deps | ✅ Prebuilt `librdkafka` binaries for arm64/glibc | ✅ No native deps (pure JS) |
| **arm64 linux — musl/alpine** | ✅ | ⚠️ May need compilation on musl | ✅ No issue |
| **Idempotent producer** | ✅ `idempotent: true` | ✅ Standard `librdkafka` idempotence | ✅ Configurable |
| **Manual commit** | ✅ `autoCommit: false` | ✅ Manual commit API | ✅ `enable.auto.commit: false` |
| **Partition pause/resume** | ✅ Per-partition pause | ✅ Per-partition pause (librdkafka) | ✅ Per-partition pause |
| **Admin API (topic creation)** | ✅ `Admin` client | ✅ `AdminClient` | ✅ Admin API |
| **Broker restart survival** | ⚠️ Some issues reported, no fixes shipped | ✅ Battle-tested via librdkafka | ✅ Reconnect built-in |
| **DLQ / retry tier routing** | ✅ Manual publish to retry topics | ✅ Manual publish to retry topics | ✅ Manual publish to retry topics |
| **KafkaJS migration path** | N/A | ✅ KafkaJS-compatible API layer available | ✅ Similar API style |
| **License** | MIT | Apache 2.0 | Apache 2.0 |
| **Image size impact** | Minimal (pure JS) | ~15–20 MB extra (librdkafka) | Minimal (pure JS) |
| **Performance** | Moderate | High (native librdkafka) | High (optimised JS) |

---

## 4. Proof-of-Concept Results

Both **`@confluentinc/kafka-javascript`** and **`@platformatic/kafka`** were validated against a local Kafka KRaft container.

### Test scenarios (both passed)

| Scenario | @confluentinc/kafka-javascript | @platformatic/kafka |
|---|---|---|
| Produce with `acks=all`, idempotent | ✅ | ✅ |
| Consume with manual commit after handler | ✅ | ✅ |
| Pause partition until timestamp (retry tier) | ✅ `pause()` → `setTimeout` → `resume()` | ✅ Same pattern |
| Create topic via Admin API | ✅ `AdminClient.createTopics()` | ✅ Admin API |
| Survive broker restart, resume delivery | ✅ librdkafka reconnect | ✅ Built-in reconnect |
| arm64 Docker build (`node:22-bookworm-slim`) | ✅ Prebuilt binary available, no compilation | ✅ No native build needed |

---

## 5. Decision

### ✅ Recommended: `@confluentinc/kafka-javascript`

**Rationale:**

1. **Production-grade stability** — backed by Confluent's team, the same engineers who maintain `librdkafka`. Battle-tested under enterprise workloads.
2. **arm64 prebuilt binaries** — available for `linux/arm64/glibc` (`node:22-bookworm-slim`). No compilation required in Docker. Image size increase is acceptable (~15 MB).
3. **KafkaJS migration shim** — the `KafkaJS`-compatible API (`require('@confluentinc/kafka-javascript').KafkaJS`) reduces the learning curve and makes future migration from any KafkaJS-based code straightforward.
4. **librdkafka performance** — produces with lower latency and higher throughput than a pure-JS implementation at scale.
5. **Security patches** — Confluent issues security patches promptly; kafkajs has had CVEs unaddressed for extended periods.

**Trade-off accepted:** ~15–20 MB increase in Docker image size due to `librdkafka` binaries. This is acceptable for the gains in stability and performance.

**Not chosen — `@platformatic/kafka`:** A close second. Pure JS, no native deps, excellent TypeScript support. Preferred if arm64 native binaries were an issue or image size was critical. Worth revisiting if the Confluent client introduces friction.

**Eliminated — `kafkajs`:** Abandoned. No maintenance, no security fixes, open issues unresolved since 2023. Not suitable for new production code.

---

## 6. Retry Tier Architecture (for P5-02)

The consumer framework (P4-05) produces `retry` outcomes with a `delayMs`. The Kafka driver maps this to tiered retry topics:

```
esma.files.replication             ← main topic
esma.files.replication.retry.10s   ← delay 0–30 s
esma.files.replication.retry.1m    ← delay 30 s–5 m
esma.files.replication.retry.10m   ← delay > 5 m
esma.files.dlq                     ← after maxAttempts exhausted
```

Each retry tier topic has a dedicated consumer that:
1. Reads the message
2. Checks the `x-not-before` header timestamp
3. **Pauses the partition** until `Date.now() >= notBefore`
4. Resumes and re-publishes to the main topic

This means the main consumer is **never blocked** by delayed retries.

---

## 7. Topics to Create (P5-02 Reference)

```
# Main logical topics
esma.files.replication
esma.files.processing
esma.files.audit
esma.files.dlq

# Retry tiers (per main topic that needs retries)
esma.files.replication.retry.10s
esma.files.replication.retry.1m
esma.files.replication.retry.10m

esma.files.processing.retry.10s
esma.files.processing.retry.1m
esma.files.processing.retry.10m
```

Config values needed (for `.env.example`):
```
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=esma-upload-service
KAFKA_TOPIC_PREFIX=esma.files
KAFKA_TOPIC_PARTITIONS=6
KAFKA_TOPIC_REPLICATION_FACTOR=1   # 3 in production
KAFKA_SSL=false
KAFKA_SASL_MECHANISM=              # plain | scram-sha-256 | scram-sha-512
KAFKA_SASL_USERNAME=
KAFKA_SASL_PASSWORD=
```

---

## 8. ARCH §8.6 Update

**Before:** ARCH §8.6 referenced `kafkajs` as the expected Kafka client.  
**After:** `@confluentinc/kafka-javascript` (promisified API) is the chosen client. The KafkaJS-compatible shim API is available if migration from kafkajs code is needed but will not be used for the KafkaBrokerDriver implementation.

The driver will be implemented in `src/events/kafka-broker.driver.ts` as part of P5-02.

---

## 9. Next Steps

- [x] Decision recorded in this document
- [x] arm64 Docker build verified (prebuilt binaries confirmed available)
- [ ] Implement `KafkaBrokerDriver` — P5-02
- [ ] Add `@confluentinc/kafka-javascript` to `package.json` dependencies
- [ ] Add `scripts/create-kafka-topics.sh` for production provisioning
- [ ] Update `ARCHITECTURE_AND_ROADMAP.md` §8.6
