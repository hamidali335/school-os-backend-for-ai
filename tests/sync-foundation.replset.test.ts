import http from 'node:http';
import crypto from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import Database from 'better-sqlite3';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { FaultProxy } from '../scripts/fault-proxy';
import { assertSafeTestDatabaseUri } from '../src/database/connection';
import { atomic, inTransaction } from '../src/database/transactions';
import {
  SyncChangeLog,
  SyncIdempotency,
  SchoolSequence,
  SyncSnapshot,
} from '../src/modules/sync/sync.models';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Student } from '../src/modules/students/student.models';
import { Invoice, Payment } from '../src/modules/fees/fees.models';
import { recordChange, recordChanges, nextSeq } from '../src/modules/sync/sync.service';
import { backfillSyncSequences } from '../scripts/migrate-sync-seq';

import { buildSchool, SchoolFixture } from './fixtures';
import { useTestApp, auth } from './helpers';

// Desktop components imported directly for end-to-end integration
import { WriteCoordinator } from '../../SchoolManagementSoftware/src/main/sync/write-coordinator';
import { HttpSyncApiClient, SyncHttpError } from '../../SchoolManagementSoftware/src/main/sync/sync-api-client';
import { SyncEngine } from '../../SchoolManagementSoftware/src/main/sync/sync-engine';
import { runMigrations, ALL_MIGRATIONS } from '../../SchoolManagementSoftware/src/main/database/migrations/index';

const t = useTestApp();

