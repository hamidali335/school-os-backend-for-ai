import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSchool, SchoolFixture } from './fixtures';
import { auth, PASSWORD, useTestApp } from './helpers';

const t = useTestApp();
let fixture: SchoolFixture;

const openapiSpec = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../docs/openapi.json'), 'utf8'),
);

function resolveSchema(schema: any): any {
  if (!schema) return schema;
  if (schema.$ref) {
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    let cur: any = openapiSpec;
    for (const p of parts) cur = cur[p];
    return resolveSchema(cur);
  }
  if (schema.allOf) {
    const merged: any = { type: 'object', properties: {}, required: [] };
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(sub);
      if (resolved.properties) {
        Object.assign(merged.properties, resolved.properties);
      }
      if (resolved.required) {
        merged.required.push(...resolved.required);
      }
    }
    return merged;
  }
  return schema;
}

// Known Mongoose document fields present on persisted database entities but omitted from OpenAPI DTO schemas:
const ALLOWED_MODEL_FIELDS = new Set([
  'schoolId',
  'createdAt',
  'updatedAt',
  '__v',
  'version',
  'admissionDate',
  'sessionId',
  'campusId',
  'customFees',
  'phone',
  'concessionApplies',
  'receivedBy',
  'classId',
  'sectionId',
  'createdBy',
  'paymentLock',
]);

function validateSchema(data: any, rawSchema: any, pathName = 'response'): void {
  const schema = resolveSchema(rawSchema);
  if (!schema) return;

  if (schema.type === 'object' || schema.properties) {
    expect(typeof data, `${pathName} should be an object`).toBe('object');
    expect(data, `${pathName} should not be null`).not.toBeNull();
    expect(Array.isArray(data), `${pathName} should not be an array`).toBe(false);

    const definedProps = new Set<string>(Object.keys(schema.properties || {}));
    const requiredProps = new Set<string>(schema.required || []);

    // 1. Assert no missing required fields
    for (const req of Array.from(requiredProps)) {
      expect(
        (data as Record<string, unknown>)[req] !== undefined,
        `Missing required property "${req}" at ${pathName}. Available properties: ${Object.keys(data).join(', ')}`,
      ).toBe(true);
    }

    // 2. Assert no extra fields
    const extra: string[] = [];
    for (const key of Object.keys(data)) {
      const isAllowed = definedProps.has(key) || ALLOWED_MODEL_FIELDS.has(key);
      if (!isAllowed) {
        extra.push(key);
      }
      const propSchema = schema.properties?.[key];
      if (propSchema && data[key] !== null && data[key] !== undefined) {
        validateSchema(data[key], propSchema, `${pathName}.${key}`);
      }
    }
    expect(
      extra,
      `Unexpected extra fields at ${pathName}: ${extra.join(', ')}. Defined: ${Array.from(definedProps).join(', ')}`,
    ).toEqual([]);
  } else if (schema.type === 'array' || schema.items) {
    expect(Array.isArray(data), `${pathName} should be an array`).toBe(true);
    if (schema.items) {
      data.forEach((item: any, idx: number) => {
        validateSchema(item, schema.items, `${pathName}[${idx}]`);
      });
    }
  }
}

function assertMatchesOpenApiSchema(
  apiPath: string,
  method: string,
  status: number,
  body: any,
) {
  const op = openapiSpec.paths[apiPath]?.[method.toLowerCase()];
  expect(op, `Path ${method.toUpperCase()} ${apiPath} not found in openapi.json`).toBeDefined();
  const resp = op.responses[status.toString()];
  expect(resp, `Response ${status} for ${method.toUpperCase()} ${apiPath} not found`).toBeDefined();
  const schema = resp.content?.['application/json']?.schema;
  expect(schema, `Schema for ${status} in ${method.toUpperCase()} ${apiPath} not found`).toBeDefined();

  validateSchema(body, schema, `${method.toUpperCase()} ${apiPath}`);
}

