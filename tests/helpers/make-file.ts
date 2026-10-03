import * as fs from 'node:fs';
import * as path from 'node:path';

export type FixtureKind =
  'png' | 'jpeg' | 'jpg' | 'gif' | 'pdf' | 'docx' | 'xlsx' | 'fake-executable';

export interface FixtureFile {
  kind: FixtureKind;
  filename: string;
  mime: string;
  path: string;
  buffer: Buffer;
  size: number;
}

const KIND_MAPPING: Record<FixtureKind, { filename: string; mime: string }> = {
  png: { filename: 'sample.png', mime: 'image/png' },
  jpeg: { filename: 'sample.jpg', mime: 'image/jpeg' },
  jpg: { filename: 'sample.jpg', mime: 'image/jpeg' },
  gif: { filename: 'sample.gif', mime: 'image/gif' },
  pdf: { filename: 'sample.pdf', mime: 'application/pdf' },
  docx: {
    filename: 'sample.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    filename: 'sample.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  'fake-executable': {
    filename: 'fake-pdf-executable.pdf',
    mime: 'application/pdf',
  },
};

export function makeFile(kind: FixtureKind): FixtureFile {
  const meta = KIND_MAPPING[kind];
  if (!meta) {
    throw new Error(`Unknown fixture kind: ${kind}`);
  }

  const fixturesDir = path.resolve('tests/fixtures');
  const filePath = path.join(fixturesDir, meta.filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Fixture file not found at ${filePath}. Run scripts/generate-fixtures.ts first.`,
    );
  }

  const buffer = fs.readFileSync(filePath);

  return {
    kind,
    filename: meta.filename,
    mime: meta.mime,
    path: filePath,
    buffer,
    size: buffer.length,
  };
}
