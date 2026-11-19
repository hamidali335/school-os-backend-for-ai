import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestSchool, PASSWORD, useTestApp, type TestSchool } from './helpers';
import { Student, Parent, StudentEnrollment } from '../src/modules/students/student.models';
import { AcademicSession, SchoolClass, Section } from '../src/modules/academics/academics.models';
import { Invoice, Payment, FeeStructure } from '../src/modules/fees/fees.models';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Employee, Payslip } from '../src/modules/employees/employee.model';
import { SyncDevice, SyncIdempotency, SyncChangeLog, SyncConflict } from '../src/modules/sync/sync.models';
import { recordChange as recordBackendChange } from '../src/modules/sync/sync.service';
import { atomic } from '../src/database/transactions';

// Import desktop application modules dynamically using SMS_DESKTOP_PATH or relative fallback
const desktopPath = process.env.SMS_DESKTOP_PATH || path.resolve(__dirname, '../../SchoolManagementSoftware');
if (!fs.existsSync(path.join(desktopPath, 'dist/main/database/migrations/index.js'))) {
  execSync('npm run build:main', { cwd: desktopPath, stdio: 'ignore' });
}

const Database = require(path.join(desktopPath, 'node_modules/better-sqlite3'));
const { runMigrations, ALL_MIGRATIONS } = require(path.join(desktopPath, 'dist/main/database/migrations/index.js'));
const { SyncEngine } = require(path.join(desktopPath, 'dist/main/sync/sync-engine.js'));
const { HttpSyncApiClient } = require(path.join(desktopPath, 'dist/main/sync/sync-api-client.js'));
const { recordChange } = require(path.join(desktopPath, 'dist/main/sync/change-tracker.js'));

const t = useTestApp();