describe('Web Route Regression Suite', () => {
  beforeAll(async () => {
    fixture = await buildSchool(t.app, { students: 2 });
  });

  // 1. Auth Login Route
  it('POST /auth/login returns HTTP 200 with JWT accessToken and user info', async () => {
    const res = await request(t.app)
      .post('/api/v1/auth/login')
      .send({
        email: fixture.ownerEmail,
        password: PASSWORD,
      });

    expect(res.status).toBe(200);
    assertMatchesOpenApiSchema('/api/v1/auth/login', 'post', 200, res.body);
    expect(res.body.data).toHaveProperty('accessToken');
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.role).toBe('school_owner');
    expect(res.body.data.user.schoolId).toBe(fixture.schoolId);
  });

  // 2. Student Create Route
  it('POST /students returns HTTP 201 with student record and admissionNo', async () => {
    const res = await request(t.app)
      .post('/api/v1/students')
      .set(auth(fixture.adminToken))
      .send({
        campusId: fixture.campusId,
        sessionId: fixture.sessionId,
        classId: fixture.classId,
        sectionId: fixture.sectionA,
        admissionNo: `ADM-REG-${Date.now()}`,
        firstName: 'Regression',
        lastName: 'Student',
        gender: 'male',
        dateOfBirth: '2016-01-01',
        guardians: [
          {
            parent: {
              name: 'Parent Name',
              phone: '+923001234567',
            },
            relationship: 'father',
            isPrimary: true,
          },
        ],
      });

    expect(res.status).toBe(201);
    assertMatchesOpenApiSchema('/api/v1/students', 'post', 201, res.body);
    expect(res.body.data).toBeDefined();
    expect(res.body.data._id).toBeDefined();
    expect(res.body.data.firstName).toBe('Regression');
    expect(res.body.data.lastName).toBe('Student');
    expect(res.body.data.status).toBe('active');
  });

  // 3. Student Update Route
  it('PATCH /students/:id returns HTTP 200 with updated fields', async () => {
    const studentId = fixture.students[0];
    const res = await request(t.app)
      .patch(`/api/v1/students/${studentId}`)
      .set(auth(fixture.adminToken))
      .send({
        phone: '+923009988776',
        address: 'Updated Address 123',
      });

    expect(res.status).toBe(200);
    assertMatchesOpenApiSchema('/api/v1/students/{id}', 'patch', 200, res.body);
    expect(res.body.data).toBeDefined();
    expect(res.body.data._id).toBe(studentId);
    expect(res.body.data.phone).toBe('+923009988776');
    expect(res.body.data.address).toBe('Updated Address 123');
  });

  // 4. Attendance Mark Route
  it('POST /attendance/mark returns HTTP 200 with register details', async () => {
    const res = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(fixture.ownerToken))
      .send({
        sectionId: fixture.sectionA,
        date: '2026-05-18', // Valid Monday in test session
        records: [
          {
            studentId: fixture.students[0],
            status: 'present',
            remarks: 'On time',
          },
        ],
        finalize: false,
      });

    expect(res.status).toBe(200);
    assertMatchesOpenApiSchema('/api/v1/attendance/mark', 'post', 200, res.body);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.sectionId).toBe(fixture.sectionA);
    expect(res.body.data.date).toBe('2026-05-18');
    expect(res.body.data.saved).toBe(1);
    expect(res.body.data.state).toBeDefined();
  });

  // 5. Adhoc Invoice Creation Route
  it('POST /fees/invoices returns HTTP 201 with invoice details and balance', async () => {
    const res = await request(t.app)
      .post('/api/v1/fees/invoices')
      .set(auth(fixture.accountantToken))
      .send({
        studentId: fixture.students[0],
        period: '2026-09',
        dueDate: '2026-09-30',
        items: [
          {
            feeHeadId: fixture.tuitionHeadId,
            name: 'Tuition Fee',
            amount: 3500,
          },
        ],
      });

    expect(res.status).toBe(201);
    assertMatchesOpenApiSchema('/api/v1/fees/invoices', 'post', 201, res.body);
    expect(res.body.data).toBeDefined();
    expect(res.body.data._id).toBeDefined();
    expect(res.body.data.invoiceNo).toBeDefined();
    expect(res.body.data.total).toBe(3500);
    expect(res.body.data.balance).toBe(3500);
    expect(res.body.data.status).toBe('unpaid');
  });

  // 6. Payment Recording Route
  it('POST /fees/invoices/:id/payments returns HTTP 201 with receipt and reduced balance', async () => {
    // Generate an invoice first
    const invRes = await request(t.app)
      .post('/api/v1/fees/invoices')
      .set(auth(fixture.accountantToken))
      .send({
        studentId: fixture.students[1],
        period: '2026-09',
        dueDate: '2026-09-30',
        items: [
          {
            feeHeadId: fixture.tuitionHeadId,
            name: 'Tuition Fee',
            amount: 4000,
          },
        ],
      });
    const invId = invRes.body.data._id;

    // Record payment
    const payRes = await request(t.app)
      .post(`/api/v1/fees/invoices/${invId}/payments`)
      .set(auth(fixture.accountantToken))
      .send({
        amount: 1500,
        method: 'cash',
        reference: 'RCP-REG-01',
      });

    expect(payRes.status).toBe(201);
    assertMatchesOpenApiSchema('/api/v1/fees/invoices/{id}/payments', 'post', 201, payRes.body);
    expect(payRes.body.data).toBeDefined();
    expect(payRes.body.data.payment).toBeDefined();
    expect(payRes.body.data.payment.receiptNo).toBeDefined();
    expect(payRes.body.data.payment.amount).toBe(1500);
    expect(payRes.body.data.payment.balanceAfter).toBe(2500);
    expect(payRes.body.data.invoice).toBeDefined();
    expect(payRes.body.data.invoice.balance).toBe(2500);
    expect(payRes.body.data.invoice.paid).toBe(1500);
    expect(payRes.body.data.invoice.status).toBe('partial');
  });
});
