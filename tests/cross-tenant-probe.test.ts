import mongoose from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { collectInventory } from '../scripts/endpoint-inventory';
import { api, buildSchool } from './fixtures';
import { auth, useTestApp } from './helpers';

/**
 * Automated broken-object-level-authorization probe across every school endpoint.
 *
 * School A's most privileged user (its Admin) calls every route that takes an id with REAL ids
 * of School B's documents (students, invoices, payments, files, exams, ...). A violation is any
 * 2xx response that contains School B's id, any 5xx, or any change to School B's data.
 */
const t = useTestApp();
const EJSON = mongoose.mongo.BSON.EJSON;
const IGNORED = new Set(['auditlogs', 'errorevents', 'refreshtokens', 'notifications', 'aiusages', 'counters']);

async function snapshotSchool(schoolId: string) {
  const db = mongoose.connection.db!;
  const out: Record<string, string> = {};
  const sid = new mongoose.Types.ObjectId(schoolId);
  for (const c of await db.listCollections().toArray()) {
    if (IGNORED.has(c.name)) continue;
    const filter = c.name === 'schools' ? { _id: sid } : { schoolId: sid };
    const docs = await db.collection(c.name).find(filter).sort({ _id: 1 }).toArray();
    // lastLoginAt/updatedAt of B's own users are not touched by A; compare everything.
    out[c.name] = EJSON.stringify(docs);
  }
  return out;
}

describe('Cross-tenant probe', () => {
  it('School A cannot read, change or delete School B records through any endpoint', async () => {
    const a = await buildSchool(t.app, { students: 2 });
    const b = await buildSchool(t.app, { students: 2 });
    // Give School B financial records, an exam and a file so those routes have real targets.
    await api(t.app, b.accountantToken, 'post', '/fees/invoices/generate', { period: '2026-09' });
    const [bInv] = await api(t.app, b.accountantToken, 'get', '/fees/invoices?period=2026-09');
    await api(t.app, b.accountantToken, 'post', `/fees/invoices/${bInv._id}/payments`, {
      amount: 1000,
      method: 'cash',
    });
    await request(t.app)
      .post('/api/v1/files')
      .set(auth(b.ownerToken))
      .field('category', 'student_document')
      .field('studentId', b.students[0])
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'b.pdf', contentType: 'application/pdf' });

    const db = mongoose.connection.db!;
    const bId = new mongoose.Types.ObjectId(b.schoolId);
    const ids: string[] = [b.schoolId];
    for (const c of await db.listCollections().toArray()) {
      if (IGNORED.has(c.name)) continue;
      const docs = await db.collection(c.name).find({ schoolId: bId }).project({ _id: 1 }).limit(3).toArray();
      ids.push(...docs.map((d) => d._id.toString()));
    }
    expect(ids.length).toBeGreaterThan(20);

    const before = await snapshotSchool(b.schoolId);
    const routes = (await collectInventory()).filter((r) => r.auth === 'school' && r.path.includes(':'));
    const violations: string[] = [];
    let calls = 0;
    for (const r of routes) {
      for (const id of ids) {
        const url = r.path.replace(/:[A-Za-z]+/g, id);
        const res = await (request(t.app) as any)[r.method.toLowerCase()](url).set(auth(a.ownerToken)).send({});
        calls++;
        const text = typeof res.text === 'string' ? res.text : '';
        if (res.status >= 500) violations.push(`${r.method} ${r.path} → ${res.status} ${text.slice(0, 120)}`);
        else if (res.status < 300 && text.includes(b.schoolId))
          violations.push(`${r.method} ${r.path} leaked School B data`);
      }
    }
    // Query and body tampering: the tenant always comes from the token.
    const list = await request(t.app).get(`/api/v1/students?schoolId=${b.schoolId}`).set(auth(a.ownerToken));
    expect([200, 400]).toContain(list.status);
    expect(list.text).not.toContain(b.schoolId);
    const created = await request(t.app)
      .post('/api/v1/academics/classes')
      .set(auth(a.ownerToken))
      .send({ campusId: a.campusId, name: 'Mass assignment probe', level: 9, schoolId: b.schoolId });
    if (created.status === 201) expect(created.body.data.schoolId).toBe(a.schoolId);
    const intoB = await request(t.app)
      .post('/api/v1/academics/classes')
      .set(auth(a.ownerToken))
      .send({ campusId: b.campusId, name: 'Foreign campus probe', level: 9 });
    expect(intoB.status).toBeGreaterThanOrEqual(400);

    const after = await snapshotSchool(b.schoolId);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    console.log(
      `[evidence] cross-tenant probe: ${routes.length} id-taking routes × ${ids.length} School B ids = ${calls} requests`,
    );
    expect(violations).toEqual([]);
    expect(changed).toEqual([]);
  }, 600_000);
});
