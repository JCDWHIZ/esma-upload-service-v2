import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';

export interface ContractResponsePayload {
  status: number;
  contentType: string;
  body: unknown;
  bodyShape?: unknown;
}

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const ISO_DATE_REGEX = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gi;
const URL_REGEX = /https?:\/\/[^\s"']+/gi;

/**
 * Normalizes dynamic values (IDs, timestamps, URLs) within strings and complex structures
 */
export function normalizeValue(val: unknown): unknown {
  if (typeof val === 'string') {
    let result = val;
    // Normalize full URLs first
    result = result.replace(URL_REGEX, '<URL>');
    // Normalize ISO timestamps
    result = result.replace(ISO_DATE_REGEX, '<TS>');
    // Normalize UUIDs
    result = result.replace(UUID_REGEX, '<ID>');
    return result;
  }

  if (typeof val === 'number') {
    // If it looks like a Unix timestamp in ms (> 1700000000000) or s (> 1700000000)
    if (val > 1700000000000 && val < 2000000000000) {
      return '<TS>';
    }
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => normalizeValue(item));
  }

  if (val !== null && typeof val === 'object') {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(val).sort();
    for (const key of keys) {
      sortedObj[key] = normalizeValue((val as Record<string, unknown>)[key]);
    }
    return sortedObj;
  }

  return val;
}

/**
 * Derives a structural shape definition (key -> type)
 */
export function deriveShape(val: unknown): unknown {
  if (val === null) return 'null';
  if (Array.isArray(val)) {
    const itemShapes = val.map(deriveShape);
    const unique = Array.from(new Set(itemShapes));
    return `array<${unique.join(' | ') || 'unknown'}>`;
  }
  if (typeof val === 'object') {
    const shape: Record<string, unknown> = {};
    const keys = Object.keys(val).sort();
    for (const key of keys) {
      shape[key] = deriveShape((val as Record<string, unknown>)[key]);
    }
    return shape;
  }
  return typeof val;
}

/**
 * Asserts actual response against stored fixture or generates/updates fixture when UPDATE_FIXTURES=true
 */
export async function assertContractFixture(
  fixtureKey: string,
  actual: {
    status: number;
    headers: Record<string, string | undefined>;
    body: unknown;
  },
): Promise<void> {
  await Promise.resolve();
  const fixturesDir = path.resolve('tests/reference/fixtures');
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  const fixtureFile = path.join(fixturesDir, `${fixtureKey}.json`);

  const rawContentType = actual.headers['content-type'] || 'application/json';
  const cleanContentType = rawContentType.split(';')[0]?.trim() || '';

  const normalizedBody = normalizeValue(actual.body);
  const shape = deriveShape(actual.body);

  const payload: ContractResponsePayload = {
    status: actual.status,
    contentType: cleanContentType,
    body: normalizedBody,
    bodyShape: shape,
  };

  const shouldUpdate =
    process.env.UPDATE_FIXTURES === 'true' || !fs.existsSync(fixtureFile);

  if (shouldUpdate) {
    fs.writeFileSync(
      fixtureFile,
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
  }

  const fileContent = fs.readFileSync(fixtureFile, 'utf8');
  const expected = JSON.parse(fileContent) as ContractResponsePayload;

  expect(actual.status).toBe(expected.status);
  expect(cleanContentType).toBe(expected.contentType);
  expect(normalizedBody).toEqual(expected.body);
  expect(shape).toEqual(expected.bodyShape);
}
