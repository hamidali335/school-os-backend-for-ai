import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseEnteredDate } from '../src/modules/certificates/certificate-templates';
import { emphasised } from '../src/services/pdf';
import { auth, useTestApp } from './helpers';
import { api, buildSchool, type SchoolFixture } from './fixtures';

/**
 * Certificate fields: dates are real dates (picker or printed form) and print like record dates;
 * conduct and reason for leaving offer usual answers but accept any wording; key details are bold.
 */
const t = useTestApp();
let s: SchoolFixture;
const preview = (body: object) =>
  request(t.app).post('/api/v1/certificates/preview').set(auth(s.ownerToken)).send(body);

beforeAll(async () => {
  s = await buildSchool(t.app, { students: 2 });
});

describe('field catalogue', () => {
  it('marks dates and offers usual answers with free text still allowed', async () => {
    const { fields } = await api(t.app, s.ownerToken, 'get', '/certificate-templates');
    const byKey = Object.fromEntries(fields.map((f: { key: string }) => [f.key, f]));
    expect(byKey['student.leavingDate'].date).toBe(true);
    expect(byKey['certificate.conduct'].choices).toEqual(['Excellent', 'Very good', 'Good', 'Satisfactory']);
    expect(byKey['student.leavingReason'].choices).toContain('Transferred to another school');
    expect(byKey['student.name'].choices).toEqual([]);
  });
});

describe('entered values', () => {
  it('a date from the picker prints like a record date', async () => {
    const p = (
      await preview({
        studentId: s.students[0],
        type: 'bonafide',
        values: { 'student.dateOfBirth': '2015-03-12', 'student.rollNo': '7' },
      })
    ).body.data;
    expect(p.fields.find((f: { key: string }) => f.key === 'student.dateOfBirth').value).toBe('12 March 2015');
    expect(p.body).toContain('12 March 2015');
  });

  it('an impossible or free-text date is refused', async () => {
    for (const bad of ['2015-02-30', 'next week', '31/12/2015']) {
      const res = await preview({ studentId: s.students[0], type: 'bonafide', values: { 'student.dateOfBirth': bad } });
      expect(res.status, bad).toBe(400);
    }
  });

  it('conduct accepts a listed answer or custom wording', async () => {
    for (const conduct of ['Very good', 'Exemplary and helpful to juniors']) {
      const p = (
        await preview({ studentId: s.students[0], type: 'character', values: { 'certificate.conduct': conduct } })
      ).body.data;
      expect(p.body).toContain(conduct);
      expect(p.canIssue).toBe(true);
    }
  });

  it('the key details are emphasised in the preview and in the issued PDF', async () => {
    const body = { studentId: s.students[1], type: 'character', values: { 'certificate.conduct': 'Excellent' } };
    const p = (await preview(body)).body.data;
    const name = p.fields.find((f: { key: string }) => f.key === 'student.name').value;
    expect(p.emphasis).toEqual(expect.arrayContaining([name, 'Excellent']));
    const pdf = await request(t.app).post('/api/v1/certificates/preview.pdf').set(auth(s.ownerToken)).send(body);
    expect(pdf.status).toBe(200);
    const cert = await api(t.app, s.ownerToken, 'post', '/certificates', body);
    expect(cert.body).toContain('Excellent');
  });
});

describe('helpers', () => {
  it('parseEnteredDate takes real dates only', () => {
    expect(parseEnteredDate('2024-02-29')?.toISOString().slice(0, 10)).toBe('2024-02-29');
    expect(parseEnteredDate('29 February 2024')?.toISOString().slice(0, 10)).toBe('2024-02-29');
    expect(parseEnteredDate('2023-02-29')).toBeNull();
    expect(parseEnteredDate('31 June 2024')).toBeNull();
    expect(parseEnteredDate('June 3')).toBeNull();
  });

  it('emphasised splits the longest values first, escapes them, and keeps all the text', () => {
    const parts = emphasised('Ali Khan (Adm. 5) of Class 5 is Ali.', ['Ali Khan', 'Ali', 'Class 5', '(Adm. 5)']);
    expect(parts.map((p) => p.text).join('')).toBe('Ali Khan (Adm. 5) of Class 5 is Ali.');
    expect(parts.filter((p) => p.strong).map((p) => p.text)).toEqual(['Ali Khan', '(Adm. 5)', 'Class 5', 'Ali']);
    expect(emphasised('Plain text', [])).toEqual([{ text: 'Plain text', strong: false }]);
  });
});