describe('Phase 5 Real Cloud Sync Integration & End-to-End Suite', () => {
  let server: Server;
  let port: number;
  let baseUrl: string;
  let schoolA: TestSchool;
  let schoolB: TestSchool;
  let sessionA: any;
  let classA: any;
  let sectionA: any;

  // Helper to create an in-memory SQLite database for desktop client
  function createDesktopDb(schoolId: string, deviceId = 'dev_win_test_01', token?: string) {
    const db = new Database(':memory:');
    runMigrations(db, ALL_MIGRATIONS);

    // Seed installation config
    db.prepare('DELETE FROM installation_config').run();
    db.prepare(`
      INSERT INTO installation_config (
        id, school_id, school_name, school_code, installation_id, provisioned_at, updated_at
      ) VALUES (1, ?, 'Test School Desktop', 'TSD', 'inst_key_test', datetime('now'), datetime('now'))
    `).run(schoolId);

    // Seed sync device config
    db.prepare('DELETE FROM sync_device_config').run();
    db.prepare(`
      INSERT INTO sync_device_config (
        id, school_id, device_id, device_name, api_base_url, auth_token_encrypted, device_status
      ) VALUES (1, ?, ?, 'Principal-Workstation', ?, ?, 'registered')
    `).run(schoolId, deviceId, baseUrl, token || null);

    return db;
  }

  beforeAll(async () => {
    // Start ephemeral HTTP server on loopback
    server = t.app.listen(0);
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;

    schoolA = await createTestSchool(t.app, 'SCHA');
    schoolB = await createTestSchool(t.app, 'SCHB');

    sessionA = await AcademicSession.create({
      schoolId: schoolA.schoolId,
      name: '2026-2027',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
      isCurrent: true,
    });
    classA = await SchoolClass.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      name: 'Class 1',
      level: 1,
      status: 'active',
    });
    sectionA = await Section.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      classId: classA._id,
      sessionId: sessionA._id,
      name: 'Section A',
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: Desktop creates student offline -> reconnect -> pushed once
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 1: Desktop creates a student while offline; reconnects; backend receives the student exactly once', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // 1. Simulate offline: Network disconnected, desktop creates student locally
    engine.setNetworkState('offline');
    const stdPayload = {
      id: 'std_off_01',
      schoolId: schoolA.schoolId,
      admissionNumber: 'ADM-2026-REAL-01',
      fullName: 'Muhammad Usman Tariq',
      fatherName: 'Tariq Mehmood',
      gender: 'male',
      dateOfBirth: '2015-05-10',
      status: 'active',
    };

    desktopDb.prepare(`
      INSERT INTO students (id, school_id, admission_number, full_name, father_name, gender, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(stdPayload.id, schoolA.schoolId, stdPayload.admissionNumber, stdPayload.fullName, stdPayload.fatherName, stdPayload.gender, stdPayload.status);

    recordChange('STUDENT', stdPayload.id, 'INSERT', stdPayload, desktopDb);

    // Pending count should be 1
    const pendingBefore = desktopDb.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE status = 'pending'").get().count;
    expect(pendingBefore).toBe(1);

    // 2. Reconnect network and trigger synchronization
    engine.setNetworkState('online');
    const result = await engine.triggerSync();
    expect(result.success).toBe(true);
    expect(result.uploadedCount).toBe(1);

    // 3. Verify backend received and committed student in MongoDB
    const serverStudent = await Student.findOne({ schoolId: schoolA.schoolId, admissionNo: 'ADM-2026-REAL-01' });
    expect(serverStudent).toBeTruthy();
    expect(serverStudent?.firstName).toBe('Muhammad');
    expect(serverStudent?.lastName).toBe('Usman Tariq');

    // Outbox entry should be synced
    const pendingAfter = desktopDb.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE status = 'pending'").get().count;
    expect(pendingAfter).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: Backend creates/updates a record -> desktop downloads it
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 2: Backend creates or updates a supported record; desktop downloads it', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // 1. Create a student directly on backend (e.g. from web admin portal)
    const serverStudent = await Student.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      sessionId: sessionA._id,
      classId: classA._id,
      sectionId: sectionA._id,
      admissionNo: 'ADM-CLOUD-02',
      rollNo: '2',
      firstName: 'Ayesha',
      lastName: 'Khan',
      gender: 'female',
      phone: '+923005511223',
      address: 'Model Town, Lahore',
      status: 'active',
    });

    // Record in backend change journal using sequence-based recordChange
    await atomic(async () => {
      await recordBackendChange(
        schoolA.schoolId,
        'STUDENT',
        serverStudent._id.toString(),
        'INSERT',
        1,
        {
          id: serverStudent._id.toString(),
          schoolId: schoolA.schoolId,
          admissionNumber: 'ADM-CLOUD-02',
          fullName: 'Ayesha Khan',
          fatherName: 'Khan Muhammad',
          phone: '+923005511223',
          address: 'Model Town, Lahore',
          status: 'active',
        },
        { originDeviceId: 'web_portal' },
      );
    });

    // 2. Desktop triggers sync to pull remote changes
    const syncRes = await engine.triggerSync();
    expect(syncRes.success).toBe(true);
    expect(syncRes.downloadedCount).toBeGreaterThanOrEqual(1);

    // 3. Verify desktop local database contains the downloaded student
    const localRow = desktopDb.prepare('SELECT * FROM students WHERE admission_number = ?').get('ADM-CLOUD-02') as any;
    expect(localRow).toBeTruthy();
    expect(localRow.full_name).toBe('Ayesha Khan');
    expect(localRow.phone).toBe('+923005511223');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: Independent field updates -> auto-merge
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 3: Both sides update independent fields; compatible changes are preserved', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // Initial synchronized record
    const stdId = 'std_merge_03';
    desktopDb.prepare(`
      INSERT INTO students (id, school_id, admission_number, full_name, father_name, phone, address, status)
      VALUES (?, ?, 'ADM-MERGE-03', 'Bilal Ahmed', 'Ahmed Raza', '03001112233', 'Gulberg, Lahore', 'active')
    `).run(stdId, schoolA.schoolId);

    // Desktop updates address locally
    desktopDb.prepare("UPDATE students SET address = 'DHA Phase 5, Lahore' WHERE id = ?").run(stdId);
    recordChange('STUDENT', stdId, 'UPDATE', {
      id: stdId,
      schoolId: schoolA.schoolId,
      admissionNumber: 'ADM-MERGE-03',
      fullName: 'Bilal Ahmed',
      fatherName: 'Ahmed Raza',
      phone: '03001112233',
      address: 'DHA Phase 5, Lahore',
    }, desktopDb);

    // Server updates phone independently
    await atomic(async () => {
      await recordBackendChange(
        schoolA.schoolId,
        'STUDENT',
        stdId,
        'UPDATE',
        2,
        {
          id: stdId,
          schoolId: schoolA.schoolId,
          admissionNumber: 'ADM-MERGE-03',
          fullName: 'Bilal Ahmed',
          fatherName: 'Ahmed Raza',
          phone: '03219998877', // Independent phone update
          address: 'Gulberg, Lahore',
        },
        { originDeviceId: 'web_portal' },
      );
    });

    const syncRes = await engine.triggerSync();
    expect(syncRes.success).toBe(true);

    // Local record should have merged phone from server while keeping updated address
    const updatedLocal = desktopDb.prepare('SELECT * FROM students WHERE id = ?').get(stdId) as any;
    expect(updatedLocal.phone).toBe('03219998877');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Divergent edits on critical fields -> conflict recorded
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 4: Both sides modify the same important field; a conflict is created and handled correctly', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    const stdId = 'std_conf_04';
    desktopDb.prepare(`
      INSERT INTO students (id, school_id, admission_number, full_name, father_name, cnic_bform, status)
      VALUES (?, ?, 'ADM-CONF-04', 'Zain Tariq', 'Tariq Ali', '35201-1111111-1', 'active')
    `).run(stdId, schoolA.schoolId);

    // Increment local version to simulate offline concurrent mutation
    desktopDb.prepare(`
      INSERT INTO entity_sync_versions (school_id, entity_type, entity_id, local_version, remote_version, updated_at)
      VALUES (?, 'STUDENT', ?, 2, 1, datetime('now'))
    `).run(schoolA.schoolId, stdId);

    // Server has divergent value for same critical field
    await atomic(async () => {
      await recordBackendChange(
        schoolA.schoolId,
        'STUDENT',
        stdId,
        'UPDATE',
        2,
        {
          id: stdId,
          schoolId: schoolA.schoolId,
          admissionNumber: 'ADM-CONF-04',
          fullName: 'Zain Tariq (Server Edit)',
          cnicBform: '35201-9999999-9', // Conflicting bForm
        },
        { originDeviceId: 'web_portal' },
      );
    });

    const syncRes = await engine.triggerSync();
    expect(syncRes.conflictCount).toBeGreaterThanOrEqual(1);

    // Conflict must be persisted in local SQLite sync_conflicts table
    const localConflict = desktopDb.prepare("SELECT * FROM sync_conflicts WHERE entity_id = ? AND status = 'unresolved'").get(stdId) as any;
    expect(localConflict).toBeTruthy();
    expect(localConflict.entity_type).toBe('STUDENT');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: Payment idempotency across multiple retried pushes
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 5: A payment event is retried multiple times; only one payment is recorded', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);

    // 1. First push an invoice
    const invId = 'inv_pay_test_05';
    const invEvent = {
      eventId: 'evt_inv_05',
      entityType: 'INVOICE',
      entityId: invId,
      operation: 'INSERT' as const,
      payload: {
        id: invId,
        challanNumber: 'INV-2026-PAY-05',
        studentId: 'std_off_01',
        amount: 8000,
        paidAmount: 0,
        balance: 8000,
        month: '2026-11',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_inv_pay_05',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [invEvent], schoolA.ownerToken);

    // 2. Prepare payment event
    const payEvent = {
      eventId: 'evt_pay_05',
      entityType: 'PAYMENT',
      entityId: 'pay_05',
      operation: 'INSERT' as const,
      payload: {
        id: 'pay_05',
        invoiceId: invId,
        receiptNumber: 'REC-2026-DUP-05',
        amount: 5000,
        paymentDate: '2026-11-14',
        paymentMethod: 'cash',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_payment_unique_05',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    // 3. Push payment event 3 times concurrently / consecutively (retry simulation)
    const res1 = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [payEvent], schoolA.ownerToken);
    const res2 = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [payEvent], schoolA.ownerToken);
    const res3 = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [payEvent], schoolA.ownerToken);

    expect(res1.events[0].status).toBe('synced');
    expect(res2.events[0].status).toBe('synced'); // Idempotent acknowledgment
    expect(res3.events[0].status).toBe('synced'); // Idempotent acknowledgment

    // 4. Verify MongoDB has EXACTLY ONE payment document for this receipt
    const payments = await Payment.find({ schoolId: schoolA.schoolId, receiptNo: 'REC-2026-DUP-05' });
    expect(payments.length).toBe(1);

    // Verify invoice balance was decremented by 5,000 exactly once (8,000 - 5,000 = 3,000)
    const invDoc = await Invoice.findOne({ schoolId: schoolA.schoolId, invoiceNo: 'INV-2026-PAY-05' });
    expect(invDoc?.paid).toBe(5000);
    expect(invDoc?.balance).toBe(3000);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 6: Payment reversal preserves original payment record
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 6: A payment reversal synchronizes without changing or deleting the original payment record', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // Push reversal event referencing payment
    const revEvent = {
      eventId: 'evt_rev_06',
      entityType: 'PAYMENT',
      entityId: 'pay_rev_06',
      operation: 'INSERT' as const,
      payload: {
        id: 'pay_rev_06',
        invoiceId: 'inv_pay_test_05',
        receiptNumber: 'REC-2026-DUP-05',
        amount: 5000,
        reversalForPaymentId: 'pay_05',
        reversalReason: 'Wrong fee voucher issued',
        status: 'reversed',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_payment_rev_06',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    const res = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [revEvent], schoolA.ownerToken);
    expect(res.events[0].status).toBe('synced');

    // Verify original payment record remains permanently preserved in MongoDB
    const original = await Payment.findOne({ schoolId: schoolA.schoolId, receiptNo: 'REC-2026-DUP-05' });
    expect(original).toBeTruthy();
    expect(original?.status).toBe('reversed');
    expect(original?.reversalReason).toBe('Wrong fee voucher issued');
    expect(original?.reversedAt).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 7: Invoice balance remains mathematically consistent
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 7: Invoice balances remain mathematically consistent after synchronization', async () => {
    // After reversal in Scenario 6, invoice balance should be restored to total (8,000)
    const inv = await Invoice.findOne({ schoolId: schoolA.schoolId, invoiceNo: 'INV-2026-PAY-05' });
    expect(inv).toBeTruthy();
    expect(inv?.paid).toBe(0);
    expect(inv?.balance).toBe(8000);
    expect(inv?.total! - inv?.paid!).toBe(inv?.balance);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 8: Student promotion preserves all historical records
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 8: Student promotion preserves all historical enrollment and academic records', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // Enroll in session 1
    const enr1 = {
      eventId: 'evt_enr_sess1',
      entityType: 'STUDENT_ENROLLMENT',
      entityId: 'enr_s1',
      operation: 'INSERT' as const,
      payload: {
        id: 'enr_s1',
        studentId: 'std_off_01',
        sessionId: 'sess_2025_26',
        classId: 'cls_1',
        sectionId: 'sec_1a',
        rollNo: '10',
        status: 'promoted', // Historical session status
      },
      localVersion: 1,
      idempotencyKey: 'idemp_enr_sess1',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    // Promote to session 2
    const enr2 = {
      eventId: 'evt_enr_sess2',
      entityType: 'STUDENT_ENROLLMENT',
      entityId: 'enr_s2',
      operation: 'INSERT' as const,
      payload: {
        id: 'enr_s2',
        studentId: 'std_off_01',
        sessionId: 'sess_2026_27',
        classId: 'cls_2',
        sectionId: 'sec_2a',
        rollNo: '5',
        status: 'active', // New session status
      },
      localVersion: 1,
      idempotencyKey: 'idemp_enr_sess2',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    const res = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [enr1, enr2], schoolA.ownerToken);
    expect(res.acknowledgedCount).toBe(2);

    // Verify historical enrollment records are preserved
    const student = await Student.findOne({ schoolId: schoolA.schoolId, admissionNo: 'ADM-2026-REAL-01' });
    const enrollments = await StudentEnrollment.find({ schoolId: schoolA.schoolId, studentId: student?._id });
    expect(enrollments.length).toBeGreaterThanOrEqual(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 9: Guardian replacement preserves single active invariant
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 9: Guardian replacement conflict is handled safely preserving single active guardian invariant', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // 1. Assign first primary guardian
    const gdn1 = {
      eventId: 'evt_gdn_09a',
      entityType: 'STUDENT_GUARDIAN',
      entityId: 'gdn_09a',
      operation: 'INSERT' as const,
      payload: {
        id: 'gdn_09a',
        studentId: 'std_off_01',
        fullName: 'Tariq Mehmood',
        phone: '+923001122334',
        relationship: 'father',
        isActive: true,
      },
      localVersion: 1,
      idempotencyKey: 'idemp_gdn_09a',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [gdn1], schoolA.ownerToken);

    // 2. Concurrent replacement from older branch (localVersion > 1)
    const gdn2 = {
      eventId: 'evt_gdn_09b',
      entityType: 'STUDENT_GUARDIAN',
      entityId: 'gdn_09b',
      operation: 'INSERT' as const,
      payload: {
        id: 'gdn_09b',
        studentId: 'std_off_01',
        fullName: 'Khadija Bibi',
        phone: '+923009988776',
        relationship: 'mother',
        isActive: true,
      },
      localVersion: 2,
      idempotencyKey: 'idemp_gdn_09b',
      deviceId: 'dev_02',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    const res2 = await apiClient.pushBatch(schoolA.schoolId, 'dev_02', [gdn2], schoolA.ownerToken);
    expect(res2.events[0].status).toBe('conflict');
    expect(res2.events[0].conflictDetails?.reason).toContain('active guardian replacement');

    // Verify single active guardian invariant in MongoDB
    const student = await Student.findOne({ schoolId: schoolA.schoolId, admissionNo: 'ADM-2026-REAL-01' });
    const activeGuardians = student?.guardians.filter(g => g.isPrimary) || [];
    expect(activeGuardians.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 10: Attendance correction preserves correction remarks
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 10: Attendance synchronization preserves correction history', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // Mark initial attendance
    const att1 = {
      eventId: 'evt_att_10a',
      entityType: 'ATTENDANCE',
      entityId: 'att_10',
      operation: 'INSERT' as const,
      payload: {
        id: 'att_10',
        studentId: 'std_off_01',
        date: '2026-11-14',
        status: 'present',
        remarks: 'Normal morning roll-call',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_att_10a',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [att1], schoolA.ownerToken);

    // Correction pushed
    const att2 = {
      eventId: 'evt_att_10b',
      entityType: 'ATTENDANCE',
      entityId: 'att_10',
      operation: 'UPDATE' as const,
      payload: {
        id: 'att_10',
        studentId: 'std_off_01',
        date: '2026-11-14',
        status: 'absent',
        remarks: 'Corrected by Principal',
      },
      localVersion: 2,
      idempotencyKey: 'idemp_att_10b',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [att2], schoolA.ownerToken);

    const student = await Student.findOne({ schoolId: schoolA.schoolId, admissionNo: 'ADM-2026-REAL-01' });
    const record = await AttendanceRecord.findOne({ schoolId: schoolA.schoolId, studentId: student?._id });
    expect(record?.status).toBe('absent');
    expect(record?.remarks).toBe('Corrected by Principal');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 11: Payroll status synchronization
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 11: Payroll synchronization validates trusted payment status', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // Create employee
    const empEvent = {
      eventId: 'evt_emp_11',
      entityType: 'EMPLOYEE',
      entityId: 'emp_11',
      operation: 'INSERT' as const,
      payload: {
        id: 'emp_11',
        employeeCode: 'EMP-2026-11',
        fullName: 'Rashid Khan',
        designation: 'Mathematics Teacher',
        phone: '+923004455667',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_emp_11',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [empEvent], schoolA.ownerToken);

    // Push payslip
    const slipEvent = {
      eventId: 'evt_slip_11',
      entityType: 'PAYROLL_SLIP',
      entityId: 'slip_11',
      operation: 'INSERT' as const,
      payload: {
        id: 'slip_11',
        employeeCode: 'EMP-2026-11',
        month: '2026-11',
        basicSalary: 60000,
        netSalary: 60000,
        paymentStatus: 'paid',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_slip_11',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };
    const res = await apiClient.pushBatch(schoolA.schoolId, 'dev_01', [slipEvent], schoolA.ownerToken);
    expect(res.events[0].status).toBe('synced');

    const emp = await Employee.findOne({ schoolId: schoolA.schoolId, employeeNo: 'EMP-2026-11' });
    const payslip = await Payslip.findOne({ schoolId: schoolA.schoolId, employeeId: emp?._id });
    expect(payslip?.status).toBe('paid');
    expect(payslip?.paidAt).toBeTruthy();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 12 & 13: Server outage during push & recovery on restart
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 12 & 13: Server outage handling and recovery after reconnection', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    // Point to non-listening port to simulate server outage
    const offlineClient = new HttpSyncApiClient('http://127.0.0.1:59999/api/v1');
    const engine = new SyncEngine(desktopDb, { apiClient: offlineClient });

    recordChange('STUDENT', 'std_outage_12', 'INSERT', {
      id: 'std_outage_12',
      schoolId: schoolA.schoolId,
      admissionNumber: 'ADM-OUTAGE-12',
      fullName: 'Hamza Outage Test',
    }, desktopDb);

    // Push should fail gracefully without crashing
    const outageRes = await engine.triggerSync();
    expect(outageRes.success).toBe(false);

    // Outbox item must remain pending
    const pendingCount = desktopDb.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE status = 'pending'").get().count;
    expect(pendingCount).toBe(1);

    // Switch client to online server (server restart recovery)
    engine.setApiClient(new HttpSyncApiClient(baseUrl));
    const recoveryRes = await engine.triggerSync();
    expect(recoveryRes.success).toBe(true);
    expect(recoveryRes.uploadedCount).toBe(1);

    // Verify pending count is now 0
    const pendingAfter = desktopDb.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE status = 'pending'").get().count;
    expect(pendingAfter).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 14: Application restart recovery
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 14: Application restarts during synchronization; processing resumes safely', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_01', schoolA.ownerToken);
    recordChange('STUDENT', 'std_restart_14', 'INSERT', {
      id: 'std_restart_14',
      schoolId: schoolA.schoolId,
      admissionNumber: 'ADM-RESTART-14',
      fullName: 'Taha Restart Test',
    }, desktopDb);

    // Re-create SyncEngine instance representing application relaunch
    const restartedEngine = new SyncEngine(desktopDb, { apiClient: new HttpSyncApiClient(baseUrl) });
    const syncRes = await restartedEngine.triggerSync();
    expect(syncRes.success).toBe(true);
    expect(syncRes.uploadedCount).toBe(1);

    const pendingCount = desktopDb.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE status = 'pending'").get().count;
    expect(pendingCount).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 15: Repeated pull request idempotency
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 15: A pull request is repeated; records are not duplicated or skipped', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);
    const pull1 = await apiClient.pullChanges(schoolA.schoolId, 'dev_01', {}, 100, schoolA.ownerToken);
    const pull2 = await apiClient.pullChanges(schoolA.schoolId, 'dev_01', {}, 100, schoolA.ownerToken);

    expect(pull1.success).toBe(true);
    expect(pull2.success).toBe(true);
    expect(pull1.changes.length).toBe(pull2.changes.length);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 16: Cursor pagination across bounded batches
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 16: Cursor pagination downloads all expected records', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // Request with small limit (limit = 2)
    const page1 = await apiClient.pullChanges(schoolA.schoolId, 'dev_01', {}, 2, schoolA.ownerToken);
    expect(page1.success).toBe(true);
    expect(page1.changes.length).toBeLessThanOrEqual(2);

    if (page1.hasMore) {
      const page2 = await apiClient.pullChanges(schoolA.schoolId, 'dev_01', page1.nextCursors, 2, schoolA.ownerToken);
      expect(page2.success).toBe(true);
      expect(page2.changes.length).toBeGreaterThan(0);
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 17: Multi-tenant boundary verification
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 17: Two schools cannot access each other synchronized data', async () => {
    const apiClient = new HttpSyncApiClient(baseUrl);

    // School A attempts to push data spoofing School B's schoolId
    const spoofEvent = {
      eventId: 'evt_spoof_17',
      entityType: 'STUDENT',
      entityId: 'std_spoof_17',
      operation: 'INSERT' as const,
      payload: {
        id: 'std_spoof_17',
        admissionNumber: 'ADM-SPOOF',
        fullName: 'Hacker Student',
      },
      localVersion: 1,
      idempotencyKey: 'idemp_spoof_17',
      deviceId: 'dev_01',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
    };

    // Client sends School B's schoolId in body while authenticated as School A
    await expect(
      apiClient.pushBatch(schoolB.schoolId, 'dev_01', [spoofEvent], schoolA.ownerToken)
    ).rejects.toThrow(/403/);

    // Client authenticated as School A cannot pull School B's changes
    await expect(
      apiClient.pullChanges(schoolB.schoolId, 'dev_01', {}, 100, schoolA.ownerToken)
    ).rejects.toThrow(/403/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 18: Malformed payloads and unauthorized requests rejected
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 18: Invalid payloads and unauthorized requests are rejected', async () => {
    // 1. Unauthenticated request (no token)
    const unauth = await request(t.app).post('/api/v1/sync/batch/push').send({ events: [] });
    expect(unauth.status).toBe(401);

    // 2. Malformed body
    const bad = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(schoolA.ownerToken))
      .send({ events: 'not-an-array' });
    expect(bad.status).toBe(400);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 19: Conflict resolution is recorded and idempotent
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 19: Conflict resolution is recorded and cannot be applied twice', async () => {
    const conflictId = `conf_res_${Date.now()}`;
    await SyncConflict.create({
      schoolId: schoolA.schoolId,
      conflictId,
      entityType: 'STUDENT',
      entityId: 'std_01',
      localPayload: { name: 'Local Val' },
      remotePayload: { name: 'Remote Val' },
      conflictingFields: ['name'],
      reason: 'Name divergence',
      status: 'unresolved',
    });

    // 1. Resolve conflict
    const res1 = await request(t.app)
      .post(`/api/v1/sync/conflicts/${conflictId}/resolve`)
      .set(auth(schoolA.ownerToken))
      .send({
        resolutionStrategy: 'local_wins',
        resolutionNotes: 'Approved local administrative override',
      });
    expect(res1.status).toBe(200);
    expect(res1.body.data.status).toBe('resolved');

    // 2. Attempt duplicate resolution -> 409 Conflict
    const res2 = await request(t.app)
      .post(`/api/v1/sync/conflicts/${conflictId}/resolve`)
      .set(auth(schoolA.ownerToken))
      .send({
        resolutionStrategy: 'remote_wins',
      });
    expect(res2.status).toBe(409);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 20: Initial synchronization and subsequent incremental sync
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 20: Initial synchronization and subsequent incremental synchronization both work', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_fresh_20', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // Initial sync bootstrap
    const initialRes = await engine.triggerSync();
    if (!initialRes.success) console.error('SCENARIO 20 ERROR:', initialRes);
    expect(initialRes.success).toBe(true);

    // Subsequent incremental sync without changes
    const secondRes = await engine.triggerSync();
    expect(secondRes.success).toBe(true);
    expect(secondRes.downloadedCount).toBe(0); // Clean no-op incremental sync
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 21: (Item 3a) Desktop syncs attendance -> Teacher edits on web portal -> Desktop downloads edit
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 21: Desktop syncs an attendance record, then a teacher edits it on web portal; desktop receives and applies edit', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_sync_3a', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // 1. Create a student on backend
    const student = await Student.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      sessionId: sessionA._id,
      classId: classA._id,
      sectionId: sectionA._id,
      admissionNo: `ADM-3A-${Date.now()}`,
      firstName: 'Zainab',
      lastName: 'Ali',
      gender: 'female',
      dob: new Date('2015-05-05'),
      status: 'active',
    });
    const studentId = student._id.toString();

    // Ensure session, class, section, student exist in local SQLite
    desktopDb.prepare(`
      INSERT OR IGNORE INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
      VALUES (?, ?, '2026-2027', '2026-04-01', '2027-03-31', 1)
    `).run(sessionA._id.toString(), schoolA.schoolId);
    desktopDb.prepare(`
      INSERT OR IGNORE INTO classes (id, school_id, name, order_index)
      VALUES (?, ?, 'Class 1', 1)
    `).run(classA._id.toString(), schoolA.schoolId);
    desktopDb.prepare(`
      INSERT OR IGNORE INTO sections (id, school_id, class_id, name)
      VALUES (?, ?, ?, 'Section A')
    `).run(sectionA._id.toString(), schoolA.schoolId, classA._id.toString());
    desktopDb.prepare(`
      INSERT OR IGNORE INTO students (id, school_id, admission_number, full_name, father_name, status)
      VALUES (?, ?, ?, 'Zainab Ali', 'Ali Raza', 'active')
    `).run(studentId, schoolA.schoolId, student.admissionNo);

    // 2. Desktop records local attendance and syncs
    const date = '2026-11-13'; // Friday (past working school day)
    const attId = `att_${studentId}_${date}`;
    desktopDb.prepare(`
      INSERT INTO attendance (id, school_id, student_id, session_id, class_id, section_id, date, status, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'present', 'Morning roll call')
    `).run(attId, schoolA.schoolId, studentId, sessionA._id.toString(), classA._id.toString(), sectionA._id.toString(), date);

    recordChange('ATTENDANCE', attId, 'INSERT', {
      id: attId,
      studentId,
      sessionId: sessionA._id.toString(),
      classId: classA._id.toString(),
      sectionId: sectionA._id.toString(),
      date,
      status: 'present',
      remarks: 'Morning roll call',
    }, desktopDb);

    const pushRes = await engine.triggerSync();
    expect(pushRes.success).toBe(true);

    // Verify MongoDB attendance record was created
    const mongoAtt = await AttendanceRecord.findOne({
      schoolId: schoolA.schoolId,
      studentId: student._id,
    });
    expect(mongoAtt).toBeTruthy();
    expect(mongoAtt?.status).toBe('present');

    // 3. Teacher edits attendance on the WEB PORTAL via API
    const webEditRes = await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(schoolA.ownerToken))
      .set('X-Client-Version', '1.0.0')
      .send({
        sectionId: sectionA._id.toString(),
        date,
        records: [
          {
            studentId,
            status: 'absent',
            remarks: 'Parent called: sick with fever',
          },
        ],
        finalize: false,
      });
    expect(webEditRes.status).toBe(200);

    // 4. Desktop pulls remote changes
    const pullRes = await engine.triggerSync();
    expect(pullRes.success).toBe(true);
    expect(pullRes.downloadedCount).toBeGreaterThanOrEqual(1);

    // 5. Verify local SQLite attendance was updated with the teacher's web edit
    const updatedLocal = desktopDb.prepare('SELECT status, remarks FROM attendance WHERE student_id = ? AND date = ?').get(studentId, date) as any;
    expect(updatedLocal).toBeTruthy();
    expect(updatedLocal.status).toBe('absent');
    expect(updatedLocal.remarks).toBe('Parent called: sick with fever');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 22: (Item 3b) Web payment on invoice reaches desktop and updates local invoice
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 22: A web payment on an invoice reaches the desktop and updates its invoice', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_sync_3b', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // 1. Create student and invoice on backend
    const student = await Student.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      sessionId: sessionA._id,
      classId: classA._id,
      sectionId: sectionA._id,
      admissionNo: `ADM-3B-${Date.now()}`,
      firstName: 'Bilal',
      lastName: 'Ahmed',
      gender: 'male',
      dob: new Date('2014-04-04'),
      status: 'active',
    });
    const studentId = student._id.toString();

    const invoice = await Invoice.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      sessionId: sessionA._id,
      studentId: student._id,
      invoiceNo: `INV-3B-${Date.now()}`,
      amount: 5000,
      subtotal: 5000,
      total: 5000,
      paid: 0,
      balance: 5000,
      status: 'unpaid',
      month: '2026-11',
      period: '2026-11',
      issueDate: new Date('2026-11-01'),
      dueDate: new Date('2026-11-30'),
      items: [{ name: 'Tuition', amount: 5000 }],
    });
    const invoiceId = invoice._id.toString();

    // Ensure session, student, and invoice exist in desktop SQLite
    desktopDb.prepare(`
      INSERT OR IGNORE INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
      VALUES (?, ?, '2026-2027', '2026-04-01', '2027-03-31', 1)
    `).run(sessionA._id.toString(), schoolA.schoolId);

    desktopDb.prepare(`
      INSERT OR IGNORE INTO students (id, school_id, admission_number, full_name, father_name, status)
      VALUES (?, ?, ?, 'Bilal Ahmed', 'Ahmed Raza', 'active')
    `).run(studentId, schoolA.schoolId, student.admissionNo);

    desktopDb.prepare(`
      INSERT INTO invoices (id, school_id, challan_number, student_id, session_id, month, due_date, amount, paid_amount, balance, status)
      VALUES (?, ?, ?, ?, ?, '2026-11', '2026-11-30', 5000, 0, 5000, 'unpaid')
    `).run(invoiceId, schoolA.schoolId, invoice.invoiceNo, studentId, sessionA._id.toString());

    // 2. Web portal records a payment via API
    const payRes = await request(t.app)
      .post(`/api/v1/fees/invoices/${invoiceId}/payments`)
      .set(auth(schoolA.ownerToken))
      .set('X-Client-Version', '1.0.0')
      .send({
        amount: 2000,
        method: 'cash',
        reference: 'WEB-PORTAL-RECEIPT',
        idempotencyKey: `idem_web_pay_${Date.now()}`,
      });
    expect(payRes.status).toBe(201);

    // 3. Desktop pulls remote changes
    const syncRes = await engine.triggerSync();
    expect(syncRes.success).toBe(true);
    expect(syncRes.downloadedCount).toBeGreaterThanOrEqual(1);

    // 4. Verify desktop local invoice balance and payment record
    const localInv = desktopDb.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId) as any;
    expect(localInv).toBeTruthy();
    expect(localInv.paid_amount).toBe(2000);
    expect(localInv.balance).toBe(3000);
    expect(localInv.status).toBe('partially_paid');

    const localPay = desktopDb.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(invoiceId) as any;
    expect(localPay).toBeTruthy();
    expect(localPay.amount).toBe(2000);
    expect(localPay.payment_method).toBe('cash');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 23: (Item 3c) Real web delete produces a tombstone that the desktop applies
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 23: A real web delete (not a direct recordChange call) produces a tombstone that the desktop applies', async () => {
    const desktopDb = createDesktopDb(schoolA.schoolId, 'dev_sync_3c', schoolA.ownerToken);
    const apiClient = new HttpSyncApiClient(baseUrl);
    const engine = new SyncEngine(desktopDb, { apiClient });

    // 1. Create a student entered by mistake on backend
    const student = await Student.create({
      schoolId: schoolA.schoolId,
      campusId: schoolA.campusId,
      sessionId: sessionA._id,
      classId: classA._id,
      sectionId: sectionA._id,
      admissionNo: `ADM-3C-DEL-${Date.now()}`,
      firstName: 'Mistake',
      lastName: 'Entry',
      gender: 'male',
      dob: new Date('2015-01-01'),
      status: 'active',
    });
    const studentId = student._id.toString();

    // Sync student to desktop SQLite
    desktopDb.prepare(`
      INSERT INTO students (id, school_id, admission_number, full_name, father_name, status)
      VALUES (?, ?, ?, 'Mistake Entry', 'Not Specified', 'active')
    `).run(studentId, schoolA.schoolId, student.admissionNo);

    const localBefore = desktopDb.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    expect(localBefore).toBeTruthy();

    // 2. Perform a REAL web delete via HTTP API (not a direct recordChange call)
    const delRes = await request(t.app)
      .delete(`/api/v1/students/${studentId}`)
      .set(auth(schoolA.ownerToken))
      .set('X-Client-Version', '1.0.0')
      .send({
        reason: 'Duplicate entry entered by mistake',
      });
    expect(delRes.status).toBe(204);

    // Verify deleted from MongoDB
    const serverCheck = await Student.findOne({ schoolId: schoolA.schoolId, _id: studentId });
    expect(serverCheck).toBeNull();

    // 3. Desktop pulls changes and receives tombstone
    const syncRes = await engine.triggerSync();
    expect(syncRes.success).toBe(true);
    expect(syncRes.downloadedCount).toBeGreaterThanOrEqual(1);

    // 4. Verify desktop local SQLite applied tombstone (student record is removed)
    const localAfter = desktopDb.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
    expect(localAfter).toBeFalsy();
  });
});
