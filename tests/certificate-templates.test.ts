import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES, fillTemplate, placeholdersIn } from '../src/modules/certificates/certificate-templates';
import { Certificate } from '../src/modules/certificates/files.model';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { auth, useTestApp } from './helpers';

const t = useTestApp();
let s: SchoolFixture;
let other: SchoolFixture;
const X = { crossTenant: true } as never;

const preview = (token: string, body: Record<string, unknown>) =>
  request(t.app).post('/api/v1/certificates/preview').set(auth(token)).send(body);

describe('Certificate templates (pure)', () => {
  it('every default uses only known fields and fills without leftover placeholders', () => {
    const values: Record<string, string> = {};
    for (const tpl of Object.values(DEFAULT_TEMPLATES))
      for (const k of placeholdersIn(tpl.title, tpl.body, ...tpl.details.map((d) => d.value))) values[k] = `<${k}>`;
    for (const tpl of Object.values(DEFAULT_TEMPLATES)) {
      const f = fillTemplate(tpl, values, {}, 'CERT-2026-00001');
      expect(f.missing).toEqual([]);
      expect(f.body).not.toMatch(/\{\{|\[/);
    }
  });

  it('never lets record fields be typed in', () => {
    expect(() => fillTemplate(DEFAULT_TEMPLATES.character, {}, { 'student.name': 'Someone Else' })).toThrow(
      /cannot be typed in/,
    );
  });
});

describe('Certificates from templates', () => {
  beforeAll(async () => {
    s = await buildSchool(t.app, { students: 2 });
    other = await buildSchool(t.app, { students: 1 });
  });

  it('fills a bonafide certificate from the records and reports what is missing', async () => {
    const res = await preview(s.ownerToken, { studentId: s.students[0], type: 'bonafide' });
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.body).toContain('Student0 Test');
    expect(p.body).toContain('son of Parent 0'); // gender male, primary guardian
    expect(p.body).toMatch(/Class|class/);
    // The fixture students have no date of birth: reported, never invented.
    expect(p.missing.map((m: any) => m.key)).toContain('student.dateOfBirth');
    expect(p.canIssue).toBe(false);
    expect(p.body).toContain('[Date of birth]');

    const refused = await request(t.app)
      .post('/api/v1/certificates')
      .set(auth(s.ownerToken))
      .send({ studentId: s.students[0], type: 'bonafide' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('CERTIFICATE_INCOMPLETE');
  });

  it('lets staff supply what the record lacks, previews the PDF, then issues it', async () => {
    const body = {
      studentId: s.students[0],
      type: 'bonafide',
      values: { 'student.dateOfBirth': '12 March 2015', 'student.rollNo': '7' },
    };
    const p = (await preview(s.ownerToken, body)).body.data;
    expect(p.canIssue).toBe(true);
    expect(p.fields.find((f: any) => f.key === 'student.dateOfBirth').source).toBe('entered');

    const pdf = await request(t.app).post('/api/v1/certificates/preview.pdf').set(auth(s.ownerToken)).send(body);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(await Certificate.countDocuments({ studentId: s.students[0] }).setOptions(X)).toBe(0); // preview stores nothing

    const cert = await api(t.app, s.ownerToken, 'post', '/certificates', body);
    expect(cert.type).toBe('bonafide');
    expect(cert.body).toContain('12 March 2015');
    expect(cert.details.find((d: any) => d.label === 'Admission No.').value).toBeTruthy();
  });

  it('refuses a fee clearance certificate while fees are outstanding', async () => {
    await api(t.app, s.ownerToken, 'post', '/fees/invoices/generate', {
      period: '2026-10',
      studentIds: [s.students[0]],
    });
    const res = await request(t.app)
      .post('/api/v1/certificates')
      .set(auth(s.ownerToken))
      .send({ studentId: s.students[0], type: 'fee_clearance' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FEES_OUTSTANDING');
    // A student with nothing outstanding gets one.
    const clear = await api(t.app, s.ownerToken, 'post', '/certificates', {
      studentId: s.students[1],
      type: 'fee_clearance',
    });
    expect(clear.body).toContain('no amount is outstanding');
  });

  it('warns that a leaving certificate is for a student who has left, and needs the leaving details', async () => {
    const p = (
      await preview(s.ownerToken, {
        studentId: s.students[1],
        type: 'leaving',
        values: { 'certificate.conduct': 'good' },
      })
    ).body.data;
    expect(p.warnings.join(' ')).toMatch(/not marked as left/);
    expect(p.missing.map((m: any) => m.key)).toEqual(expect.arrayContaining(['student.leavingDate']));
    expect(p.template.note).toMatch(/prescribe their own/);
  });

  it('saves a school’s own wording, keeps it to that school, and restores the default', async () => {
    const saved = await api(t.app, s.ownerToken, 'put', '/certificate-templates/character', {
      title: 'Character Certificate',
      body: 'Certified that {{student.name}} of {{school.name}} showed {{certificate.conduct}} conduct throughout.',
      details: [{ label: 'Admission No.', value: '{{student.admissionNo}}' }],
    });
    expect(saved.isModified).toBe(true);
    const mine = await api(t.app, s.ownerToken, 'get', '/certificate-templates');
    expect(mine.templates.find((x: any) => x.key === 'character').body).toContain('throughout');
    const theirs = await api(t.app, other.ownerToken, 'get', '/certificate-templates');
    expect(theirs.templates.find((x: any) => x.key === 'character').body).not.toContain('throughout');

    const unknown = await request(t.app)
      .put('/api/v1/certificate-templates/character')
      .set(auth(s.ownerToken))
      .send({ title: 'Character Certificate', body: 'Hello {{student.salary}} and welcome to school', details: [] });
    expect(unknown.status).toBe(400);

    const restored = await api(t.app, s.ownerToken, 'delete', '/certificate-templates/character');
    expect(restored.isModified).toBe(false);
    expect(restored.body).toBe(DEFAULT_TEMPLATES.character.body);
  });

  it('creates a custom template and issues from it', async () => {
    const tpl = await api(t.app, s.ownerToken, 'post', '/certificate-templates', {
      name: 'Hifz Completion',
      title: 'Certificate of Hifz-e-Quran',
      body: 'This is to certify that {{student.name}} of {{student.className}} has completed {{certificate.achievement}}.',
      details: [],
    });
    expect(tpl.key).toMatch(/^custom-/);
    const cert = await api(t.app, s.ownerToken, 'post', '/certificates', {
      studentId: s.students[1],
      type: 'custom',
      templateKey: tpl.key,
      values: { 'certificate.achievement': 'Hifz of the Holy Quran' },
    });
    expect(cert.type).toBe('custom');
    expect(cert.title).toBe('Certificate of Hifz-e-Quran');
    const otherSchool = await request(t.app)
      .post('/api/v1/certificates/preview')
      .set(auth(other.ownerToken))
      .send({ studentId: other.students[0], type: 'custom', templateKey: tpl.key });
    expect(otherSchool.status).toBe(404);
  });

  it('keeps students of another school out of previews, and families out of templates', async () => {
    const res = await preview(s.ownerToken, { studentId: other.students[0], type: 'bonafide' });
    expect(res.status).toBe(404);
    const fam = await request(t.app).get('/api/v1/certificate-templates').set(auth(s.parentToken));
    expect(fam.status).toBe(403);
  });
});
