import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createReferenceApp } from './helpers/reference-app.factory.js';
import { assertContractFixture } from './helpers/fixture-manager.js';
import { tokens } from '../helpers/tokens.js';
import { makeFile } from '../helpers/make-file.js';
import type { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('Admin Contract Reference Suite (/api/admin/upload/*)', () => {
  let app: INestApplication;
  let storage: FakeStorageDriver;
  const server = () =>
    app.getHttpServer() as unknown as Parameters<typeof request>[0];

  beforeAll(async () => {
    const res = await createReferenceApp();
    app = res.app;
    storage = res.storage;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    storage.reset();
  });

  describe('Route 7: POST /api/admin/upload/single', () => {
    it('succeeds with valid admin token and file', async () => {
      const token = await tokens.admin();
      const file = makeFile('png');

      const res = await request(server())
        .post('/api/admin/upload/single?folder=banners')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('admin.single.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects unauthenticated request (corrected defect F-40)', async () => {
      const file = makeFile('png');

      const res = await request(server())
        .post('/api/admin/upload/single?folder=banners')
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('admin.single.missing-auth', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects non-admin role with 403 Forbidden', async () => {
      const token = await tokens.school({
        roles: ['school_admin'], // Not superadmin or admin
      });
      const file = makeFile('png');

      const res = await request(server())
        .post('/api/admin/upload/single?folder=banners')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('admin.single.unauthorized-role', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects fake executable file (magic byte verification F-51)', async () => {
      const token = await tokens.admin();
      const fakeFile = makeFile('fake-executable');

      const res = await request(server())
        .post('/api/admin/upload/single?folder=banners')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', fakeFile.buffer, fakeFile.filename);

      await assertContractFixture('admin.single.fake-executable', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 8: POST /api/admin/upload/multiple', () => {
    it('succeeds uploading multiple admin files', async () => {
      const token = await tokens.admin();
      const file1 = makeFile('png');
      const file2 = makeFile('jpeg');

      const res = await request(server())
        .post('/api/admin/upload/multiple?folder=gallery')
        .set('Authorization', `Bearer ${token}`)
        .attach('files', file1.buffer, file1.filename)
        .attach('files', file2.buffer, file2.filename);

      await assertContractFixture('admin.multiple.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 9: POST /api/admin/upload/fields', () => {
    it('succeeds uploading across profile_image, gallery_images, documents', async () => {
      const token = await tokens.admin();
      const img1 = makeFile('png');
      const img2 = makeFile('jpeg');
      const doc = makeFile('pdf');

      const res = await request(server())
        .post('/api/admin/upload/fields?folder=events')
        .set('Authorization', `Bearer ${token}`)
        .attach('profile_image', img1.buffer, img1.filename)
        .attach('gallery_images', img2.buffer, img2.filename)
        .attach('documents', doc.buffer, doc.filename);

      await assertContractFixture('admin.fields.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 10: GET /api/admin/upload/files', () => {
    it('retrieves paginated list of admin files', async () => {
      const token = await tokens.admin();

      const res = await request(server())
        .get('/api/admin/upload/files?folder=banners&limit=50')
        .set('Authorization', `Bearer ${token}`);

      await assertContractFixture('admin.list.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 11: GET /api/admin/upload/file/:publicId', () => {
    it('inspects details of an existing admin file', async () => {
      const token = await tokens.admin();
      const key = 'admin/banners/sample.png';
      await storage.put(key, Buffer.from('test'));

      const res = await request(server())
        .get(`/api/admin/upload/file/${encodeURIComponent(key)}`)
        .set('Authorization', `Bearer ${token}`);

      await assertContractFixture('admin.get-file.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 12: DELETE /api/admin/upload/file/:publicId', () => {
    it('deletes a single admin file', async () => {
      const token = await tokens.admin();
      const key = 'admin/banners/to-delete.png';
      await storage.put(key, Buffer.from('test'));

      const res = await request(server())
        .delete(`/api/admin/upload/file/${encodeURIComponent(key)}`)
        .set('Authorization', `Bearer ${token}`);

      await assertContractFixture('admin.delete-single.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 13: DELETE /api/admin/upload/files', () => {
    it('performs bounded bulk delete', async () => {
      const token = await tokens.admin();
      const keys = ['admin/banners/del1.png', 'admin/banners/del2.png'];
      for (const k of keys) {
        await storage.put(k, Buffer.from('test'));
      }

      const res = await request(server())
        .delete('/api/admin/upload/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ publicIds: keys });

      await assertContractFixture('admin.bulk-delete.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects unbounded bulk delete exceeding 100 items (corrected defect F-45)', async () => {
      const token = await tokens.admin();
      // Generate 101 keys to exceed bound
      const oversizeKeys = Array.from(
        { length: 101 },
        (_, i) => `admin/bulk/file_${i}.png`,
      );

      const res = await request(server())
        .delete('/api/admin/upload/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ publicIds: oversizeKeys });

      await assertContractFixture('admin.bulk-delete.oversize-array', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });
});
