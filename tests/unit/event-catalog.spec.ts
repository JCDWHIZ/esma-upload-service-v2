import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES,
  EVENT_CATALOG,
  parseEventPayload,
  parseEventEnvelope,
  createEnvelope,
  TopicMap,
  defaultTopicMap,
  type EventType,
} from '../../src/events/index.js';
import { PermanentError } from '../../src/core/errors/app-error.js';
import type { RequestContext } from '../../src/auth/context.js';

describe('Event Catalog & Envelope Unit Tests (P4-03)', () => {
  const mockContext: RequestContext = {
    correlationId: 'corr-xyz-123',
    namespace: 'schools',
    tenantId: 'tenant-abc',
    ipAddress: '127.0.0.1',
    attributes: {},
    actor: {
      type: 'user',
      id: 'actor-test-1',
      roles: ['admin'],
      scopes: ['files:read', 'files:write'],
    },
  };

  describe('Envelope Creation & Parsing', () => {
    it('creates a standard envelope with UUIDv7, attempt=0, schemaVersion=1', () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_REPLICATE,
        partitionKey: 'file-001',
        payload: { fileId: 'file-001', targetProvider: 'seaweedfs' },
        context: mockContext,
      });

      expect(envelope.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(envelope.eventType).toBe(EVENT_TYPES.FILE_REPLICATE);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.attempt).toBe(0);
      expect(envelope.partitionKey).toBe('file-001');
      expect(envelope.correlationId).toBe(mockContext.correlationId);
      expect(envelope.namespace).toBe(mockContext.namespace);
      expect(envelope.tenantId).toBe(mockContext.tenantId);
      expect(envelope.payload).toEqual({
        fileId: 'file-001',
        targetProvider: 'seaweedfs',
      });
      expect(new Date(envelope.timestamp).getTime()).toBeGreaterThan(0);
    });

    it('creates envelope with explicit overrides and without context', () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'file-002',
        payload: { fileId: 'file-002' },
        correlationId: 'custom-corr',
        namespace: 'custom-ns',
        tenantId: 'custom-t',
        causationId: 'cause-123',
      });

      expect(envelope.correlationId).toBe('custom-corr');
      expect(envelope.namespace).toBe('custom-ns');
      expect(envelope.tenantId).toBe('custom-t');
      expect(envelope.causationId).toBe('cause-123');
    });

    it('parses a valid envelope successfully', () => {
      const envelope = createEnvelope({
        eventType: EVENT_TYPES.FILE_PURGE,
        partitionKey: 'file-003',
        payload: { fileId: 'file-003' },
        context: mockContext,
      });

      const parsed = parseEventEnvelope(envelope);
      expect(parsed.eventId).toBe(envelope.eventId);
      expect(parsed.payload).toEqual({ fileId: 'file-003' });
    });

    it('rejects unsupported schema version with PermanentError', () => {
      const raw = {
        eventId: '018b1234-5678-7abc-def0-123456789abc',
        eventType: EVENT_TYPES.FILE_PURGE,
        schemaVersion: 99,
        timestamp: new Date().toISOString(),
        correlationId: 'c1',
        namespace: 'default',
        tenantId: 'default',
        partitionKey: 'f1',
        attempt: 0,
        payload: { fileId: 'f1' },
      };

      expect(() => parseEventEnvelope(raw)).toThrow(PermanentError);
      expect(() => parseEventEnvelope(raw)).toThrow(
        /Unsupported schema version/,
      );
    });

    it('rejects corrupt envelope structure with PermanentError', () => {
      expect(() => parseEventEnvelope(null)).toThrow(PermanentError);
      expect(() => parseEventEnvelope({})).toThrow(PermanentError);
      expect(() =>
        parseEventEnvelope({
          eventId: 'not-enough-fields',
        }),
      ).toThrow(PermanentError);
    });

    it('rejects unknown event type in envelope with PermanentError', () => {
      const raw = {
        eventId: '018b1234-5678-7abc-def0-123456789abc',
        eventType: 'file.unrecognized_type',
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        correlationId: 'c1',
        namespace: 'default',
        tenantId: 'default',
        partitionKey: 'f1',
        attempt: 0,
        payload: { fileId: 'f1' },
      };

      expect(() => parseEventEnvelope(raw)).toThrow(PermanentError);
    });
  });

  describe('Event Catalog Schemas (Valid & Invalid Fixtures)', () => {
    const testCases: Array<{
      type: EventType;
      validPayload: Record<string, unknown>;
      invalidPayloads: Array<Record<string, unknown>>;
    }> = [
      {
        type: EVENT_TYPES.FILE_REPLICATE,
        validPayload: { fileId: 'f-1', targetProvider: 'seaweedfs' },
        invalidPayloads: [
          {},
          { fileId: 'f-1' }, // missing targetProvider
          { targetProvider: 'seaweedfs' }, // missing fileId
          { fileId: '', targetProvider: 'seaweedfs' }, // empty string
          { fileId: 'f-1', targetProvider: 123 }, // invalid type
        ],
      },
      {
        type: EVENT_TYPES.FILE_PURGE,
        validPayload: { fileId: 'f-1' },
        invalidPayloads: [{}, { fileId: '' }, { fileId: 123 }],
      },
      {
        type: EVENT_TYPES.FILE_SCAN,
        validPayload: { fileId: 'f-1' },
        invalidPayloads: [{}, { fileId: '' }],
      },
      {
        type: EVENT_TYPES.FILE_PROCESS,
        validPayload: { fileId: 'f-1', operations: ['thumbnail', 'webp'] },
        invalidPayloads: [
          {},
          { fileId: 'f-1' }, // missing operations
          { fileId: 'f-1', operations: [] }, // empty operations
          { fileId: 'f-1', operations: [123] }, // invalid array items
        ],
      },
      {
        type: EVENT_TYPES.FILE_UPLOADED,
        validPayload: {
          fileId: 'f-1',
          size: 1024,
          mimetype: 'application/pdf',
          primaryProvider: 'local',
        },
        invalidPayloads: [
          {},
          {
            fileId: 'f-1',
            size: -1,
            mimetype: 'application/pdf',
            primaryProvider: 'local',
          }, // negative size
          {
            fileId: 'f-1',
            size: '1024',
            mimetype: 'application/pdf',
            primaryProvider: 'local',
          }, // size as string
          { fileId: 'f-1', size: 1024, mimetype: '', primaryProvider: 'local' }, // empty mimetype
          { fileId: 'f-1', size: 1024, mimetype: 'application/pdf' }, // missing primaryProvider
        ],
      },
      {
        type: EVENT_TYPES.FILE_REPLICATED,
        validPayload: { fileId: 'f-1', provider: 'seaweedfs' },
        invalidPayloads: [
          {},
          { fileId: 'f-1' }, // missing provider
          { provider: 'seaweedfs' }, // missing fileId
        ],
      },
      {
        type: EVENT_TYPES.FILE_REPLICATION_FAILED,
        validPayload: {
          fileId: 'f-1',
          provider: 'seaweedfs',
          error: 'Connection refused',
        },
        invalidPayloads: [
          {},
          { fileId: 'f-1', provider: 'seaweedfs' }, // missing error
          { fileId: 'f-1', error: 'Err' }, // missing provider
        ],
      },
      {
        type: EVENT_TYPES.FILE_DELETED,
        validPayload: { fileId: 'f-1' },
        invalidPayloads: [{}, { fileId: '' }],
      },
      {
        type: EVENT_TYPES.FILE_SCANNED,
        validPayload: { fileId: 'f-1', result: 'clean' },
        invalidPayloads: [
          {},
          { fileId: 'f-1' }, // missing result
          { fileId: 'f-1', result: '' },
        ],
      },
      {
        type: EVENT_TYPES.FILE_PROCESSED,
        validPayload: {
          fileId: 'f-1',
          derivatives: [{ width: 200, height: 200, key: 'thumb.jpg' }],
        },
        invalidPayloads: [
          {},
          { fileId: 'f-1' }, // missing derivatives
          { fileId: 'f-1', derivatives: 'not-array' }, // invalid derivatives
        ],
      },
    ];

    it('verifies all 10 catalog event types have metadata defined', () => {
      expect(Object.keys(EVENT_CATALOG).length).toBe(10);
      for (const tc of testCases) {
        const meta = EVENT_CATALOG[tc.type];
        expect(meta).toBeDefined();
        expect(meta.type).toBe(tc.type);
        expect(['command', 'event']).toContain(meta.kind);
        expect(['replication', 'processing', 'audit', 'dlq']).toContain(
          meta.defaultTopic,
        );
      }
    });

    for (const { type, validPayload, invalidPayloads } of testCases) {
      it(`validates schema for "${type}": accepts valid fixture`, () => {
        const parsed = parseEventPayload(type, validPayload);
        expect(parsed).toEqual(validPayload);
      });

      for (let i = 0; i < invalidPayloads.length; i++) {
        it(`validates schema for "${type}": rejects invalid fixture #${i + 1}`, () => {
          expect(() => parseEventPayload(type, invalidPayloads[i])).toThrow(
            PermanentError,
          );
        });
      }
    }
  });

  describe('TopicMap (ARCH §8.3)', () => {
    it('maps all logical topics to physical Kafka names and retry tiers', () => {
      const topicMap = defaultTopicMap;

      expect(topicMap.toKafka('replication')).toBe('esma.files.replication');
      expect(topicMap.toKafka('processing')).toBe('esma.files.processing');
      expect(topicMap.toKafka('audit')).toBe('esma.files.audit');
      expect(topicMap.toKafka('dlq')).toBe('esma.files.dlq');

      expect(topicMap.toKafkaRetry('replication', '10s')).toBe(
        'esma.files.replication.retry.10s',
      );
      expect(topicMap.toKafkaRetry('replication', '1m')).toBe(
        'esma.files.replication.retry.1m',
      );
      expect(topicMap.toKafkaRetry('replication', '10m')).toBe(
        'esma.files.replication.retry.10m',
      );
    });

    it('maps all logical topics to physical Pulsar names', () => {
      const topicMap = defaultTopicMap;

      expect(topicMap.toPulsar('replication')).toBe(
        'persistent://esma/uploads/replication',
      );
      expect(topicMap.toPulsar('processing')).toBe(
        'persistent://esma/uploads/processing',
      );
      expect(topicMap.toPulsar('audit')).toBe(
        'persistent://esma/uploads/audit',
      );
      expect(topicMap.toPulsar('dlq')).toBe('persistent://esma/uploads/dlq');
    });

    it('resolves reverse mappings from physical names to logical topics', () => {
      const topicMap = defaultTopicMap;

      expect(topicMap.fromKafka('esma.files.replication')).toBe('replication');
      expect(topicMap.fromKafka('esma.files.processing')).toBe('processing');
      expect(topicMap.fromKafka('esma.files.audit')).toBe('audit');
      expect(topicMap.fromKafka('esma.files.dlq')).toBe('dlq');
      expect(topicMap.fromKafka('other.prefix.replication')).toBeUndefined();

      expect(topicMap.fromPulsar('persistent://esma/uploads/replication')).toBe(
        'replication',
      );
      expect(topicMap.fromPulsar('persistent://esma/uploads/audit')).toBe(
        'audit',
      );
      expect(
        topicMap.fromPulsar('persistent://unknown/unknown/audit'),
      ).toBeUndefined();
    });

    it('supports custom topic map options', () => {
      const customMap = new TopicMap({
        kafkaPrefix: 'org.custom',
        pulsarTenant: 'acme',
        pulsarNamespace: 'files',
      });

      expect(customMap.toKafka('replication')).toBe('org.custom.replication');
      expect(customMap.toPulsar('replication')).toBe(
        'persistent://acme/files/replication',
      );
      expect(customMap.fromKafka('org.custom.audit')).toBe('audit');
      expect(customMap.fromPulsar('persistent://acme/files/dlq')).toBe('dlq');
    });
  });
});
