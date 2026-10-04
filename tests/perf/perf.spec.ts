import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { generatePerfFixtures, FIXTURE_SIZES } from './generate-fixtures.js';
import { profileAdr09Ingestion, runBenchmark } from './perf-runner.js';

describe('Performance Benchmark Suite (P6-08 / ARCH §12 / ADR-09)', () => {
  it('generates exact size fixtures for 1 MiB, 5 MiB, and 20 MiB', () => {
    const fixtures = generatePerfFixtures();

    expect(fs.existsSync(fixtures.pdf1Mb)).toBe(true);
    expect(fs.existsSync(fixtures.pdf5Mb)).toBe(true);
    expect(fs.existsSync(fixtures.pdf20Mb)).toBe(true);

    expect(fs.statSync(fixtures.pdf1Mb).size).toBe(FIXTURE_SIZES.ONE_MB);
    expect(fs.statSync(fixtures.pdf5Mb).size).toBe(FIXTURE_SIZES.FIVE_MB);
    expect(fs.statSync(fixtures.pdf20Mb).size).toBe(FIXTURE_SIZES.TWENTY_MB);
  });

  it('profiles ADR-09 Multer disk staging vs storage ingest overhead', async () => {
    const fixtures = generatePerfFixtures();
    const profiles = await profileAdr09Ingestion(fixtures);

    expect(profiles).toHaveLength(3);
    for (const p of profiles) {
      expect(p.diskStagingMs).toBeGreaterThan(0);
      expect(p.storageWriteMs).toBeGreaterThan(0);
      expect(p.totalMs).toBeGreaterThan(0);
      expect(p.stagingRatioPct).toBeGreaterThanOrEqual(0);
      expect(p.stagingRatioPct).toBeLessThanOrEqual(100);
    }
  });

  it('runs complete concurrency matrix and telemetry checks under ARCH §12', async () => {
    // Executes benchmark across 10, 50, 100 concurrent workers
    await expect(runBenchmark()).resolves.not.toThrow();
  }, 30000);
});
