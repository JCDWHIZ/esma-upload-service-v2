import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createReferenceApp } from './helpers/reference-app.factory.js';
import { assertContractFixture } from './helpers/fixture-manager.js';
import { tokens } from '../helpers/tokens.js';
import { makeFile } from '../helpers/make-file.js';
import type { FakeStorageDriver } from '../helpers/storage-driver.mock.js';

describe('Tenant Contract Reference Suite (/api/tenant/upload/*)', () => {
  let app: INestApplication;
  let storage: FakeStorageDriver;

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

  describe('Route 1: POST /api/tenant/upload/single', () => {
    it('succeeds with valid file and matching school/branch token and headers', async () => {
      const token = await tokens.branch({
        schoolId: 'sch-01',
        branchId: 'br-01',
        roles: ['school_admin'],
      });
      const file = makeFile('png');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .set('x-branch-id', 'br-01')
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('tenant.single.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects unauthenticated request (missing token)', async () => {
      const file = makeFile('png');
      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('x-school-id', 'sch-01')
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('tenant.single.missing-auth', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects mismatched x-school-id header', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });
      const file = makeFile('png');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'different-school')
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('tenant.single.mismatched-school', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects fake executable disguised as pdf (magic byte detection F-51)', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });
      const fakeFile = makeFile('fake-executable');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .attach('file', fakeFile.buffer, fakeFile.filename);

      await assertContractFixture('tenant.single.fake-executable', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects request with missing file', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01');

      await assertContractFixture('tenant.single.no-file', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('handles storage provider failure gracefully', async () => {
      storage.failNext(new Error('Storage disk failure'));
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });
      const file = makeFile('png');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/single')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .attach('file', file.buffer, file.filename);

      await assertContractFixture('tenant.single.storage-failure', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 2: POST /api/tenant/upload/multiple', () => {
    it('succeeds uploading multiple files', async () => {
      const token = await tokens.branch({
        schoolId: 'sch-01',
        branchId: 'br-01',
        roles: ['school_admin'],
      });
      const file1 = makeFile('png');
      const file2 = makeFile('jpeg');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/multiple')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .set('x-branch-id', 'br-01')
        .attach('files', file1.buffer, file1.filename)
        .attach('files', file2.buffer, file2.filename);

      await assertContractFixture('tenant.multiple.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 3: POST /api/tenant/upload/multiple-fields', () => {
    it('succeeds uploading files across avatar, gallery, documents', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });
      const avatar = makeFile('png');
      const gallery = makeFile('jpeg');
      const doc = makeFile('pdf');

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/multiple-fields')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .attach('avatar', avatar.buffer, avatar.filename)
        .attach('gallery', gallery.buffer, gallery.filename)
        .attach('documents', doc.buffer, doc.filename);

      await assertContractFixture('tenant.multiple-fields.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects when no fields are attached', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });

      const res = await request(app.getHttpServer())
        .post('/api/tenant/upload/multiple-fields')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01');

      await assertContractFixture('tenant.multiple-fields.no-file', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 4: GET /api/tenant/upload/files/:schoolId', () => {
    it('retrieves files for school', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });

      const res = await request(app.getHttpServer())
        .get('/api/tenant/upload/files/sch-01')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01');

      await assertContractFixture('tenant.list-school.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('rejects unauthorized school cross-tenant request', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });

      const res = await request(app.getHttpServer())
        .get('/api/tenant/upload/files/sch-02')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01');

      await assertContractFixture('tenant.list-school.mismatched-school', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 5: GET /api/tenant/upload/files/:schoolId/:branchId', () => {
    it('retrieves files for branch', async () => {
      const token = await tokens.branch({
        schoolId: 'sch-01',
        branchId: 'br-01',
        roles: ['school_admin'],
      });

      const res = await request(app.getHttpServer())
        .get('/api/tenant/upload/files/sch-01/br-01')
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01')
        .set('x-branch-id', 'br-01');

      await assertContractFixture('tenant.list-branch.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });
  });

  describe('Route 6: DELETE /api/tenant/upload/files/:publicId', () => {
    it('successfully deletes a tenant file matching scope', async () => {
      const token = await tokens.school({
        schoolId: 'sch-01',
        roles: ['school_admin'],
      });
      const fileKey = 'uploads/schools/sch-01/sample.png';
      await storage.put(fileKey, Buffer.from('test'));

      const res = await request(app.getHttpServer())
        .delete(`/api/tenant/upload/files/${encodeURIComponent(fileKey)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-01');

      await assertContractFixture('tenant.delete.success', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });
    });

    it('enforces strict prefix isolation preventing cross-tenant deletion (F-42)', async () => {
      const token = await tokens.school({
        schoolId: 'sch-1',
        roles: ['school_admin'],
      });
      // SCH_1 attempting to delete file belonging to SCH_10
      const targetFileKey = 'uploads/schools/sch-10/target.png';
      await storage.put(targetFileKey, Buffer.from('test'));

      const res = await request(app.getHttpServer())
        .delete(`/api/tenant/upload/files/${encodeURIComponent(targetFileKey)}`)
        .set('Authorization', `Bearer ${token}`)
        .set('x-school-id', 'sch-1');

      await assertContractFixture('tenant.delete.cross-tenant-isolation', {
        status: res.status,
        headers: res.headers,
        body: res.body,
      });

      // Confirm file in sch-10 was NOT deleted
      expect(await storage.exists(targetFileKey)).toBe(true);
    });
  });
});
