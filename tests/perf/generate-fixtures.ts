import * as fs from 'node:fs';
import * as path from 'node:path';

export const FIXTURE_SIZES = {
  ONE_MB: 1 * 1024 * 1024,
  FIVE_MB: 5 * 1024 * 1024,
  TWENTY_MB: 20 * 1024 * 1024,
};

/**
 * Creates a valid PDF binary buffer of exact size in bytes.
 * The buffer starts with %PDF-1.4 header and ends with %%EOF trailer,
 * with repeatable content padded to reach targetSize.
 */
export function createPdfBuffer(targetSize: number): Buffer {
  const header = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n3 0 obj\n<< /Length ', 'ascii');
  const trailer = Buffer.from(' >>\nstream\n', 'ascii');
  const footer = Buffer.from('\nendstream\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n200\n%%EOF\n', 'ascii');

  const overhead = header.length + trailer.length + footer.length + 10;
  if (targetSize < overhead) {
    throw new Error(`Target size ${targetSize} too small for valid PDF payload`);
  }

  const streamLen = targetSize - overhead;
  const lenStr = Buffer.from(streamLen.toString().padEnd(10, ' '), 'ascii');
  const padding = Buffer.alloc(streamLen, 0x41); // 'A'

  return Buffer.concat([header, lenStr, trailer, padding, footer]);
}

/**
 * Generates test fixtures in the specified directory.
 */
export function generatePerfFixtures(outDir?: string): {
  pdf1Mb: string;
  pdf5Mb: string;
  pdf20Mb: string;
  bin1Mb: string;
  bin5Mb: string;
  bin20Mb: string;
} {
  const targetDir = outDir ?? path.resolve('tests/perf/fixtures');
  fs.mkdirSync(targetDir, { recursive: true });

  const files = {
    pdf1Mb: path.join(targetDir, 'test-1mb.pdf'),
    pdf5Mb: path.join(targetDir, 'test-5mb.pdf'),
    pdf20Mb: path.join(targetDir, 'test-20mb.pdf'),
    bin1Mb: path.join(targetDir, 'test-1mb.bin'),
    bin5Mb: path.join(targetDir, 'test-5mb.bin'),
    bin20Mb: path.join(targetDir, 'test-20mb.bin'),
  };

  // Generate 1 MiB, 5 MiB, 20 MiB PDF files
  fs.writeFileSync(files.pdf1Mb, createPdfBuffer(FIXTURE_SIZES.ONE_MB));
  fs.writeFileSync(files.pdf5Mb, createPdfBuffer(FIXTURE_SIZES.FIVE_MB));
  fs.writeFileSync(files.pdf20Mb, createPdfBuffer(FIXTURE_SIZES.TWENTY_MB));

  // Generate 1 MiB, 5 MiB, 20 MiB raw binary files
  fs.writeFileSync(files.bin1Mb, Buffer.alloc(FIXTURE_SIZES.ONE_MB, 0x58));
  fs.writeFileSync(files.bin5Mb, Buffer.alloc(FIXTURE_SIZES.FIVE_MB, 0x59));
  fs.writeFileSync(files.bin20Mb, Buffer.alloc(FIXTURE_SIZES.TWENTY_MB, 0x5a));

  return files;
}

if (process.argv[1] && (process.argv[1].endsWith('generate-fixtures.ts') || process.argv[1].endsWith('generate-fixtures.js'))) {
  const dir = path.resolve('tests/perf/fixtures');
  const generated = generatePerfFixtures(dir);
  // eslint-disable-next-line no-console
  console.log(`Generated performance fixtures in ${dir}:`);
  for (const [key, filePath] of Object.entries(generated)) {
    const stat = fs.statSync(filePath);
    // eslint-disable-next-line no-console
    console.log(`  - ${key}: ${path.basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(2)} MiB / ${stat.size} bytes)`);
  }
}
