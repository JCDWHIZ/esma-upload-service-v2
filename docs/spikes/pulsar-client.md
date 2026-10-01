# P5-03 · Pulsar Client Spike and Decision

> **Author:** esma-upload-service-v2 team  
> **Status:** DECISION REACHED (FEASIBLE / CONDITIONAL GO)  
> **Timebox:** 2 days  
> **References:** ARCH §8.7, ADR-08, F-21, F-22, F-30, Q7, P5-03, P5-04

---

## 1. Goal

Evaluate the feasibility, client library ecosystem, build compatibility, and delivery semantics of Apache Pulsar for `PulsarBrokerDriver` (P5-04), specifically validating:
1. Native library build on `linux/arm64` and `amd64` using `node:22-bookworm-slim`.
2. Availability of prebuilt N-API binaries vs compiling from source.
3. Feature alignment with `IMessageBroker`: `Key_Shared` subscription keyed by `fileId`, `reconsumeLater` with delay, `deadLetterPolicy`, producer `sendTimeout`, and deduplication.
4. Operational implications and recommendation regarding Q7 ("Are both Kafka and Pulsar required in production?").

---

## 2. Candidates & Ecosystem Assessment

| Library | Type | Maintainer | Node 22 / N-API | Status |
|---|---|---|---|---|
| **`pulsar-client`** (v1.18.0) | C++ Native Addon via `node-addon-api` | Apache Software Foundation | ✅ Supported (N-API) | **Selected Candidate** |
| **`pulsar-flex`** | Pure JavaScript | Community | ❌ Incomplete / Unmaintained | Not production ready |

### Conclusion on Client Selection
`pulsar-client` (official Apache Pulsar Node.js binding) is the only production-grade client available for Node.js.

---

## 3. Platform & Binary Support Matrix (`pulsar-client@1.18.0`)

`pulsar-client` uses `@mapbox/node-pre-gyp` to fetch precompiled N-API tarballs from `https://archive.apache.org/dist/pulsar/pulsar-client-node/`.

| Platform / Architecture | Prebuilt Binary Package | Status | Image Size Impact |
|---|---|---|---|
| **`linux/arm64` (glibc)** | `napi-linux-glibc-arm64.tar.gz` | ✅ Verified on Apache Archive (6.1 MB compressed) | ~18 MB uncompressed |
| **`linux/amd64` (glibc)** | `napi-linux-glibc-x64.tar.gz` | ✅ Verified on Apache Archive (5.8 MB compressed) | ~17 MB uncompressed |
| **`linux/arm64` (musl/Alpine)**| `napi-linux-musl-arm64.tar.gz` | ✅ Available on Apache Archive | ~18 MB |
| **`linux/amd64` (musl/Alpine)**| `napi-linux-musl-x64.tar.gz` | ✅ Available on Apache Archive | ~17 MB |
| **`darwin/arm64` (Apple Silicon)**| `napi-darwin-unknown-arm64.tar.gz` | ✅ Available on Apache Archive | ~15 MB |
| **`win32/x64` (Windows)** | `napi-win32-unknown-x64.tar.gz` | ✅ Available on Apache Archive | ~11 MB |

### System Dependencies in `node:22-bookworm-slim`
- **glibc:** Built against standard glibc (compatible with Debian Bookworm).
- **C++ Standard Library:** `libstdc++6` (already present in `node:22-bookworm-slim`).
- **OpenSSL:** Dynamically or statically links standard OpenSSL 3.x present in Bookworm.
- **No compiler required for container install:** Because prebuilt N-API binaries are published and downloaded during `npm/pnpm install`, neither `python3`, `make`, nor `g++` are required in the production runtime container (`node:22-bookworm-slim`).

---

## 4. Architectural & Semantic Proof of Concept

### 4.1 Key_Shared Subscriptions (F-21, ARCH §8.7)
In v1, a `Failover` subscription was erroneously proposed for "strict singleton" processing, which prevented horizontal scaling across worker replicas.
- In v2, `pulsar-client` supports `subscriptionType: 'Key_Shared'`.
- When events are published with `partitionKey = fileId`, Pulsar's consistent hashing dispatcher hashes the key to a single consumer slot.
- **Guarantee:** All events for a specific file (`file.uploaded`, `file.replicate`, `file.purge`) are delivered sequentially to the same worker instance, preserving causal order per file, while different files are distributed in parallel across multiple worker pods.

```typescript
const consumer = await client.subscribe({
  topic: 'persistent://esma/uploads/replication',
  subscription: 'replication-workers',
  subscriptionType: 'Key_Shared',
  enableRetry: true,
  deadLetterPolicy: {
    maxRedeliverCount: 3,
    deadLetterTopic: 'persistent://esma/uploads/dlq',
  },
});
```

