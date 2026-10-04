import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// Custom Metrics
const uploadDuration1Mb = new Trend('upload_duration_1mb');
const uploadDuration5Mb = new Trend('upload_duration_5mb');
const uploadDuration20Mb = new Trend('upload_duration_20mb');
const uploadFailures = new Rate('upload_failures');
const uploadedBytes = new Counter('uploaded_bytes');

// Load target files into memory during init
const file1Mb = open('../fixtures/test-1mb.pdf', 'b');
const file5Mb = open('../fixtures/test-5mb.pdf', 'b');
const file20Mb = open('../fixtures/test-20mb.pdf', 'b');

export const options = {
  scenarios: {
    upload_ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },  // 10 concurrent users
        { duration: '1m',  target: 50 },  // 50 concurrent users
        { duration: '1m',  target: 100 }, // 100 concurrent users
        { duration: '30s', target: 0 },   // Ramp-down
      ],
    },
  },
  thresholds: {
    // ARCH §12 target: p95 fast-path latency for a 5 MiB file under 1.5 s
    'upload_duration_5mb': ['p(95)<1500'],
    'upload_duration_1mb': ['p(95)<800'],
    'upload_duration_20mb': ['p(95)<5000'],
    'upload_failures': ['rate<0.01'], // < 1% errors
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:7030';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'perf-tenant';
const NAMESPACE = __ENV.NAMESPACE || 'esma-tenant';

export default function () {
  // Rotate file sizes: 60% 1MB, 30% 5MB, 10% 20MB
  const rand = Math.random();
  let fileData;
  let fileName;
  let sizeTag;
  let metricTrend;
  let byteCount;

  if (rand < 0.6) {
    fileData = file1Mb;
    fileName = `perf-1mb-${__VU}-${__ITER}.pdf`;
    sizeTag = '1mb';
    metricTrend = uploadDuration1Mb;
    byteCount = 1048576;
  } else if (rand < 0.9) {
    fileData = file5Mb;
    fileName = `perf-5mb-${__VU}-${__ITER}.pdf`;
    sizeTag = '5mb';
    metricTrend = uploadDuration5Mb;
    byteCount = 5242880;
  } else {
    fileData = file20Mb;
    fileName = `perf-20mb-${__VU}-${__ITER}.pdf`;
    sizeTag = '20mb';
    metricTrend = uploadDuration20Mb;
    byteCount = 20971520;
  }

  const payload = {
    file: http.file(fileData, fileName, 'application/pdf'),
    namespace: NAMESPACE,
    isPublic: 'false',
  };

  const headers = {
    'x-tenant-id': TENANT_ID,
  };
  if (AUTH_TOKEN) {
    headers['authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  const res = http.post(`${BASE_URL}/api/v1/files/upload`, payload, {
    headers,
    tags: { size: sizeTag },
    timeout: '30s',
  });

  const success = check(res, {
    'status is 201': (r) => r.status === 201,
    'has fileId in response': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Boolean(body.id || (body.files && body.files[0]?.id));
      } catch {
        return false;
      }
    },
  });

  metricTrend.add(res.timings.duration);
  uploadFailures.add(!success);

  if (success) {
    uploadedBytes.add(byteCount);
  }

  sleep(1);
}
