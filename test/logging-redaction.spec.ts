import pino from 'pino';

interface TestLogReq {
  id?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface TestLogOutput {
  level?: number;
  time?: number;
  correlationId?: string;
  req?: TestLogReq;
  config?: {
    jwtSecret?: string;
    nested?: {
      token?: string;
      password?: string;
    };
  };
  user?: string;
}

describe('Logging & Redaction', () => {
  let logs: string[] = [];

  const testDestination = {
    write: (msg: string) => {
      logs.push(msg);
    },
  };

  const logger = pino(
    {
      level: 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers.cookie',
          'req.headers["set-cookie"]',
          '*.secret',
          '*.token',
          '*.password',
          '*.key',
          '*.apiKey',
          '*.jwtSecret',
          '*.signedUrlSecret',
          '*.*.secret',
          '*.*.token',
          '*.*.password',
          '*.*.key',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req: (rawReq: unknown) => {
          const req = rawReq as TestLogReq;
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            headers: req.headers,
            // no body
          };
        },
      },
    },
    testDestination,
  );

  beforeEach(() => {
    logs = [];
  });

  it('should redact authorization headers and api keys from request logs', () => {
    const rawSecretToken = 'super-secret-jwt-token-xyz-12345';
    const rawApiKey = 'gus_secret_api_key_99999';

    logger.info({
      correlationId: 'corr-test-redact-1',
      req: {
        id: 'corr-test-redact-1',
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: {
          authorization: `Bearer ${rawSecretToken}`,
          'x-api-key': rawApiKey,
          host: 'localhost:7030',
        },
      },
    });

    expect(logs.length).toBe(1);
    const logOutput = logs[0];
    const parsed = JSON.parse(logOutput) as TestLogOutput;

    // Assert secret is NEVER present
    expect(logOutput).not.toContain(rawSecretToken);
    expect(logOutput).not.toContain(rawApiKey);

    // Assert redacted placeholder is present
    expect(parsed.req?.headers?.authorization).toBe('[REDACTED]');
    expect(parsed.req?.headers?.['x-api-key']).toBe('[REDACTED]');
    expect(parsed.req?.headers?.host).toBe('localhost:7030');
    expect(parsed.correlationId).toBe('corr-test-redact-1');
  });

  it('should redact secret, token, and password fields at any depth', () => {
    const secretValue = 'top-secret-signing-key-value';
    const passwordValue = 'super-secret-db-password';

    logger.info({
      correlationId: 'corr-test-redact-2',
      config: {
        jwtSecret: secretValue,
        nested: {
          token: secretValue,
          password: passwordValue,
        },
      },
      user: 'admin',
    });

    const logOutput = logs[0];
    expect(logOutput).not.toContain(secretValue);
    expect(logOutput).not.toContain(passwordValue);

    const parsed = JSON.parse(logOutput) as TestLogOutput;
    expect(parsed.config?.jwtSecret).toBe('[REDACTED]');
    expect(parsed.config?.nested?.token).toBe('[REDACTED]');
    expect(parsed.config?.nested?.password).toBe('[REDACTED]');
    expect(parsed.user).toBe('admin');
  });

  it('should ensure no request body is serialized', () => {
    logger.info({
      correlationId: 'corr-test-redact-3',
      req: {
        method: 'POST',
        url: '/api/v1/files/upload',
        headers: { host: 'localhost:7030' },
        body: { sensitiveFileContents: 'do-not-log-this' },
      },
    });

    const parsed = JSON.parse(logs[0]) as TestLogOutput;
    expect(parsed.req).not.toHaveProperty('body');
    expect(logs[0]).not.toContain('do-not-log-this');
  });
});