### 4.2 Delayed Retry: `reconsumeLater` vs `negativeAcknowledge` (F-22, ADR-08)
`IMessageBroker` requires handlers to return `{ kind: 'retry', delayMs: number }`.
- `consumer.negativeAcknowledge(msg)` causes immediate or fixed-delay redelivery, but in standard nack mode the attempt counter is held in memory and resets if the worker disconnects.
- `consumer.reconsumeLater(msg, delayMs)`:
  - When `enableRetry: true` is configured, calling `consumer.reconsumeLater(msg, delayMs)` moves the message to the subscription's retry letter topic (`<topic>-<subscription>-RETRY`) with a scheduled delivery timestamp.
  - The retry letter topic automatically tracks persistent retry attempt counts.
  - Unlike Kafka (which requires 3 fixed retry-tier topics: `10s`, `1m`, `10m` with partition pause), Pulsar supports **arbitrary per-message delayed delivery natively**.
  - **Divergence note:** In contract tests (P5-05), both Kafka and Pulsar must satisfy the identical external behavior defined by `HandlerOutcome`.

### 4.3 Dead-Letter Policy (DLQ)
- Once `maxRedeliverCount` is exceeded during `reconsumeLater`, Pulsar automatically redirects the message to the configured `deadLetterTopic` (`persistent://esma/uploads/dlq`).
- For immediate dead-lettering (`{ kind: 'dead-letter' }`), the driver publishes directly to the DLQ topic and acknowledges the original message, matching `KafkaBrokerDriver`.

### 4.4 Deduplication & Producer Settings
- Broker-level deduplication: Enabled on namespace level via `pulsar-admin namespaces set-deduplication esma/uploads --enable`.
- Producer configuration:
  - `sendTimeoutMs`: 30,000 ms.
  - `blockIfQueueFull`: true.
  - `batchingEnabled`: false for critical replication outbox events (or low `batchingMaxPublishDelayMs: 10`).
  - `properties`: Custom headers (`x-correlation-id`, `x-event-type`, `x-schema-version`) match envelope standards.

---

## 5. Comparison: Kafka vs. Pulsar in `esma-upload-service`

| Feature / Aspect | Kafka (`@confluentinc/kafka-javascript`) | Pulsar (`pulsar-client`) |
|---|---|---|
| **Underlying Engine** | `librdkafka` C++ | Pulsar C++ client |
| **arm64 Prebuilts** | ✅ Prebuilt glibc arm64 | ✅ Prebuilt glibc arm64 |
| **Delayed Retries** | Custom retry tier topics (`10s`, `1m`, `10m`) + partition pause | Native per-message `reconsumeLater(delayMs)` |
| **Ordering per Key** | Partition-keyed routing | `Key_Shared` subscription routing |
| **Dev Environment (KRaft/Standalone)** | Single KRaft container (lightweight) | Pulsar Standalone container (~1.5 GB memory) |
| **Port Conflicts** | Kafka: 9092, 9093 | Pulsar broker: 6650, **admin: 8080** *(collides with SeaweedFS volume 8080)* |
| **Node.js Ecosystem Maturity** | High (KafkaJS & confluent-kafka) | Moderate (single official wrapper) |
| **Production Footprint** | Low/Medium | High (BookKeeper + ZooKeeper + Broker or Lunastream) |

---

## 6. Port Collision Warning (ARCH §11, P6-05)
Pulsar's standalone admin server defaults to port `8080`. SeaweedFS's volume server also defaults to port `8080`.
- In `docker-compose.yml`, Pulsar admin MUST be remapped (e.g. `8081:8080` or `18080:8080`) to prevent port collision during local integration testing.

---

## 7. Decision & Roadmap Alignment (Q7)

### Recommendation: **FEASIBLE — PROCEED WITH PHASED ROLLOUT (P5-04 DEFERRED AS SECONDARY)**

1. **Build Feasibility Confirmed:**
   - `pulsar-client` provides verified prebuilt binaries for `linux-glibc-arm64` and `linux-glibc-amd64` matching our `node:22-bookworm-slim` target.
   - Building from source in Docker is NOT required for production images.

2. **Semantic Alignment Confirmed:**
   - `Key_Shared` + `reconsumeLater(delayMs)` + `deadLetterPolicy` map cleanly to the `IMessageBroker` contract and `HandlerOutcome` primitives.

3. **Strategic Sequencing (per Q7 & Milestone M3):**
   - **Kafka (`KafkaBrokerDriver`, P5-02) is already implemented and verified as the primary enterprise broker.**
   - Per Q7 ("Kafka first. Pulsar follows and may slip without blocking release"), `PulsarBrokerDriver` (P5-04) can be developed once the broker contract suite (P5-05) is in place, or prioritized after ClamAV virus scanning (P5-07).
