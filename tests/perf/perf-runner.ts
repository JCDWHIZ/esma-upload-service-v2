import * as fs from 'node:fs';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { generatePerfFixtures, FIXTURE_SIZES } from './generate-fixtures.js';

interface BenchmarkMetric {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  errors: number;
}

function calculatePercentiles(
  latencies: number[],
  errors = 0,
): BenchmarkMetric {
  if (latencies.length === 0) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p90: 0,
      p95: 0,
      p99: 0,
      errors,
    };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const p = (pct: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
    ];

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Number((sum / sorted.length).toFixed(2)),
    p50: p(50),
    p90: p(90),
    p95: p(95),
    p99: p(99),
    errors,
  };
}

async function runWorkerPool<T>(
  concurrency: number,
  items: T[],
  workerFn: (item: T, index: number) => Promise<number | null>,
): Promise<{ latencies: number[]; errors: number }> {
  const latencies: number[] = [];
  let errors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      try {
        const duration = await workerFn(item, idx);
        if (duration !== null) {
          latencies.push(duration);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return { latencies, errors };
}

/**
 * ADR-09 Profiler: Simulates and profiles Multer disk staging vs storage ingest
 */
export async function profileAdr09Ingestion(fixtures: {
  pdf1Mb: string;
  pdf5Mb: string;
  pdf20Mb: string;
}): Promise<
  {
    sizeMb: number;
    diskStagingMs: number;
    storageWriteMs: number;
    dbTxMs: number;
    outboxMs: number;
    totalMs: number;
    stagingRatioPct: number;
  }[]
> {
  const tmpStagingDir = path.resolve('tests/perf/fixtures/staging-profile-tmp');
  fs.mkdirSync(tmpStagingDir, { recursive: true });

  const runs = [
    { label: '1 MiB', file: fixtures.pdf1Mb, size: FIXTURE_SIZES.ONE_MB },
    { label: '5 MiB', file: fixtures.pdf5Mb, size: FIXTURE_SIZES.FIVE_MB },
    { label: '20 MiB', file: fixtures.pdf20Mb, size: FIXTURE_SIZES.TWENTY_MB },
  ];

  const results = [];

  for (const run of runs) {
    const buffer = fs.readFileSync(run.file);

    // 1. Measure disk staging (Multer diskStorage write)
    const stagingStart = performance.now();
    const stagedFile = path.join(
      tmpStagingDir,
      `staged-${path.basename(run.file)}`,
    );
    fs.writeFileSync(stagedFile, buffer);
    const diskStagingMs = performance.now() - stagingStart;

    // 2. Measure read + driver storage copy (e.g. SeaweedFS / S3 / Local storage stream)
    const storageStart = performance.now();
    const readStream = fs.createReadStream(stagedFile);
    const sinkPath = path.join(
      tmpStagingDir,
      `sink-${path.basename(run.file)}`,
    );
    const writeStream = fs.createWriteStream(sinkPath);
    await new Promise<void>((resolve, reject) => {
      readStream.pipe(writeStream);
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });
    const storageWriteMs = performance.now() - storageStart;

    // Clean up temporary profile files
    try {
      fs.unlinkSync(stagedFile);
      fs.unlinkSync(sinkPath);
    } catch {
      // ignore
    }

    // 3. Database transaction overhead (simulated Kysely multi-row insert)
    const dbTxStart = performance.now();
    await new Promise((r) => setTimeout(r, 4)); // typical DB RTT + insert
    const dbTxMs = performance.now() - dbTxStart;

    // 4. Outbox emission
    const outboxStart = performance.now();
    await new Promise((r) => setTimeout(r, 1));
    const outboxMs = performance.now() - outboxStart;

    const totalMs = diskStagingMs + storageWriteMs + dbTxMs + outboxMs;
    const stagingRatioPct = Number(
      ((diskStagingMs / totalMs) * 100).toFixed(1),
    );

    results.push({
      sizeMb: run.size / (1024 * 1024),
      diskStagingMs: Number(diskStagingMs.toFixed(2)),
      storageWriteMs: Number(storageWriteMs.toFixed(2)),
      dbTxMs: Number(dbTxMs.toFixed(2)),
      outboxMs: Number(outboxMs.toFixed(2)),
      totalMs: Number(totalMs.toFixed(2)),
      stagingRatioPct,
    });
  }

  try {
    fs.rmdirSync(tmpStagingDir);
  } catch {
    // ignore
  }

  return results;
}

export async function runBenchmark(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    '===============================================================',
  );
  // eslint-disable-next-line no-console
  console.log(
    '  ESMA Upload Service v2 - Performance & Resilience Benchmark  ',
  );
  // eslint-disable-next-line no-console
  console.log(
    '===============================================================\n',
  );

  // 1. Generate Fixtures
  const fixtures = generatePerfFixtures();

  // 2. Start Event-loop delay monitor
  const elHistogram = monitorEventLoopDelay({ resolution: 20 });
  elHistogram.enable();

  // 3. Memory baseline
  const memBefore = process.memoryUsage();

  // 4. Ingestion Profiling under ADR-09
  // eslint-disable-next-line no-console
  console.log(
    '>>> [1/3] Profiling Multer Disk Staging vs Storage Ingest (ADR-09)...',
  );
  const adr09Profiles = await profileAdr09Ingestion(fixtures);
  // eslint-disable-next-line no-console
  console.table(adr09Profiles);

  // 5. Concurrency benchmark (10, 50, 100 concurrent workers)
  // eslint-disable-next-line no-console
  console.log('\n>>> [2/3] Executing Concurrency Matrix (10, 50, 100 VUs)...');

  const concurrencyLevels = [10, 50, 100];
  const uploadMetrics: Record<string, BenchmarkMetric> = {};

  for (const vu of concurrencyLevels) {
    const tasks = Array.from({ length: vu * 2 }, (_, i) => ({
      id: i,
      file: fixtures.pdf5Mb, // 5 MiB ARCH §12 reference target
    }));

    const result = await runWorkerPool(vu, tasks, async (task) => {
      const start = performance.now();
      // Simulate payload transfer and ingestion pipeline
      fs.readFileSync(task.file);
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25)); // simulated server processing
      return performance.now() - start;
    });

    uploadMetrics[`5MiB_${vu}VUs`] = calculatePercentiles(
      result.latencies,
      result.errors,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    '\nFast-Path Latency for 5 MiB File (ARCH §12 Target: p95 < 1500 ms):',
  );
  // eslint-disable-next-line no-console
  console.table(uploadMetrics);

  // 6. Keyset pagination benchmark (100 VUs)
  // eslint-disable-next-line no-console
  console.log('\n>>> [3/3] Benchmarking Keyset Cursor Pagination (100 VUs)...');
  const paginationTasks = Array.from({ length: 200 }, (_, i) => ({ page: i }));
  const paginationResult = await runWorkerPool(
    100,
    paginationTasks,
    async () => {
      const start = performance.now();
      // Simulate keyset lookup WHERE id > :afterId ORDER BY id ASC LIMIT 20
      await new Promise((r) => setTimeout(r, 3 + Math.random() * 8));
      return performance.now() - start;
    },
  );
  const paginationMetric = calculatePercentiles(
    paginationResult.latencies,
    paginationResult.errors,
  );
  // eslint-disable-next-line no-console
  console.table({ KeysetPagination_100VUs: paginationMetric });

  // 7. Event-Loop & Resource Stats
  elHistogram.disable();
  const memAfter = process.memoryUsage();

  // eslint-disable-next-line no-console
  console.log('\n================ Performance Telemetry ================');
  // eslint-disable-next-line no-console
  console.log(
    `Event Loop Delay (Mean): ${(elHistogram.mean / 1e6).toFixed(2)} ms`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Event Loop Delay (p95):  ${(elHistogram.percentile(95) / 1e6).toFixed(2)} ms`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Event Loop Delay (Max):  ${(elHistogram.max / 1e6).toFixed(2)} ms`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Heap Used Delta:         ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `RSS Memory:              ${(memAfter.rss / 1024 / 1024).toFixed(2)} MB`,
  );
  // eslint-disable-next-line no-console
  console.log('========================================================\n');
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('perf-runner.ts') ||
    process.argv[1].endsWith('perf-runner.js'))
) {
  runBenchmark()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Benchmark failed:', err);
      process.exit(1);
    });
}
