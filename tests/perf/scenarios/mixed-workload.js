import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const mixedLatency = new Trend('mixed_workload_duration');
const uploadLatency = new Trend('mixed_upload_duration');
const readLatency = new Trend('mixed_read_duration');
const mixedErrors = new Rate('mixed_errors');

const file1Mb = open('../fixtures/test-1mb.pdf', 'b');
const file5Mb = open('../fixtures/test-5mb.pdf', 'b');

export const options = {
  scenarios: {
    mixed_ramp: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 50 },
        { duration: '1m',  target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    'mixed_workload_duration': ['p(95)<1200'],
    'mixed_upload_duration': ['p(95)<1500'],
    'mixed_read_duration': ['p(95)<300'],
    'mixed_errors': ['rate<0.01'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:7030';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'perf-tenant';
const NAMESPACE = __ENV.NAMESPACE || 'esma-tenant';
const TARGET_FILE_ID = __ENV.TARGET_FILE_ID || '0198f3a2-7c1e-7b40-9d2a-5e6f1a8c0001';

export default function () {
  const headers = {
    'x-tenant-id': TENANT_ID,
  };
  if (AUTH_TOKEN) {
    headers['authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  const roll = Math.random();

  if (roll < 0.7) {
    // 70% Read operations (metadata or content)
    const readType = Math.random() < 0.5 ? 'metadata' : 'content';
    const url =
      readType === 'metadata'
        ? `${BASE_URL}/api/v1/files/${TARGET_FILE_ID}`
        : `${BASE_URL}/api/v1/files/${TARGET_FILE_ID}/content`;

    const res = http.get(url, { headers, tags: { type: readType } });
    const ok = check(res, {
      'read request completed': (r) => r.status === 200 || r.status === 404,
    });

    readLatency.add(res.timings.duration);
    mixedLatency.add(res.timings.duration);
    mixedErrors.add(!ok);
  } else {
    // 30% Upload operations (1MB or 5MB)
    const isFiveMb = Math.random() < 0.4;
    const fileData = isFiveMb ? file5Mb : file1Mb;
    const fileName = `mixed-${isFiveMb ? '5mb' : '1mb'}-${__VU}-${__ITER}.pdf`;

    const payload = {
      file: http.file(fileData, fileName, 'application/pdf'),
      namespace: NAMESPACE,
      isPublic: 'false',
    };

    const res = http.post(`${BASE_URL}/api/v1/files/upload`, payload, {
      headers,
      tags: { type: 'upload' },
      timeout: '30s',
    });

    const ok = check(res, {
      'upload succeeded': (r) => r.status === 201,
    });

    uploadLatency.add(res.timings.duration);
    mixedLatency.add(res.timings.duration);
    mixedErrors.add(!ok);
  }

  sleep(0.5);
}
