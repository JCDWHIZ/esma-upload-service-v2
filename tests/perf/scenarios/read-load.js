import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const metadataDuration = new Trend('read_metadata_duration');
const contentDuration = new Trend('read_content_duration');
const rangeReadDuration = new Trend('read_range_duration');
const readFailures = new Rate('read_failures');

export const options = {
  scenarios: {
    read_ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 50 },
        { duration: '1m',  target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'read_metadata_duration': ['p(95)<100'],  // Metadata lookup under 100ms
    'read_content_duration': ['p(95)<500'],   // Full content read under 500ms
    'read_range_duration': ['p(95)<150'],     // Range chunk read under 150ms
    'read_failures': ['rate<0.01'],           // < 1% errors
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:7030';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'perf-tenant';
const TARGET_FILE_ID = __ENV.TARGET_FILE_ID || '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001';

export default function () {
  const headers = {
    'x-tenant-id': TENANT_ID,
  };
  if (AUTH_TOKEN) {
    headers['authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  // 1. Read Metadata
  const metaRes = http.get(`${BASE_URL}/api/v1/files/${TARGET_FILE_ID}`, {
    headers,
    tags: { type: 'metadata' },
  });

  const metaOk = check(metaRes, {
    'metadata status is 200 or 404': (r) => r.status === 200 || r.status === 404,
  });
  metadataDuration.add(metaRes.timings.duration);
  readFailures.add(!metaOk);

  // 2. Read Full Content
  const contentRes = http.get(`${BASE_URL}/api/v1/files/${TARGET_FILE_ID}/content`, {
    headers,
    tags: { type: 'content' },
  });

  const contentOk = check(contentRes, {
    'content status is 200 or 404': (r) => r.status === 200 || r.status === 404,
  });
  contentDuration.add(contentRes.timings.duration);
  readFailures.add(!contentOk);

  // 3. Read Range Request (first 64 KiB)
  const rangeRes = http.get(`${BASE_URL}/api/v1/files/${TARGET_FILE_ID}/content`, {
    headers: {
      ...headers,
      'Range': 'bytes=0-65535',
    },
    tags: { type: 'range' },
  });

  const rangeOk = check(rangeRes, {
    'range status is 206 or 404': (r) => r.status === 206 || r.status === 404,
  });
  rangeReadDuration.add(rangeRes.timings.duration);
  readFailures.add(!rangeOk);

  sleep(0.5);
}