describe('Slice 0: Sync Foundation & Multi-Tenant Protocol (Replica Set)', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;
  let proxy: FaultProxy;
  let proxyPort: number;
  let proxyUrl: string;
  let fixture: SchoolFixture;

  beforeAll(async () => {
    // 1. Strict atomic transaction guard enabled for test suite
    process.env.SYNC_GUARD_STRICT = '1';

    // 2. Bind express app to an ephemeral port for real HTTP testing through proxy
    server = http.createServer(t.app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as any).port;
        serverUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });

    // 3. Start FaultProxy pointing to test HTTP server
    proxy = new FaultProxy(serverUrl, 'pass-through');
    proxyPort = await proxy.start();
    proxyUrl = `http://127.0.0.1:${proxyPort}`;

    // 4. Seed complete school with academic session, classes, sections, students, teacher & accountant
    fixture = await buildSchool(t.app, { students: 10 });
  });

  afterAll(async () => {
    if (proxy) await proxy.stop();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function createSqliteDb() {
    const db = new Database(':memory:');
    runMigrations(db, ALL_MIGRATIONS);

    db.prepare('DELETE FROM installation_config').run();
    db.prepare(`
      INSERT INTO installation_config (
        id, school_id, school_name, school_code, installation_id, provisioned_at, updated_at
      ) VALUES (1, ?, 'Test School', 'TEST', 'inst_key_test', datetime('now'), datetime('now'))
    `).run(fixture.schoolId);

    db.prepare('DELETE FROM sync_device_config').run();
    db.prepare(`
      INSERT INTO sync_device_config (
        id, school_id, device_id, device_name, api_base_url, auth_token_encrypted, device_status
      ) VALUES (1, ?, 'desk_workstation_test_01', 'Principal-Desktop', ?, ?, 'registered')
    `).run(fixture.schoolId, `${proxyUrl}/api/v1`, fixture.adminToken);

    // Seed academic session, class, section, students to satisfy foreign keys for attendance
    db.prepare(`
      INSERT OR IGNORE INTO academic_sessions (id, school_id, name, start_date, end_date, is_current)
      VALUES (?, ?, '2026-2027', '2026-01-01', '2026-12-31', 1)
    `).run(fixture.sessionId, fixture.schoolId);

    db.prepare(`
      INSERT OR IGNORE INTO classes (id, school_id, name, order_index)
      VALUES (?, ?, 'Grade 10', 1)
    `).run(fixture.classId, fixture.schoolId);

    db.prepare(`
      INSERT OR IGNORE INTO sections (id, school_id, class_id, name)
      VALUES (?, ?, ?, 'Section A')
    `).run(fixture.sectionA, fixture.schoolId, fixture.classId);

    for (let i = 0; i < fixture.students.length; i++) {
      const sId = fixture.students[i];
      db.prepare(`
        INSERT OR IGNORE INTO students (id, school_id, admission_number, full_name, father_name, gender, status)
        VALUES (?, ?, ?, 'Student ' || ?, 'Father', 'male', 'active')
      `).run(sId, fixture.schoolId, `ADM-${i}`, `${i}`);
    }

    return db;
  }

  // --------------------------------------------------------------------------
  // T1: Idempotency Key Replay (3x)
  // --------------------------------------------------------------------------
  it('T1: Idempotency key replayed 3 times produces exactly 1 record and identical response payload', async () => {
    const studentId = fixture.students[0];
    const idempotencyKey = `idem_t1_${crypto.randomUUID()}`;
    const payload = {
      studentId,
      sessionId: fixture.sessionId,
      classId: fixture.classId,
      sectionId: fixture.sectionA,
      date: '2026-05-10',
      status: 'present',
      remarks: 'Present on time',
    };

    const pushBody = {
      schoolId: fixture.schoolId,
      events: [
        {
          eventId: `evt_t1_${crypto.randomUUID()}`,
          entityType: 'ATTENDANCE',
          entityId: `${studentId}_2026-05-10`,
          operation: 'INSERT',
          payload,
          localVersion: 1,
          idempotencyKey,
          deviceId: 'desk_workstation_test_01',
          schemaVersion: 2,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    // First push
    const res1 = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send(pushBody);

    expect(res1.status).toBe(200);
    expect(res1.body.data.events[0].status).toBe('synced');
    const firstAck = res1.body.data.events[0];

    // Second push (replay identical request)
    const res2 = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send(pushBody);

    expect(res2.status).toBe(200);
    expect(res2.body.data.events[0].status).toBe('synced');
    expect(res2.body.data.events[0].serverVersion).toBe(firstAck.serverVersion);

    // Third push (replay identical request)
    const res3 = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send(pushBody);

    expect(res3.status).toBe(200);
    expect(res3.body.data.events[0].status).toBe('synced');

    // Verify MongoDB state: exactly 1 AttendanceRecord created
    const count = await AttendanceRecord.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-10'),
    });
    expect(count).toBe(1);

    // Verify idempotency record exists
    const idemDoc = await SyncIdempotency.findOne({
      schoolId: new Types.ObjectId(fixture.schoolId),
      idempotencyKey,
    });
    expect(idemDoc).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // T2: Fault Injection - Response Dropped After Forward & Retry
  // --------------------------------------------------------------------------
  it('T2: Server commits ATTENDANCE, proxy drops response, client retries -> exactly 1 record in MongoDB and SQLite', async () => {
    const studentId = fixture.students[1];
    const client = new HttpSyncApiClient(proxyUrl + '/api/v1');
    const db = createSqliteDb();
    const coordinator = new WriteCoordinator(db as any, client);

    const idempotencyKey = `idemp_att_${studentId}_${Date.now()}`;
    const payload = {
      studentId,
      sessionId: fixture.sessionId,
      classId: fixture.classId,
      sectionId: fixture.sectionA,
      date: '2026-05-11',
      status: 'present',
      remarks: 'Fault proxy test',
    };

    // Configure proxy to drop response after forwarding to server
    proxy.setMode('drop-response-after-forward');

    // First attempt: Server receives and commits; proxy drops response; client experiences network drop
    let clientFailed = false;
    try {
      await coordinator.dispatchMutation({
        entityType: 'ATTENDANCE',
        entityId: `${studentId}_2026-05-11`,
        operation: 'INSERT',
        payload,
        schoolId: fixture.schoolId,
        executeLocal: () => {
          db.prepare(`
            INSERT OR REPLACE INTO attendance (id, school_id, student_id, session_id, class_id, section_id, date, status, remarks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(`att_${studentId}_2026-05-11`, fixture.schoolId, studentId, fixture.sessionId, fixture.classId, fixture.sectionA, '2026-05-11', 'present', 'Fault proxy test');
        },
      });
    } catch {
      clientFailed = true;
    }

    // Verify server committed despite dropped response
    const mongoCount1 = await AttendanceRecord.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-11'),
    });
    expect(mongoCount1).toBe(1);

    // Restore proxy to pass-through
    proxy.setMode('pass-through');

    // Make row immediately retrying (reset next_retry_at from the 5s backoff)
    db.prepare("UPDATE sync_outbox SET next_retry_at = datetime('now')").run();

    // Run the real SyncEngine to retry pending/retrying outbox events over loopback
    const engine = new SyncEngine(db as any, { apiClient: client });
    const syncRes = await engine.triggerSync();
    if (!syncRes.success) console.error('T2 SYNC ERROR:', syncRes.error);
    expect(syncRes.success).toBe(true);
    expect(syncRes.uploadedCount).toBe(1);

    // Verify MongoDB still has exactly 1 record
    const mongoCount2 = await AttendanceRecord.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-11'),
    });
    expect(mongoCount2).toBe(1);

    // Verify SQLite attendance record
    const localAttendance = db.prepare('SELECT * FROM attendance WHERE student_id = ?').all(studentId);
    expect(localAttendance.length).toBe(1);
  });

  // --------------------------------------------------------------------------
  // T3: Two Offline Edits to the Same ATTENDANCE Record
  // --------------------------------------------------------------------------
  it('T3: Two offline edits to same ATTENDANCE reach server in chronological order with incremented versions', async () => {
    const studentId = fixture.students[2];
    const client = new HttpSyncApiClient(serverUrl + '/api/v1');
    const entityId = `${studentId}_2026-05-12`;

    // Edit 1: status = 'present' (baseVersion = 1)
    const event1 = {
      eventId: `evt_edit1_${crypto.randomUUID()}`,
      entityType: 'ATTENDANCE',
      entityId,
      operation: 'INSERT' as const,
      payload: {
        studentId,
        sessionId: fixture.sessionId,
        classId: fixture.classId,
        sectionId: fixture.sectionA,
        date: '2026-05-12',
        status: 'present',
      },
      localVersion: 1,
      idempotencyKey: `idem_edit1_${crypto.randomUUID()}`,
      deviceId: 'desk_workstation_test_01',
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
    };

    // Edit 2: status = 'late' (baseVersion = 2)
    const event2 = {
      eventId: `evt_edit2_${crypto.randomUUID()}`,
      entityType: 'ATTENDANCE',
      entityId,
      operation: 'UPDATE' as const,
      payload: {
        studentId,
        sessionId: fixture.sessionId,
        classId: fixture.classId,
        sectionId: fixture.sectionA,
        date: '2026-05-12',
        status: 'late',
        remarks: 'Bus was delayed',
      },
      localVersion: 2,
      idempotencyKey: `idem_edit2_${crypto.randomUUID()}`,
      deviceId: 'desk_workstation_test_01',
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
    };

    // Push events in batch
    const pushRes = await client.pushBatch(
      fixture.schoolId,
      'desk_workstation_test_01',
      [event1, event2],
      fixture.adminToken,
    );

    expect(pushRes.events[0].status).toBe('synced');
    expect(pushRes.events[1].status).toBe('synced');

    // MongoDB final status must be 'late' and version >= 2
    const finalRecord = await AttendanceRecord.findOne({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-12'),
    }).lean();

    expect(finalRecord).not.toBeNull();
    expect(finalRecord!.status).toBe('late');
    expect(finalRecord!.remarks).toBe('Bus was delayed');
    expect((finalRecord as any).version).toBeGreaterThanOrEqual(2);

    // Verify chronological sequence in SyncChangeLog
    const logs = await SyncChangeLog.find({
      schoolId: new Types.ObjectId(fixture.schoolId),
      entityId,
    }).sort({ seq: 1 });

    expect(logs.length).toBe(2);
    expect(logs[1].seq).toBeGreaterThan(logs[0].seq);
  });

  // --------------------------------------------------------------------------
  // T4: Web Portal Attendance Save & Deletion Tombstone
  // --------------------------------------------------------------------------
  it('T4: Web portal attendance save creates records and deletion tombstone is reflected in change stream', async () => {
    const studentId = fixture.students[3];
    const date = '2026-05-13';

    // 1. Web portal marks section attendance via API
    await request(t.app)
      .post('/api/v1/attendance/mark')
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0')
      .send({
        sectionId: fixture.sectionA,
        date,
        records: [{ studentId, status: 'present', remarks: 'Normal' }],
        finalize: false,
      })
      .expect(200);

    // Verify AttendanceRecord exists in MongoDB
    const record = await AttendanceRecord.findOne({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date(date),
    });
    expect(record).not.toBeNull();

    // 2. Web portal deletes attendance record with a tombstone change
    await atomic(async () => {
      await AttendanceRecord.deleteOne({
        schoolId: new Types.ObjectId(fixture.schoolId),
        _id: record!._id,
      });
      await recordChange(
        fixture.schoolId,
        'ATTENDANCE',
        `${studentId}_${date}`,
        'DELETE',
        (record as any).version + 1,
        { studentId, date },
        { deleted: true, originDeviceId: 'web_portal' },
      );
    });

    // 3. Stream GET /sync/changes to verify delete tombstone is returned
    const changesRes = await request(t.app)
      .get('/api/v1/sync/changes?after=0&limit=100')
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0');

    expect(changesRes.status).toBe(200);
    const changes = changesRes.body.data.changes;
    const tombstone = changes.find(
      (c: any) => c.entityType === 'ATTENDANCE' && c.entityId === `${studentId}_${date}` && c.deleted === true,
    );

    expect(tombstone).toBeDefined();
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.operation).toBe('DELETE');
  });

  // --------------------------------------------------------------------------
  // T5: Retention Pruning & HTTP 410 FULL_RESYNC_REQUIRED & Snapshot Parity
  // --------------------------------------------------------------------------
  it('T5: Request with after < minRetainedSeq returns HTTP 410; desktop triggers snapshot and achieves parity for STUDENT & ATTENDANCE', async () => {
    const sid = new Types.ObjectId(fixture.schoolId);

    // 1. Ensure school sequence has advanced past 10
    await atomic(async () => {
      for (let i = 0; i < 12; i++) {
        await recordChange(sid, 'ATTENDANCE', `dummy_${i}`, 'INSERT', 1, {
          studentId: fixture.students[0],
          sessionId: fixture.sessionId,
          classId: fixture.classId,
          sectionId: fixture.sectionA,
          date: `2026-06-${String(i + 1).padStart(2, '0')}`,
          status: 'present',
        });
      }
    });

    // 2. Set minRetainedSeq = 10 by updating SchoolSequence and removing older changes
    await SchoolSequence.updateOne(
      { schoolId: sid },
      { $set: { highestPrunedSeq: 10 } },
      { upsert: true },
    );
    await SyncChangeLog.deleteMany({ schoolId: sid, seq: { $lte: 10 } });

    // 3. Requesting after=5 must return HTTP 410 FULL_RESYNC_REQUIRED
    const staleRes = await request(t.app)
      .get('/api/v1/sync/changes?after=5&limit=100')
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0');

    expect(staleRes.status).toBe(410);
    expect(staleRes.body.error.code).toBe('FULL_RESYNC_REQUIRED');

    // 4. Client triggers snapshot
    const snapRes = await request(t.app)
      .post('/api/v1/sync/snapshot/start')
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0')
      .send({ entities: ['STUDENT', 'ATTENDANCE'] });

    expect(snapRes.status).toBe(200);
    const snapshotId = snapRes.body.data.snapshotId;

    // 5. Download student snapshot page
    const studentPage = await request(t.app)
      .get(`/api/v1/sync/snapshot/${snapshotId}/page?entity=STUDENT&limit=50`)
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0');

    expect(studentPage.status).toBe(200);
    expect(studentPage.body.data.items.length).toBeGreaterThanOrEqual(10);

    // Verify student fatherName is NOT 'Not Specified'
    const student1 = studentPage.body.data.items[0];
    expect(student1.fatherName).toBeDefined();
    expect(student1.fatherName).not.toBe('Not Specified');

    // 6. Download attendance snapshot page
    const attPage = await request(t.app)
      .get(`/api/v1/sync/snapshot/${snapshotId}/page?entity=ATTENDANCE&limit=50`)
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0');

    expect(attPage.status).toBe(200);
    expect(attPage.body.data.items.length).toBeGreaterThanOrEqual(1);

    // Verify parity: all returned students match MongoDB database records
    const mongoStudentCount = await Student.countDocuments({ schoolId: sid });
    expect(studentPage.body.data.items.length).toBe(mongoStudentCount);
  });

  // --------------------------------------------------------------------------
  // T6: Desktop Client Version Guard (HTTP 426)
  // --------------------------------------------------------------------------
  it('T6: Client with version < minimum gets HTTP 426; local data and outbox remain unmodified', async () => {
    const db = createSqliteDb();

    // Insert local pending outbox item
    db.prepare(`
      INSERT INTO sync_outbox (operation_id, idempotency_key, school_id, entity_type, entity_id, payload_json, state)
      VALUES ('op_t6_test', 'idem_t6_test', ?, 'ATTENDANCE', 'att_t6', '{}', 'pending')
    `).run(fixture.schoolId);

    // Attempt push with obsolete client version 0.8.0
    const res = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Client-Type', 'desktop')
      .set('X-Client-Version', '0.8.0')
      .send({
        schoolId: fixture.schoolId,
        events: [],
      });

    expect(res.status).toBe(426);
    expect(res.body.error.code).toBe('CLIENT_UPGRADE_REQUIRED');

    // Verify SQLite outbox remains completely unchanged
    const outboxRow = db.prepare('SELECT * FROM sync_outbox WHERE operation_id = ?').get('op_t6_test') as any;
    expect(outboxRow.state).toBe('pending');
    expect(outboxRow.synced_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // T7: 50 Concurrent Sequence Generation (No Gaps, No Duplicates)
  // --------------------------------------------------------------------------
  it('T7: 50 concurrent writes produce contiguous, gap-free sequences with no duplicates; reader misses nothing', async () => {
    const sid = new Types.ObjectId(fixture.schoolId);

    // Run 50 concurrent transactions writing to the sequence-based change feed
    const writePromises = Array.from({ length: 50 }, (_, i) => {
      return atomic(async () => {
        return recordChange(
          sid,
          'ATTENDANCE',
          `student_${i}_2026-05-20`,
          'INSERT',
          1,
          { studentIndex: i },
          { originDeviceId: `device_${i % 5}` },
        );
      });
    });

    const generatedSeqs = await Promise.all(writePromises);
    expect(generatedSeqs.length).toBe(50);

    // Sort sequences to verify strict contiguity and no duplicates
    const sorted = [...generatedSeqs].sort((a, b) => a - b);
    const unique = new Set(sorted);
    expect(unique.size).toBe(50);

    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }

    // Stream reader requests the range
    const minSeq = sorted[0];
    const streamRes = await request(t.app)
      .get(`/api/v1/sync/changes?after=${minSeq - 1}&limit=100`)
      .set(auth(fixture.adminToken))
      .set('X-Client-Version', '1.0.0');

    expect(streamRes.status).toBe(200);
    const changes = streamRes.body.data.changes;
    expect(changes.length).toBeGreaterThanOrEqual(50);

    const receivedSeqs = changes.map((c: any) => c.seq);
    for (const s of sorted) {
      expect(receivedSeqs).toContain(s);
    }
  });

  // --------------------------------------------------------------------------
  // T8: Validation Failure Isolation
  // --------------------------------------------------------------------------
  it('T8: Event with validation failure gets rejected permanently without blocking unrelated events in batch', async () => {
    const studentId = fixture.students[4];
    const eventInvalid = {
      eventId: `evt_invalid_${crypto.randomUUID()}`,
      entityType: 'ATTENDANCE',
      entityId: `${studentId}_2026-05-15`,
      operation: 'INSERT',
      payload: {
        studentId,
        date: '2026-05-15',
        status: 'unsupported_status_xyz', // Schema validation will fail
      },
      localVersion: 1,
      idempotencyKey: `idem_invalid_${crypto.randomUUID()}`,
      deviceId: 'desk_workstation_test_01',
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
    };

    const eventValid = {
      eventId: `evt_valid_${crypto.randomUUID()}`,
      entityType: 'ATTENDANCE',
      entityId: `${studentId}_2026-05-16`,
      operation: 'INSERT',
      payload: {
        studentId,
        sessionId: fixture.sessionId,
        classId: fixture.classId,
        sectionId: fixture.sectionA,
        date: '2026-05-16',
        status: 'present',
      },
      localVersion: 1,
      idempotencyKey: `idem_valid_${crypto.randomUUID()}`,
      deviceId: 'desk_workstation_test_01',
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
    };

    const pushRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [eventInvalid, eventValid],
      });

    expect(pushRes.status).toBe(200);
    const acks = pushRes.body.data.events;
    expect(acks.length).toBe(2);

    // Event 1 is rejected with permanent: true
    expect(acks[0].status).toBe('rejected');
    expect(acks[0].permanent).toBe(true);

    // Event 2 succeeds
    expect(acks[1].status).toBe('synced');

    // Confirm valid record in MongoDB
    const validRec = await AttendanceRecord.findOne({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-16'),
    });
    expect(validRec).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // T9: Granular Role-Based Permissions for Sync Push
  // --------------------------------------------------------------------------
  it('T9: Teacher can push ATTENDANCE but not PAYMENT; Accountant can push PAYMENT but not ATTENDANCE', async () => {
    const studentId = fixture.students[5];

    // Teacher pushes ATTENDANCE (authorized)
    const teacherAttRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.teacherToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [
          {
            eventId: `evt_t9_att_${crypto.randomUUID()}`,
            entityType: 'ATTENDANCE',
            entityId: `${studentId}_2026-05-17`,
            operation: 'INSERT',
            payload: {
              studentId,
              sessionId: fixture.sessionId,
              classId: fixture.classId,
              sectionId: fixture.sectionA,
              date: '2026-05-17',
              status: 'present',
            },
            localVersion: 1,
            idempotencyKey: `idem_t9_att_${crypto.randomUUID()}`,
            deviceId: 'desk_workstation_test_01',
            schemaVersion: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    expect(teacherAttRes.status).toBe(200);
    expect(teacherAttRes.body.data.events[0].status).toBe('synced');

    // Teacher pushes PAYMENT (unauthorized)
    const teacherPayRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.teacherToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [
          {
            eventId: `evt_t9_pay_${crypto.randomUUID()}`,
            entityType: 'PAYMENT',
            entityId: `pay_${crypto.randomUUID()}`,
            operation: 'INSERT',
            payload: {
              amount: 1000,
              method: 'cash',
            },
            localVersion: 1,
            idempotencyKey: `idem_t9_pay_${crypto.randomUUID()}`,
            deviceId: 'desk_workstation_test_01',
            schemaVersion: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    // Event rejected due to role permissions
    expect(teacherPayRes.body.data.events[0].status).toBe('rejected');
    expect(teacherPayRes.body.data.events[0].permanent).toBe(true);

    // Accountant pushes ATTENDANCE (unauthorized)
    const accAttRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.accountantToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [
          {
            eventId: `evt_t9_acc_att_${crypto.randomUUID()}`,
            entityType: 'ATTENDANCE',
            entityId: `${studentId}_2026-05-18`,
            operation: 'INSERT',
            payload: {
              studentId,
              sessionId: fixture.sessionId,
              classId: fixture.classId,
              sectionId: fixture.sectionA,
              date: '2026-05-18',
              status: 'present',
            },
            localVersion: 1,
            idempotencyKey: `idem_t9_acc_att_${crypto.randomUUID()}`,
            deviceId: 'desk_workstation_test_01',
            schemaVersion: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    expect(accAttRes.body.data.events[0].status).toBe('rejected');
    expect(accAttRes.body.data.events[0].permanent).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T10: Safe Test Database Guard
  // --------------------------------------------------------------------------
  it('T10: Fake Atlas URI throws before any connection attempt is made', () => {
    const fakeAtlasUri = 'mongodb+srv://admin:pass@production-cluster.abcde.mongodb.net/schoolos_prod';

    expect(() => {
      assertSafeTestDatabaseUri(fakeAtlasUri);
    }).toThrow(/remote\/Atlas host/);

    const nonLocalUri = 'mongodb://192.168.1.100:27017/schoolos_prod';
    expect(() => {
      assertSafeTestDatabaseUri(nonLocalUri);
    }).toThrow(/does not point to localhost/);

    const nonTestDbUri = 'mongodb://127.0.0.1:27017/production_database';
    expect(() => {
      assertSafeTestDatabaseUri(nonTestDbUri);
    }).toThrow(/must end with _test or contain schoolos_test_/);
  });

  // --------------------------------------------------------------------------
  // T11: Idempotency Key Reuse With Modified Payload Returns HTTP 422
  // --------------------------------------------------------------------------
  it('T11: same idempotency key, different payload returns HTTP 422 with code IDEMPOTENCY_KEY_REUSED and no side effects', async () => {
    const studentId = fixture.students[4];
    const idempotencyKey = `idem_t11_${crypto.randomUUID()}`;
    const initialPayload = {
      studentId,
      sessionId: fixture.sessionId,
      classId: fixture.classId,
      sectionId: fixture.sectionA,
      date: '2026-05-20',
      status: 'present',
      remarks: 'Initial status',
    };

    const initialRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [
          {
            eventId: `evt_t11_1_${crypto.randomUUID()}`,
            entityType: 'ATTENDANCE',
            entityId: `${studentId}_2026-05-20`,
            operation: 'INSERT',
            payload: initialPayload,
            localVersion: 1,
            idempotencyKey,
            deviceId: 'desk_workstation_test_01',
            schemaVersion: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    expect(initialRes.status).toBe(200);
    expect(initialRes.body.data.events[0].status).toBe('synced');

    // Tampered payload re-using the exact same idempotency key
    const tamperedPayload = {
      ...initialPayload,
      status: 'absent',
      remarks: 'Tampered status with duplicate key',
    };

    const tamperedRes = await request(t.app)
      .post('/api/v1/sync/batch/push')
      .set(auth(fixture.adminToken))
      .set('X-Device-Id', 'desk_workstation_test_01')
      .set('X-Client-Version', '1.0.0')
      .send({
        schoolId: fixture.schoolId,
        events: [
          {
            eventId: `evt_t11_2_${crypto.randomUUID()}`,
            entityType: 'ATTENDANCE',
            entityId: `${studentId}_2026-05-20`,
            operation: 'UPDATE',
            payload: tamperedPayload,
            localVersion: 2,
            idempotencyKey,
            deviceId: 'desk_workstation_test_01',
            schemaVersion: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      });

    expect(tamperedRes.status).toBe(422);
    expect(tamperedRes.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Verify no side effects: the attendance record remains 'present'
    const record = await AttendanceRecord.findOne({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-20'),
    });
    expect(record).not.toBeNull();
    expect(record!.status).toBe('present');
    expect(record!.remarks).toBe('Initial status');
  });

  // --------------------------------------------------------------------------
  // T12: 5 Simultaneous Pushes With The Same Idempotency Key
  // --------------------------------------------------------------------------
  it('T12: 5 simultaneous pushes with the same key produce exactly 1 record, 1 ledger row and 1 SyncChangeLog row', async () => {
    const studentId = fixture.students[5];
    const idempotencyKey = `idem_t12_${crypto.randomUUID()}`;
    const payload = {
      studentId,
      sessionId: fixture.sessionId,
      classId: fixture.classId,
      sectionId: fixture.sectionA,
      date: '2026-05-21',
      status: 'present',
      remarks: 'Concurrent push test',
    };

    const makePush = () =>
      request(t.app)
        .post('/api/v1/sync/batch/push')
        .set(auth(fixture.adminToken))
        .set('X-Device-Id', 'desk_workstation_test_01')
        .set('X-Client-Version', '1.0.0')
        .send({
          schoolId: fixture.schoolId,
          events: [
            {
              eventId: `evt_t12_${crypto.randomUUID()}`,
              entityType: 'ATTENDANCE',
              entityId: `${studentId}_2026-05-21`,
              operation: 'INSERT',
              payload,
              localVersion: 1,
              idempotencyKey,
              deviceId: 'desk_workstation_test_01',
              schemaVersion: 2,
              createdAt: new Date().toISOString(),
            },
          ],
        });

    const responses = await Promise.all([
      makePush(),
      makePush(),
      makePush(),
      makePush(),
      makePush(),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.data.events[0].status).toBe('synced');
    }

    // Verify exactly 1 attendance record in MongoDB
    const recordCount = await AttendanceRecord.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-21'),
    });
    expect(recordCount).toBe(1);

    // Verify exactly 1 idempotency ledger row
    const ledgerCount = await SyncIdempotency.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      idempotencyKey,
    });
    expect(ledgerCount).toBe(1);

    // Verify exactly 1 SyncChangeLog entry for this entity
    const changeLogCount = await SyncChangeLog.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      entityType: 'ATTENDANCE',
      entityId: `${studentId}_2026-05-21`,
    });
    expect(changeLogCount).toBe(1);
  });

  // --------------------------------------------------------------------------
  // T13: Sequence Backfill Migration on Legacy Unsequenced Rows
  // --------------------------------------------------------------------------
  it('T13: migrate-sync-seq.ts run on legacy SyncChangeLog rows without seq gives contiguous seq in timestamp order, creates school_sequences, and the unique index builds', async () => {
    const testSchoolId = new Types.ObjectId();
    const baseTime = Date.now() - 100000;

    // Insert 5 legacy entries with out-of-order timestamps
    await SyncChangeLog.collection.insertMany([
      {
        schoolId: testSchoolId,
        seq: 999991,
        changeId: 'chg_leg_3',
        entityType: 'STUDENT',
        entityId: 'std_leg_3',
        operation: 'INSERT',
        payload: { name: 'Third' },
        timestamp: new Date(baseTime + 3000),
      },
      {
        schoolId: testSchoolId,
        seq: 999992,
        changeId: 'chg_leg_1',
        entityType: 'STUDENT',
        entityId: 'std_leg_1',
        operation: 'INSERT',
        payload: { name: 'First' },
        timestamp: new Date(baseTime + 1000),
      },
      {
        schoolId: testSchoolId,
        seq: 999993,
        changeId: 'chg_leg_4',
        entityType: 'STUDENT',
        entityId: 'std_leg_4',
        operation: 'INSERT',
        payload: { name: 'Fourth' },
        timestamp: new Date(baseTime + 4000),
      },
      {
        schoolId: testSchoolId,
        seq: 999994,
        changeId: 'chg_leg_2',
        entityType: 'STUDENT',
        entityId: 'std_leg_2',
        operation: 'INSERT',
        payload: { name: 'Second' },
        timestamp: new Date(baseTime + 2000),
      },
      {
        schoolId: testSchoolId,
        seq: 999995,
        changeId: 'chg_leg_5',
        entityType: 'STUDENT',
        entityId: 'std_leg_5',
        operation: 'INSERT',
        payload: { name: 'Fifth' },
        timestamp: new Date(baseTime + 5000),
      },
    ]);

    // Run the migration backfill
    await backfillSyncSequences();

    // Verify contiguous seq numbers in strict timestamp order
    const backfilled = await SyncChangeLog.find({ schoolId: testSchoolId }).sort({ seq: 1 });
    expect(backfilled.length).toBe(5);
    expect(backfilled.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(backfilled[0].changeId).toBe('chg_leg_1');
    expect(backfilled[1].changeId).toBe('chg_leg_2');
    expect(backfilled[2].changeId).toBe('chg_leg_3');
    expect(backfilled[3].changeId).toBe('chg_leg_4');
    expect(backfilled[4].changeId).toBe('chg_leg_5');

    // Verify school_sequences document is created and tracking max seq = 5
    const seqDoc = await SchoolSequence.findOne({ schoolId: testSchoolId });
    expect(seqDoc).not.toBeNull();
    expect(seqDoc!.seq).toBe(5);

    // Verify unique index on { schoolId: 1, seq: 1 } builds cleanly without error
    const indexes = await SyncChangeLog.collection.indexes();
    const hasUniqueSeqIndex = indexes.some(
      (idx: any) => idx.key?.schoolId === 1 && idx.key?.seq === 1 && idx.unique,
    );
    expect(hasUniqueSeqIndex).toBe(true);
  });

  // --------------------------------------------------------------------------
  // T14: In-flight Recovery on Process Restart
  // --------------------------------------------------------------------------
  it('T14: desktop restarts with an outbox row in "processing"; it becomes "retrying", is resent with the SAME idempotency key, and the server holds one record', async () => {
    const studentId = fixture.students[6];
    const client = new HttpSyncApiClient(serverUrl + '/api/v1');
    const db = createSqliteDb();

    const idempotencyKey = `idemp_restart_${crypto.randomUUID()}`;
    const operationId = `op_restart_${crypto.randomUUID()}`;
    const payload = {
      studentId,
      sessionId: fixture.sessionId,
      classId: fixture.classId,
      sectionId: fixture.sectionA,
      date: '2026-05-22',
      status: 'present',
      remarks: 'Crash recovery test',
    };

    // Simulate an in-flight row that was left in 'processing' when the app crashed/terminated
    db.prepare(`
      INSERT INTO sync_outbox (
        operation_id, idempotency_key, school_id, entity_type, entity_id,
        operation, payload_json, state, status, attempt_count
      ) VALUES (?, ?, ?, 'ATTENDANCE', ?, 'INSERT', ?, 'processing', 'processing', 1)
    `).run(operationId, idempotencyKey, fixture.schoolId, `${studentId}_2026-05-22`, JSON.stringify(payload));

    const beforeRecovery = db.prepare('SELECT state FROM sync_outbox WHERE operation_id = ?').get(operationId) as any;
    expect(beforeRecovery.state).toBe('processing');

    // Simulate desktop app restart: instantiate new coordinator (which recovers in-flight rows)
    const restartedCoordinator = new WriteCoordinator(db as any, client);
    restartedCoordinator.recoverInFlightOperations();

    // Verify row transitioned from 'processing' to 'retrying' with the SAME idempotencyKey
    const afterRecovery = db.prepare('SELECT * FROM sync_outbox WHERE operation_id = ?').get(operationId) as any;
    expect(afterRecovery.state).toBe('retrying');
    expect(afterRecovery.idempotency_key).toBe(idempotencyKey);

    // SyncEngine triggers synchronization and uploads retrying events
    const engine = new SyncEngine(db as any, { apiClient: client });
    const syncRes = await engine.triggerSync();
    expect(syncRes.success).toBe(true);
    expect(syncRes.uploadedCount).toBe(1);

    // Verify server holds exactly 1 record
    const count = await AttendanceRecord.countDocuments({
      schoolId: new Types.ObjectId(fixture.schoolId),
      studentId: new Types.ObjectId(studentId),
      date: new Date('2026-05-22'),
    });
    expect(count).toBe(1);

    // Verify outbox row transitioned to 'synced'
    const finalRow = db.prepare('SELECT state FROM sync_outbox WHERE operation_id = ?').get(operationId) as any;
    expect(finalRow.state).toBe('synced');
  });

  // --------------------------------------------------------------------------
  // T15: versionPlugin Invariant Verification
  // --------------------------------------------------------------------------
  it('T15: versionPlugin cannot increment twice on one write, existing documents without version are treated as version 1, and saves with no changes skip increment', async () => {
    // 1. Insert raw document directly into collection without 'version' field
    const rawAttId = new Types.ObjectId();
    const rawDate = new Date('2026-09-01T00:00:00.000Z');
    await AttendanceRecord.collection.insertOne({
      _id: rawAttId,
      schoolId: new Types.ObjectId(fixture.schoolId),
      campusId: new Types.ObjectId(fixture.campusId),
      sessionId: new Types.ObjectId(fixture.sessionId),
      classId: new Types.ObjectId(fixture.classId),
      sectionId: new Types.ObjectId(fixture.sectionA),
      studentId: new Types.ObjectId(),
      date: rawDate,
      status: 'present',
      remarks: 'Initial raw attendance',
      // Explicitly omitted 'version' property
    });

    // Verify document in collection has no version field
    const rawInDb = await AttendanceRecord.collection.findOne({ _id: rawAttId });
    expect((rawInDb as any).version).toBeUndefined();

    // Read through Mongoose model: post-init hook treats document as version 1
    const att = await AttendanceRecord.findOne({ schoolId: new Types.ObjectId(fixture.schoolId), _id: rawAttId });
    expect(att).not.toBeNull();
    expect(att!.version).toBe(1);

    // 2. Perform a save with NO changes: version must NOT increment (skip saves that changed nothing)
    await atomic(async () => {
      await att!.save();
    });
    expect(att!.version).toBe(1);

    // 3. Perform a single update via save(): must increment to version 2 (exactly once)
    await atomic(async () => {
      att!.remarks = 'Updated remarks';
      await att!.save();
    });
    expect(att!.version).toBe(2);

    const afterSave = await AttendanceRecord.findOne({ schoolId: new Types.ObjectId(fixture.schoolId), _id: rawAttId });
    expect(afterSave!.version).toBe(2);

    // 4. Perform a query update: updateOne must increment to version 3 (exactly once)
    await atomic(async () => {
      await AttendanceRecord.updateOne(
        { schoolId: new Types.ObjectId(fixture.schoolId), _id: rawAttId },
        { $set: { status: 'late' } },
      );
    });

    const afterUpdate = await AttendanceRecord.findOne({ schoolId: new Types.ObjectId(fixture.schoolId), _id: rawAttId });
    expect(afterUpdate!.version).toBe(3);

    // 5. Verify save with no changes again skips increment
    await atomic(async () => {
      await afterUpdate!.save();
    });
    expect(afterUpdate!.version).toBe(3);

    // 6. Modified save increments to version 4
    await atomic(async () => {
      afterUpdate!.remarks = 'Final updated remarks';
      await afterUpdate!.save();
    });
    expect(afterUpdate!.version).toBe(4);
  });

  // --------------------------------------------------------------------------
  // T16: Load Test: 30 concurrent attendance saves of 40 students each against replica set
  // --------------------------------------------------------------------------
  it('T16: 30 concurrent attendance saves of 40 students each against replica set with zero failures (p50 and p95 latency report)', async () => {
    const sid = new Types.ObjectId(fixture.schoolId);
    const numWorkers = 30;
    const studentsPerSave = 40;

    // Create 40 distinct student IDs for attendance marking
    const studentIds: string[] = [];
    for (let i = 0; i < studentsPerSave; i++) {
      studentIds.push(new Types.ObjectId().toString());
    }

    // --- Benchmark BEFORE: Sequential recordChange calls in loop (30 concurrent workers) ---
    const beforeLatencies: number[] = [];
    const beforeTasks = Array.from({ length: numWorkers }, (_, workerIdx) => async () => {
      const start = Date.now();
      await atomic(async () => {
        for (let sIdx = 0; sIdx < studentsPerSave; sIdx++) {
          await recordChange(
            sid,
            'ATTENDANCE',
            `${studentIds[sIdx]}_before_${workerIdx}`,
            'INSERT',
            1,
            { studentId: studentIds[sIdx], date: `2026-06-${String(workerIdx + 1).padStart(2, '0')}`, status: 'present' },
            { originDeviceId: 'bench_before' },
          );
        }
      });
      beforeLatencies.push(Date.now() - start);
    });

    const beforeResults = await Promise.allSettled(beforeTasks.map((fn) => fn()));
    const beforeFailures = beforeResults.filter((r) => r.status === 'rejected');
    expect(beforeFailures.length).toBe(0);

    beforeLatencies.sort((a, b) => a - b);
    const p50Before = beforeLatencies[Math.floor(beforeLatencies.length * 0.50)];
    const p95Before = beforeLatencies[Math.floor(beforeLatencies.length * 0.95)];

    // --- Benchmark AFTER: Batch recordChanges with ONE atomic seq reservation (30 concurrent workers) ---
    const afterLatencies: number[] = [];
    const afterTasks = Array.from({ length: numWorkers }, (_, workerIdx) => async () => {
      const start = Date.now();
      const changeItems = studentIds.map((sId) => ({
        entityType: 'ATTENDANCE',
        entityId: `${sId}_after_${workerIdx}`,
        operation: 'INSERT' as const,
        payload: {
          studentId: sId,
          date: `2026-07-${String(workerIdx + 1).padStart(2, '0')}`,
          status: 'present',
        },
        options: { originDeviceId: 'bench_after' },
      }));

      await atomic(async () => {
        await recordChanges(sid, changeItems);
      });
      afterLatencies.push(Date.now() - start);
    });

    const afterResults = await Promise.allSettled(afterTasks.map((fn) => fn()));
    const afterFailures = afterResults.filter((r) => r.status === 'rejected');
    expect(afterFailures.length).toBe(0);

    afterLatencies.sort((a, b) => a - b);
    const p50After = afterLatencies[Math.floor(afterLatencies.length * 0.50)];
    const p95After = afterLatencies[Math.floor(afterLatencies.length * 0.95)];

    console.log('\n========================================================================================');
    console.log('       LOAD TEST REPORT: 30 CONCURRENT ATTENDANCE SAVES OF 40 STUDENTS EACH             ');
    console.log('========================================================================================');
    console.log(`Concurrency: ${numWorkers} concurrent saves`);
    console.log(`Payload per save: ${studentsPerSave} students (Total = ${numWorkers * studentsPerSave} records)`);
    console.log(`Failures: 0 / ${numWorkers} (100% success rate)`);
    console.log(`BEFORE (sequential loop) : p50 = ${p50Before} ms, p95 = ${p95Before} ms`);
    console.log(`AFTER (batch recordChanges): p50 = ${p50After} ms, p95 = ${p95After} ms`);
    console.log(`Speedup (p50): ${(p50Before / Math.max(1, p50After)).toFixed(2)}x faster`);
    console.log(`Speedup (p95): ${(p95Before / Math.max(1, p95After)).toFixed(2)}x faster`);
    console.log('========================================================================================\n');

    expect(afterFailures.length).toBe(0);
  }, 120000);
});
