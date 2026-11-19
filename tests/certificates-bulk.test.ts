import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Certificate, FileObject } from '../src/modules/certificates/files.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
const X = { crossTenant: true } as never;

describe('Certificates: whole class, chosen students, and deleting revoked ones', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 4 });
    other = await buildSchool(t.app, { students: 1 });
  });

  it('issues one certificate per active student of a section, each with its own wording', async () => {
    const r = await api(t.app, s.ownerToken, 'post', '/certificates/bulk', {
      type: 'merit',
      sectionId: s.sectionA,
      body: 'Awarded to {name} of {class} (Adm. {admissionNo}) for excellent results.',
    });
    expect(r.issued.length).toBeGreaterThan(0);
    expect(r.skipped).toEqual([]);
    const serials = new Set(r.issued.map((i: { serialNo: string }) => i.serialNo));
    expect(serials.size).toBe(r.issued.length);
    const first = await Certificate.findById(r.issued[0].certificateId).setOptions(X).lean();
    expect(first?.body).toContain(r.issued[0].studentName);
    expect(first?.body).not.toContain('{name}');

    // Running it again issues nothing new: everyone already holds this certificate.
    const again = await api(t.app, s.ownerToken, 'post', '/certificates/bulk', {
      type: 'merit',
      sectionId: s.sectionA,
    });
    expect(again.issued).toEqual([]);
    expect(again.skipped.length).toBe(r.issued.length);
  });

  it('issues to chosen students only, and never to another school', async () => {
    const r = await api(t.app, s.ownerToken, 'post', '/certificates/bulk', {
      type: 'sports',
      studentIds: [s.students[0]],
      values: { 'certificate.achievement': 'winning the 100 m race' },
    });
    expect(r.issued.map((i: { studentId: string }) => i.studentId)).toEqual([s.students[0]]);

    const foreign = await request(t.app)
      .post('/api/v1/certificates/bulk')
      .set(auth(s.ownerToken))
      .send({ type: 'sports', studentIds: [other.students[0]] });
    expect(foreign.status).toBe(400);
  });

  it('requires exactly one target', async () => {
    const none = await request(t.app).post('/api/v1/certificates/bulk').set(auth(s.ownerToken)).send({ type: 'merit' });
    expect(none.status).toBe(400);
    const two = await request(t.app)
      .post('/api/v1/certificates/bulk')
      .set(auth(s.ownerToken))
      .send({ type: 'merit', sectionId: s.sectionA, classId: s.classId });
    expect(two.status).toBe(400);
  });

  it('deletes only revoked certificates, with their PDF', async () => {
    const cert = await api(t.app, s.ownerToken, 'post', '/certificates', {
      studentId: s.students[1],
      type: 'character',
      values: { 'certificate.conduct': 'good' },
    });
    const early = await request(t.app).delete(`/api/v1/certificates/${cert._id}`).set(auth(s.ownerToken));
    expect(early.status).toBe(409);

    await api(t.app, s.ownerToken, 'post', `/certificates/${cert._id}/revoke`, { reason: 'Issued by mistake' });
    const asParent = await request(t.app).delete(`/api/v1/certificates/${cert._id}`).set(auth(s.parentToken));
    expect(asParent.status).toBe(403);
    const fromOther = await request(t.app).delete(`/api/v1/certificates/${cert._id}`).set(auth(other.ownerToken));
    expect(fromOther.status).toBe(404);

    await api(t.app, s.ownerToken, 'delete', `/certificates/${cert._id}`);
    expect(await Certificate.countDocuments({ _id: cert._id }).setOptions(X)).toBe(0);
    expect(await FileObject.countDocuments({ _id: cert.fileId }).setOptions(X)).toBe(0);
  });
});
