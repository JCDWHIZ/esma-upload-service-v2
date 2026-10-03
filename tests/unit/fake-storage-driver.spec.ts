import { describe, it, expect, beforeEach } from 'vitest';
import { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('FakeStorageDriver', () => {
  let driver: FakeStorageDriver;

  beforeEach(() => {
    driver = new FakeStorageDriver('test-bucket');
  });

  it('stores and retrieves files using put and get', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const res = await driver.put('test/file.txt', content, {
      contentType: 'text/plain',
    });

    expect(res.key).toBe('test/file.txt');
    expect(res.size).toBe(content.length);
    expect(res.url).toContain('test-bucket.example.com/test/file.txt');

    const retrieved = await driver.get('test/file.txt');
    expect(retrieved.equals(content)).toBe(true);
    expect(driver.hasFile('test/file.txt')).toBe(true);
  });

  it('streams file content via openStream', async () => {
    const content = Buffer.from('streamed content', 'utf8');
    await driver.put('stream.txt', content);

    const stream = driver.openStream('stream.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(Buffer.from(chunk as unknown as Uint8Array));
      }
    }
    expect(Buffer.concat(chunks).equals(content)).toBe(true);
  });

  it('checks existence and deletes files', async () => {
    await driver.put('target.txt', Buffer.from('abc'));
    expect(await driver.exists('target.txt')).toBe(true);

    const deleted = await driver.delete('target.txt');
    expect(deleted).toBe(true);
    expect(await driver.exists('target.txt')).toBe(false);
  });

  it('supports failure injection via failNext() for exactly one call', async () => {
    await driver.put('ready.txt', Buffer.from('ok'));

    driver.failNext(new Error('Simulated S3 network failure'));

    // Next call must fail with the injected error
    await expect(driver.get('ready.txt')).rejects.toThrow(
      'Simulated S3 network failure',
    );

    // Call after that succeeds normally
    const normal = await driver.get('ready.txt');
    expect(normal.toString()).toBe('ok');
  });

  it('tracks operations in calls array', async () => {
    await driver.put('tracked.txt', Buffer.from('123'));
    await driver.exists('tracked.txt');
    await driver.delete('tracked.txt');

    const calls = driver.getCalls();
    expect(calls.length).toBe(3);
    expect(calls[0].method).toBe('put');
    expect(calls[1].method).toBe('exists');
    expect(calls[2].method).toBe('delete');
  });
});
