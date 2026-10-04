import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const pageLatency = new Trend('pagination_page_duration');
const deepPageLatency = new Trend('pagination_deep_page_duration');
const pageFailures = new Rate('pagination_failures');

export const options = {
  scenarios: {
    pagination_load: {
      executor: 'constant-vus',
      vus: 100, // 100 concurrent users
      duration: '2m',
    },
  },
  thresholds: {
    // Keyset pagination indexed by id should remain sub-250ms even under 100 concurrent users
    'pagination_page_duration': ['p(95)<250'],
    'pagination_deep_page_duration': ['p(95)<300'],
    'pagination_failures': ['rate<0.01'],
  },
};

const BASE_URL = __ENV.API_BASE_URL || 'http://localhost:7030';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';
const TENANT_ID = __ENV.TENANT_ID || 'perf-tenant';
const NAMESPACE = __ENV.NAMESPACE || 'esma-tenant';

export default function () {
  const headers = {
    'x-tenant-id': TENANT_ID,
  };
  if (AUTH_TOKEN) {
    headers['authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  // 1. Initial page
  let cursor = null;
  const initialRes = http.get(
    `${BASE_URL}/api/v1/files?namespace=${NAMESPACE}&limit=20`,
    { headers, tags: { depth: 'first_page' } },
  );

  const initialOk = check(initialRes, {
    'first page status is 200': (r) => r.status === 200,
    'has valid payload structure': (r) => {
      try {
        const body = JSON.parse(r.body);
        cursor = body.nextCursor || null;
        return Array.isArray(body.items || body.files || body.data);
      } catch {
        return false;
      }
    },
  });

  pageLatency.add(initialRes.timings.duration);
  pageFailures.add(!initialOk);

  // 2. Keyset cursor traversal (simulating deep paging through keyset cursor)
  if (cursor) {
    const nextRes = http.get(
      `${BASE_URL}/api/v1/files?namespace=${NAMESPACE}&limit=20&cursor=${encodeURIComponent(cursor)}`,
      { headers, tags: { depth: 'cursor_page' } },
    );

    const nextOk = check(nextRes, {
      'next page status is 200': (r) => r.status === 200,
    });

    deepPageLatency.add(nextRes.timings.duration);
    pageFailures.add(!nextOk);
  }

  sleep(0.2);
}
