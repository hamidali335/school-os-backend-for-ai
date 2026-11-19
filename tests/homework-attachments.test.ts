import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { activateAndLogin, auth, PASSWORD, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Homework attachments reach parents (website and mobile): the homework says which files it has,
 * with name, type and size, and only the families of that section can download them.
 */
const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
let parentB: string; // parent of a student in section B
let hwId: string;
let fileId: string;
const PDF = Buffer.from('%PDF-1.4\n%worksheet\n%%EOF');

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 3 }); // 0,1 in section A; 2 in B
  other = await buildSchool(t.app, { students: 1 });
  parentB = await activateAndLogin(
    t.app,
    s.admissionAccounts[2].find((a: { role: string }) => a.role === 'parent'),
    PASSWORD,
    s.code,
  );
  const up = await request(t.app)
    .post('/api/v1/files')
    .set(auth(s.teacherToken))
    .field('category', 'homework')
    .attach('file', PDF, { filename: 'Fractions worksheet.pdf', contentType: 'application/pdf' });
  expect(up.status).toBe(201);
  fileId = up.body.data._id;
  const hw = await api(t.app, s.teacherToken, 'post', '/homework', {
    sectionId: s.sectionA,
    subjectId: s.mathId,
    title: 'Fractions',
    description: 'See the worksheet',
    dueDate: '2099-01-01',
    attachmentIds: [fileId],
  });
  hwId = hw._id;
});

describe('homework attachments', () => {
  it("the parent sees each attachment's name, type and size, never a storage path", async () => {
    const hw = await api(t.app, s.parentToken, 'get', `/homework/${hwId}`);
    expect(hw.attachments).toEqual([
      { _id: fileId, name: 'Fractions worksheet.pdf', mimeType: 'application/pdf', size: PDF.length },
    ]);
    expect(JSON.stringify(hw)).not.toMatch(/storageKey|sha256/);
  });

  it('the parent downloads the file with its name', async () => {
    const res = await request(t.app).get(`/api/v1/files/${fileId}/download`).set(auth(s.parentToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('Fractions');
    expect(Buffer.from(res.body).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it("another section's family and another school cannot see or download it", async () => {
    expect((await request(t.app).get(`/api/v1/homework/${hwId}`).set(auth(parentB))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/files/${fileId}/download`).set(auth(parentB))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/files/${fileId}/download`).set(auth(other.parentToken))).status).toBe(
      404,
    );
  });

  it('staff see the same list; homework without files has an empty list', async () => {
    expect((await api(t.app, s.teacherToken, 'get', `/homework/${hwId}`)).attachments).toHaveLength(1);
    const plain = await api(t.app, s.teacherToken, 'post', '/homework', {
      sectionId: s.sectionA,
      subjectId: s.mathId,
      title: 'Reading',
      description: 'Chapter 3',
      dueDate: '2099-01-02',
    });
    expect((await api(t.app, s.parentToken, 'get', `/homework/${plain._id}`)).attachments).toEqual([]);
  });
});
