import crypto from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../utils/errors';
import { issueRefreshToken, signSchoolAccessToken } from '../auth/tokens';
import { atomic, inTransaction, transactionsSupported } from '../../database/transactions';
import { ROLE_PERMISSIONS } from '../../config/permissions';
import { Campus } from '../campuses/campus.model';
import { AcademicSession, SchoolClass, Section } from '../academics/academics.models';
import { Parent, Student, StudentEnrollment } from '../students/student.models';
import { AttendanceRecord } from '../attendance/attendance.model';
import { FeeStructure, Invoice, Payment } from '../fees/fees.models';
import { Employee, Payslip } from '../employees/employee.model';
import { Exam, ExamPaper, Mark } from '../examinations/exam.models';
import { Expense } from '../accounts/accounts.models';
import {
  SchoolSequence,
  SyncChangeLog,
  SyncConflict,
  SyncDevice,
  SyncEntityMapping,
  SyncIdempotency,
  SyncSnapshot,
} from './sync.models';
import type {
  DeviceRegisterRequest,
  DeviceRegisterResponse,
  RemoteChangeItem,
  ResolveConflictRequest,
  SnapshotPageQuery,
  SnapshotPageResponse,
  StartSnapshotResponse,
  SyncChangesQuery,
  SyncChangesResponse,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushEvent,
  SyncPushEventAck,
  SyncPushRequest,
  SyncPushResponse,
} from './sync.schemas';

type Ctx = SchoolContext;

/**
 * Atomically increments and returns the next sequence number for the given school.
 * Must run inside an active MongoDB transaction session.
 */
export async function nextSeq(
  session: mongoose.ClientSession | undefined,
  schoolId: Types.ObjectId | string,
): Promise<number> {
  const sid = typeof schoolId === 'string' ? new Types.ObjectId(schoolId) : schoolId;
  const doc = await SchoolSequence.findOneAndUpdate(
    { schoolId: sid },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  );
  return doc.seq;
}

/**
 * Atomically increments and reserves a contiguous block of sequence numbers of size `count`
 * for the given school using ONE atomic increment.
 */
export async function reserveSeqs(
  session: mongoose.ClientSession | undefined,
  schoolId: Types.ObjectId | string,
  count: number,
): Promise<{ startSeq: number; endSeq: number }> {
  if (count <= 0) return { startSeq: 0, endSeq: 0 };
  const sid = typeof schoolId === 'string' ? new Types.ObjectId(schoolId) : schoolId;
  const doc = await SchoolSequence.findOneAndUpdate(
    { schoolId: sid },
    { $inc: { seq: count } },
    { upsert: true, returnDocument: 'after', session },
  );
  const endSeq = doc.seq;
  const startSeq = endSeq - count + 1;
  return { startSeq, endSeq };
}

export interface RecordChangeItem {
  entityType: string;
  entityId: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  payload: any;
  options?: {
    deleted?: boolean;
    actorId?: any;
    visibleToRoles?: string[];
    originDeviceId?: string;
  };
}

/**
 * Records multiple change events in the sequence-based sync change journal in one call.
 * Strictly reserves a contiguous batch of sequences with ONE atomic increment,
 * and bulk-inserts all change records into SyncChangeLog.
 */
export async function recordChanges(
  schoolId: Types.ObjectId | string,
  items: RecordChangeItem[],
): Promise<number[]> {
  if (!items.length) return [];

  if (!inTransaction()) {
    if (transactionsSupported() || process.env.SYNC_GUARD_STRICT === '1') {
      throw new Error('recordChanges requires an active MongoDB transaction (must be inside atomic())');
    }
  }

  const session = (mongoose as any).transactionAsyncLocalStorage?.getStore()?.session;
  const sid = typeof schoolId === 'string' ? new Types.ObjectId(schoolId) : schoolId;
  const { startSeq } = await reserveSeqs(session, sid, items.length);

  const now = new Date();
  const docs = items.map((item, index) => {
    const seq = startSeq + index;
    const changeId = `chg_${seq}_${crypto.randomUUID().slice(0, 8)}`;
    return {
      schoolId: sid,
      seq,
      version: seq,
      deleted: Boolean(item.options?.deleted || item.operation === 'DELETE'),
      actorId: item.options?.actorId,
      visibleToRoles: item.options?.visibleToRoles || [],
      changeId,
      entityType: item.entityType,
      entityId: item.entityId,
      operation: item.operation,
      payload: item.payload,
      remoteVersion: seq,
      originDeviceId: item.options?.originDeviceId || 'web_portal',
      timestamp: now,
    };
  });

  await SyncChangeLog.insertMany(docs, { session });
  return docs.map((d) => d.seq);
}

/**
 * Records a single change event in the sequence-based sync change journal.
 * STRICT REQUIREMENT: Must be called inside an active MongoDB transaction.
 * THROWS on any failure or if called outside a transaction.
 */
export async function recordChange(
  schoolId: Types.ObjectId | string,
  entityType: string,
  entityId: string,
  operation: 'INSERT' | 'UPDATE' | 'DELETE',
  remoteVersion: number,
  payload: any,
  options?: {
    deleted?: boolean;
    actorId?: any;
    visibleToRoles?: string[];
    originDeviceId?: string;
  },
): Promise<number> {
  const [seq] = await recordChanges(schoolId, [
    {
      entityType,
      entityId,
      operation,
      payload,
      options,
    },
  ]);
  return seq;
}

export const recordServerChange = recordChange;

/**
 * Role-based Event Authorization for Push Batches
 */
function checkEventPermission(role: string, entityType: string): boolean {
  if (role === 'school_owner' || role === 'principal' || role === 'school_admin') {
    return true;
  }
  if (entityType === 'ATTENDANCE') {
    return (ROLE_PERMISSIONS as any)[role]?.has('sync:push:attendance') ?? false;
  }
  if (entityType === 'PAYMENT' || entityType === 'INVOICE') {
    return (ROLE_PERMISSIONS as any)[role]?.has('sync:push:payments') ?? false;
  }
  return false;
}

/**
 * Ensures a valid Campus ID exists for school-scoped tenant entities.
 */
async function resolveCampusId(schoolId: Types.ObjectId | string, candidateId?: any): Promise<Types.ObjectId> {
  const sid = new Types.ObjectId(schoolId.toString());
  if (candidateId && Types.ObjectId.isValid(candidateId)) {
    const campus = await Campus.findOne({ schoolId: sid, _id: new Types.ObjectId(candidateId) }).select('_id').lean();
    if (campus) return campus._id as Types.ObjectId;
  }
  const mainCampus = await Campus.findOne({ schoolId: sid, isMain: true }).select('_id').lean();
  if (mainCampus) return mainCampus._id as Types.ObjectId;

  const anyCampus = await Campus.findOne({ schoolId: sid }).select('_id').lean();
  if (anyCampus) return anyCampus._id as Types.ObjectId;

  const created = await Campus.create({
    schoolId: sid,
    name: 'Main Campus',
    code: 'MAIN',
    isMain: true,
    status: 'active',
  });
  return created._id as Types.ObjectId;
}

/**
 * Batch Push Processor (Client -> Server)
 * Guarantees atomicity per event, SHA-256 idempotency fingerprinting,
 * role authorization, and authoritative server versions.
 */
export async function pushBatch(
  ctx: Ctx,
  body: SyncPushRequest,
  deviceIdHeader?: string,
): Promise<SyncPushResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);

  if (body.schoolId && body.schoolId !== ctx.schoolId) {
    throw forbidden('Tenant isolation violation: Client cannot push events for another school tenant');
  }

  if (deviceIdHeader) {
    await SyncDevice.updateOne(
      { schoolId, deviceId: deviceIdHeader },
      { $set: { lastSeenAt: new Date() } },
    ).catch(() => {});
  }

  const acks: SyncPushEventAck[] = [];
  let acknowledgedCount = 0;
  let failedCount = 0;
  let conflictCount = 0;

  for (const event of body.events) {
    const payloadStr = JSON.stringify(event.payload || {});
    const fingerprint = crypto.createHash('sha256').update(payloadStr).digest('hex');

    // 1. Check Event Authorization by Entity Type
    if (!checkEventPermission(ctx.role, event.entityType)) {
      const rejAck: SyncPushEventAck = {
        eventId: event.eventId,
        entityId: event.entityId,
        status: 'rejected',
        permanent: true,
        errorCode: 'FORBIDDEN',
        errorMessage: `Role "${ctx.role}" is not authorized to push ${event.entityType} mutations`,
      };

      // Record in idempotency in a separate transaction so replay returns the same rejection
      await atomic(async () => {
        await SyncIdempotency.create({
          schoolId,
          idempotencyKey: event.idempotencyKey,
          eventId: event.eventId,
          entityType: event.entityType,
          entityId: event.entityId,
          status: 'rejected',
          permanent: true,
          errorCode: 'FORBIDDEN',
          errorMessage: rejAck.errorMessage,
          payloadFingerprint: fingerprint,
          responsePayload: rejAck,
        });
      }).catch(() => {});

      acks.push(rejAck);
      failedCount++;
      continue;
    }

    // 2. Idempotency Check
    const existing = await SyncIdempotency.findOne({
      schoolId,
      idempotencyKey: event.idempotencyKey,
    }).lean();

    if (existing) {
      if (existing.payloadFingerprint && existing.payloadFingerprint !== fingerprint) {
        throw new AppError(
          422,
          'IDEMPOTENCY_KEY_REUSED',
          `Idempotency key "${event.idempotencyKey}" replayed with a different payload fingerprint`,
        );
      }

      const cachedAck = (existing.responsePayload as SyncPushEventAck) || {
        eventId: event.eventId,
        entityId: event.entityId,
        status: existing.status as any,
        serverVersion: existing.serverVersion,
        permanent: existing.permanent,
        errorCode: existing.errorCode,
        errorMessage: existing.errorMessage,
      };

      acks.push(cachedAck);
      if (cachedAck.status === 'synced') acknowledgedCount++;
      else if (cachedAck.status === 'conflict') conflictCount++;
      else failedCount++;
      continue;
    }

    // 3. Process Domain Write in an isolated atomic transaction
    try {
      const ack = await atomic(async () => {
        const domainAck = await processDomainEvent(schoolId, ctx.userId, event, deviceIdHeader);
        await SyncIdempotency.create({
          schoolId,
          idempotencyKey: event.idempotencyKey,
          eventId: event.eventId,
          entityType: event.entityType,
          entityId: event.entityId,
          serverVersion: domainAck.serverVersion || 1,
          status: domainAck.status,
          payloadFingerprint: fingerprint,
          responsePayload: domainAck,
          permanent: domainAck.permanent || false,
          errorCode: domainAck.errorCode,
          errorMessage: domainAck.errorMessage,
        });
        return domainAck;
      });

      acks.push(ack);
      if (ack.status === 'synced') acknowledgedCount++;
      else if (ack.status === 'conflict') conflictCount++;
      else failedCount++;
    } catch (err: any) {
      // Duplicate-key error indicates concurrent request won the race
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        const winning = await atomic(async () =>
          SyncIdempotency.findOne({ schoolId, idempotencyKey: event.idempotencyKey }).lean(),
        );
        if (winning) {
          const cached = (winning.responsePayload as SyncPushEventAck) || {
            eventId: event.eventId,
            entityId: event.entityId,
            status: winning.status as any,
            serverVersion: winning.serverVersion,
          };
          acks.push(cached);
          if (cached.status === 'synced') acknowledgedCount++;
          else if (cached.status === 'conflict') conflictCount++;
          else failedCount++;
          continue;
        }
      }

      // Check for business rule or validation rejection
      const isValidationOrBusiness =
        err.status === 400 ||
        err.statusCode === 400 ||
        err.status === 422 ||
        err.name === 'ValidationError' ||
        err.code === 'BAD_REQUEST' ||
        err.name === 'CastError';

      if (isValidationOrBusiness) {
        const rejAck: SyncPushEventAck = {
          eventId: event.eventId,
          entityId: event.entityId,
          status: 'rejected',
          permanent: true,
          errorCode: err.code || 'VALIDATION_FAILED',
          errorMessage: err.message || 'Validation failed',
        };

        // Record rejection in idempotency ledger in a separate transaction
        await atomic(async () => {
          await SyncIdempotency.create({
            schoolId,
            idempotencyKey: event.idempotencyKey,
            eventId: event.eventId,
            entityType: event.entityType,
            entityId: event.entityId,
            serverVersion: 1,
            status: 'rejected',
            permanent: true,
            errorCode: rejAck.errorCode,
            errorMessage: rejAck.errorMessage,
            payloadFingerprint: fingerprint,
            responsePayload: rejAck,
          });
        }).catch(() => {});

        acks.push(rejAck);
        failedCount++;
        continue;
      }

      // Unexpected server error: fail the request with HTTP 500
      throw err;
    }
  }

  return {
    success: failedCount === 0 && conflictCount === 0,
    acknowledgedCount,
    failedCount,
    conflictCount,
    events: acks,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Domain-specific Event Handlers with Invariant Protections
 */
async function processDomainEvent(
  schoolId: Types.ObjectId,
  userId: string,
  event: SyncPushEvent,
  originDeviceId?: string,
): Promise<SyncPushEventAck> {
  const campusId = await resolveCampusId(schoolId);
  const now = new Date();
  const payload = event.payload;

  switch (event.entityType) {
    case 'STUDENT': {
      const admissionNo = payload.admissionNumber || payload.admission_number || payload.admissionNo;
      if (!admissionNo) throw badRequest('admissionNumber is required for STUDENT');

      let student = await Student.findOne({ schoolId, admissionNo });
      const fullName = (payload.fullName || payload.full_name || '').trim();
      const parts = fullName.split(' ');
      const firstName = parts[0] || admissionNo;
      const lastName = parts.slice(1).join(' ') || undefined;

      if (student) {
        if (
          payload.bFormNo &&
          student.bFormNo &&
          payload.bFormNo !== student.bFormNo &&
          event.localVersion > 1
        ) {
          const conflictId = `conf_${crypto.randomUUID()}`;
          await SyncConflict.create({
            schoolId,
            conflictId,
            entityType: 'STUDENT',
            entityId: event.entityId,
            localPayload: payload,
            remotePayload: student.toObject(),
            conflictingFields: ['bFormNo'],
            reason: 'Divergent student identity bFormNo values between desktop and cloud',
            status: 'unresolved',
          });
          return {
            eventId: event.eventId,
            entityId: event.entityId,
            status: 'conflict',
            serverVersion: 2,
            conflictDetails: {
              remotePayload: student.toObject(),
              conflictingFields: ['bFormNo'],
              reason: 'Divergent student identity bFormNo values between desktop and cloud',
            },
          };
        }

        student.firstName = firstName;
        if (lastName) student.lastName = lastName;
        if (payload.phone) student.phone = payload.phone;
        if (payload.address) student.address = payload.address;
        if (payload.status) student.status = payload.status;
        await student.save();
      } else {
        let session = await AcademicSession.findOne({ schoolId, isCurrent: true });
        if (!session) {
          session =
            (await AcademicSession.findOne({ schoolId })) ||
            (await AcademicSession.create({
              schoolId,
              name: '2026-2027',
              startDate: new Date('2026-04-01'),
              endDate: new Date('2027-03-31'),
              isCurrent: true,
            }));
        }

        let sClass = await SchoolClass.findOne({ schoolId });
        if (!sClass) {
          sClass = await SchoolClass.create({
            schoolId,
            campusId,
            name: 'Class 1',
            level: 1,
            status: 'active',
          });
        }

        let section = await Section.findOne({ schoolId, classId: sClass._id });
        if (!section) {
          section = await Section.create({
            schoolId,
            campusId,
            classId: sClass._id,
            sessionId: session._id,
            name: 'Section A',
          });
        }

        student = (await Student.create({
          schoolId,
          campusId,
          sessionId: session._id,
          classId: sClass._id,
          sectionId: section._id,
          admissionNo,
          firstName,
          lastName,
          gender: payload.gender || 'other',
          dateOfBirth: payload.dateOfBirth ? new Date(payload.dateOfBirth) : payload.dob ? new Date(payload.dob) : new Date('2015-01-01'),
          bFormNo: payload.bFormNo || payload.b_form_no,
          phone: payload.phone,
          address: payload.address,
          status: payload.status || 'active',
        })) as any;

        await SyncEntityMapping.create({
          schoolId,
          entityType: 'STUDENT',
          localId: event.entityId,
          cloudId: student!._id.toString(),
        });
      }

      await recordChange(
        schoolId,
        'STUDENT',
        event.entityId,
        event.operation,
        1,
        payload,
        { originDeviceId },
      );

      return {
        eventId: event.eventId,
        entityId: event.entityId,
        status: 'synced',
        serverVersion: 1,
      };
    }

    case 'STUDENT_ENROLLMENT': {
      const studentLocalId = payload.studentId || payload.student_id;
      const student = await resolveStudent(schoolId, studentLocalId);
      if (!student) throw badRequest(`Referenced student ${studentLocalId} not found`);

      const session = await resolveSession(schoolId, payload.sessionId || payload.session_id);
      const sClass = await resolveClass(schoolId, campusId, payload.classId || payload.class_id);
      const section = await resolveSection(
        schoolId,
        campusId,
        sClass._id,
        session._id,
        payload.sectionId || payload.section_id,
      );

      const existingEnrollment = await StudentEnrollment.findOne({
        schoolId,
        studentId: student._id,
        sessionId: session._id,
      });

      if (existingEnrollment) {
        existingEnrollment.status = payload.status || existingEnrollment.status;
        if (payload.rollNo || payload.roll_number) existingEnrollment.rollNo = payload.rollNo || payload.roll_number;
        await existingEnrollment.save();
      } else {
        await StudentEnrollment.create({
          schoolId,
          campusId,
          studentId: student._id,
          sessionId: session._id,
          classId: sClass._id,
          sectionId: section._id,
          rollNo: payload.rollNo || payload.roll_number || student.rollNo,
          status: payload.status || 'active',
        });
      }

      await recordChange(
        schoolId,
        'STUDENT_ENROLLMENT',
        event.entityId,
        event.operation,
        1,
        payload,
        { originDeviceId },
      );

      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    case 'INVOICE': {
      const invoiceNo = payload.challanNumber || payload.challan_number || payload.invoiceNo;
      if (!invoiceNo) throw badRequest('Invoice number/challan number is required');

      const studentLocalId = payload.studentId || payload.student_id;
      const student = await resolveStudent(schoolId, studentLocalId);
      if (!student) throw badRequest(`Referenced student ${studentLocalId} not found`);

      const session = await resolveSession(schoolId, payload.sessionId || payload.session_id);
      const subtotal = Number(payload.amount || payload.subtotal || 0);
      const previousDues = Number(payload.previousDues || payload.previous_dues || 0);
      const paid = Number(payload.paidAmount || payload.paid_amount || payload.paid || 0);
      const total = subtotal + previousDues;
      const balance = Math.max(0, total - paid);
      const status = balance === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

      let invoice = await Invoice.findOne({ schoolId, invoiceNo });
      if (invoice) {
        invoice.subtotal = subtotal;
        invoice.total = total;
        invoice.paid = paid;
        invoice.balance = balance;
        invoice.status = status;
        await invoice.save();
      } else {
        invoice = await Invoice.create({
          schoolId,
          campusId,
          studentId: student._id,
          sessionId: session._id,
          invoiceNo,
          period: payload.month || '2026-11',
          issueDate: payload.issueDate ? new Date(payload.issueDate) : now,
          dueDate: payload.dueDate || payload.due_date ? new Date(payload.dueDate || payload.due_date) : now,
          subtotal,
          total,
          paid,
          balance,
          status,
        });

        await SyncEntityMapping.create({
          schoolId,
          entityType: 'INVOICE',
          localId: event.entityId,
          cloudId: invoice._id.toString(),
        });
      }

      await recordChange(
        schoolId,
        'INVOICE',
        event.entityId,
        event.operation,
        1,
        payload,
        { originDeviceId },
      );

      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    case 'PAYMENT': {
      const receiptNo = payload.receiptNo || payload.receipt_number || payload.receiptNumber;
      if (!receiptNo) throw badRequest('receiptNo is required for PAYMENT');

      const invoiceLocalId = payload.invoiceId || payload.invoice_id;
      const invoice = await resolveInvoice(schoolId, invoiceLocalId);
      if (!invoice) throw badRequest(`Referenced invoice ${invoiceLocalId} not found`);

      const amount = Number(payload.amount || 0);
      if (amount <= 0) throw badRequest('Payment amount must be greater than 0');

      let payment = await Payment.findOne({ schoolId, receiptNo });
      if (!payment) {
        payment = await Payment.create({
          schoolId,
          campusId: invoice.campusId,
          invoiceId: invoice._id,
          studentId: invoice.studentId,
          receiptNo,
          amount,
          method: payload.paymentMethod || payload.payment_method || 'cash',
          receivedAt: payload.paymentDate || payload.payment_date ? new Date(payload.paymentDate || payload.payment_date) : now,
          status: 'valid',
        });

        invoice.paid += amount;
        invoice.balance = Math.max(0, invoice.total - invoice.paid);
        invoice.status = invoice.balance === 0 ? 'paid' : 'partial';
        await invoice.save();
      } else if (payload.status === 'reversed') {
        payment.status = 'reversed';
        payment.reversalReason = payload.reversalReason || 'Reversed';
        payment.reversedAt = new Date();
        await payment.save();

        invoice.paid = Math.max(0, invoice.paid - payment.amount);
        invoice.balance = Math.max(0, invoice.total - invoice.paid);
        invoice.status = invoice.paid === 0 ? 'unpaid' : 'partial';
        await invoice.save();
      }

      await recordChange(
        schoolId,
        'PAYMENT',
        event.entityId,
        event.operation,
        1,
        payload,
        { originDeviceId },
      );

      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    case 'ATTENDANCE': {
      const studentLocalId = payload.studentId || payload.student_id;
      const student = await resolveStudent(schoolId, studentLocalId);
      if (!student) throw badRequest(`Referenced student ${studentLocalId} not found`);

      const session = await resolveSession(schoolId, payload.sessionId || payload.session_id);
      const sClass = await resolveClass(schoolId, campusId, payload.classId || payload.class_id);
      const section = await resolveSection(
        schoolId,
        campusId,
        sClass._id,
        session._id,
        payload.sectionId || payload.section_id,
      );

      if (!payload.date) throw badRequest('Attendance date is required');
      const attDate = new Date(payload.date);
      if (Number.isNaN(attDate.getTime())) throw badRequest('Invalid attendance date format');

      const validStatuses = ['present', 'absent', 'late', 'leave', 'excused'];
      if (!payload.status || !validStatuses.includes(payload.status)) {
        throw badRequest(`Invalid attendance status: ${payload.status}`);
      }

      let record = await AttendanceRecord.findOne({ schoolId, studentId: student._id, date: attDate });
      let authoritativeServerVersion = 1;

      if (record) {
        const oldStatus = record.status;
        record.status = payload.status;
        if (payload.remarks !== undefined) {
          record.remarks = payload.remarks;
        }
        record.version = (record.version || 1) + 1;
        await record.save();
        authoritativeServerVersion = record.version;
      } else {
        const created = await AttendanceRecord.create({
          schoolId,
          campusId,
          sessionId: session._id,
          classId: sClass._id,
          sectionId: section._id,
          studentId: student._id,
          date: attDate,
          status: payload.status,
          remarks: payload.remarks,
          version: 1,
        });
        authoritativeServerVersion = created.version || 1;
      }

      await recordChange(
        schoolId,
        'ATTENDANCE',
        event.entityId,
        record ? 'UPDATE' : 'INSERT',
        authoritativeServerVersion,
        payload,
        { originDeviceId },
      );

      return {
        eventId: event.eventId,
        entityId: event.entityId,
        status: 'synced',
        serverVersion: authoritativeServerVersion,
      };
    }

    case 'STUDENT_GUARDIAN': {
      const studentLocalId = payload.studentId || payload.student_id;
      const student = await resolveStudent(schoolId, studentLocalId);
      if (student && event.localVersion && event.localVersion > 1) {
        return {
          eventId: event.eventId,
          entityId: event.entityId,
          status: 'conflict',
          conflictDetails: {
            remotePayload: student.toObject(),
            conflictingFields: ['guardians'],
            reason: 'active guardian replacement requires conflict resolution',
          },
        };
      }
      if (student) {
        let parent = await Parent.findOne({ schoolId, phone: payload.phone });
        if (!parent) {
          parent = await Parent.create({
            schoolId,
            name: payload.fullName || 'Guardian',
            phone: payload.phone || '+923000000000',
            cnic: payload.cnic || '35201-0000000-0',
          });
        }
        (student as any).guardians = [
          {
            parentId: parent._id,
            relation: payload.relationship || 'father',
            isPrimary: Boolean(payload.isActive !== false),
          },
        ];
        await student.save();
      }
      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    case 'EMPLOYEE': {
      const employeeNo = payload.employeeCode || payload.employee_code || payload.employeeNo;
      let emp = await Employee.findOne({ schoolId, employeeNo });
      if (!emp) {
        const parts = (payload.fullName || payload.name || 'Staff Member').trim().split(/\s+/);
        const firstName = parts[0] || 'Staff';
        const lastName = parts.slice(1).join(' ') || 'Member';
        emp = await Employee.create({
          schoolId,
          campusId,
          employeeNo,
          firstName,
          lastName,
          designation: payload.designation || 'Staff',
          staffType: payload.staffType || 'teaching',
          phone: payload.phone,
          status: 'active',
        });
      }
      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    case 'PAYROLL_SLIP': {
      const empCode = payload.employeeCode || payload.employee_code;
      const emp = await Employee.findOne({ schoolId, employeeNo: empCode });
      if (emp) {
        await Payslip.create({
          schoolId,
          employeeId: emp._id,
          period: payload.month || payload.period || '2026-11',
          basic: Number(payload.basicSalary || payload.basic || 0),
          net: Number(payload.netSalary || payload.net || 0),
          status: payload.paymentStatus || payload.status || 'paid',
          paidAt: (payload.paymentStatus === 'paid' || payload.status === 'paid') ? now : undefined,
        });
      }
      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: 1 };
    }

    default:
      await recordChange(
        schoolId,
        event.entityType,
        event.entityId,
        event.operation,
        event.localVersion || 1,
        payload,
        { originDeviceId },
      );
      return { eventId: event.eventId, entityId: event.entityId, status: 'synced', serverVersion: event.localVersion || 1 };
  }
}

/**
 * Incremental Sequence-Based Change Stream (GET /sync/changes)
 */
export async function getChanges(
  ctx: Ctx,
  query: SyncChangesQuery,
  deviceIdHeader?: string,
): Promise<SyncChangesResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  const after = query.after || 0;
  const limit = Math.min(query.limit || 100, 500);

  const seqDoc = await SchoolSequence.findOne({ schoolId }).lean();
  const minRetainedSeq = seqDoc?.highestPrunedSeq || 0;
  const latestSeq = seqDoc?.seq || 0;

  if (after < minRetainedSeq) {
    // Per requirement #4: HTTP 410 FULL_RESYNC_REQUIRED
    throw new AppError(
      410,
      'FULL_RESYNC_REQUIRED',
      `Requested sequence ${after} is older than minimum retained sequence ${minRetainedSeq}. Full resync required.`,
    );
  }

  const filter: any = {
    schoolId,
    seq: { $gt: after },
  };

  if (deviceIdHeader) {
    filter.originDeviceId = { $ne: deviceIdHeader };
  }

  // Per requirement #9: filter by visibleToRoles for caller's role
  filter.$or = [
    { visibleToRoles: { $size: 0 } },
    { visibleToRoles: { $exists: false } },
    { visibleToRoles: ctx.role },
  ];

  const docs = await SyncChangeLog.find(filter)
    .sort({ seq: 1 })
    .limit(limit + 1)
    .lean();

  const hasMore = docs.length > limit;
  const returnDocs = docs.slice(0, limit);

  return {
    changes: returnDocs.map((d) => ({
      seq: d.seq,
      version: d.version || d.remoteVersion || 1,
      deleted: Boolean(d.deleted || d.operation === 'DELETE'),
      entityType: d.entityType,
      entityId: d.entityId,
      operation: d.operation as any,
      payload: d.payload,
      timestamp: (d.timestamp || new Date()).toISOString(),
      originDeviceId: d.originDeviceId || undefined,
    })),
    hasMore,
    latestSeq,
    minRetainedSeq,
  };
}

/**
 * Start a Consistent Snapshot Session
 */
export async function startSnapshot(ctx: Ctx): Promise<StartSnapshotResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  const seqDoc = await SchoolSequence.findOne({ schoolId }).lean();
  const currentSeq = seqDoc?.seq || 0;
  const snapshotId = `snap_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

  await SyncSnapshot.create({
    schoolId,
    snapshotId,
    seq: currentSeq,
  });

  return {
    snapshotId,
    seq: currentSeq,
  };
}

/**
 * Paginate Records for Consistent Snapshot (STUDENT and ATTENDANCE)
 */
export async function getSnapshotPage(
  ctx: Ctx,
  snapshotId: string,
  query: SnapshotPageQuery,
): Promise<SnapshotPageResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  const snapshot = await SyncSnapshot.findOne({ schoolId, snapshotId });
  if (!snapshot) {
    throw notFound('Snapshot session not found or expired');
  }

  const limit = 500;
  const { entity, cursor } = query;

  if (entity === 'STUDENT') {
    const filter: any = { schoolId };
    if (cursor && Types.ObjectId.isValid(cursor)) {
      filter._id = { $gt: new Types.ObjectId(cursor) };
    }

    const students = await Student.find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .populate('guardians.parentId')
      .lean();

    const hasMore = students.length > limit;
    const page = students.slice(0, limit);
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]._id.toString() : null;

    const items = page.map((s) => {
      const primaryGuardian = (s.guardians as any[])?.find((g) => g.isPrimary) || (s.guardians as any[])?.[0];
      const fatherGuardian = (s.guardians as any[])?.find((g) => g.relation === 'father');
      const fatherName = fatherGuardian?.parentId?.name || primaryGuardian?.parentId?.name || (s as any).fatherName || 'Guardian';

      return {
        id: s._id.toString(),
        admissionNumber: s.admissionNo,
        fullName: `${s.firstName} ${s.lastName || ''}`.trim(),
        fatherName,
        phone: s.phone || (s as any).emergencyContact,
        address: s.address,
        status: s.status,
        version: 1,
        schoolId: ctx.schoolId,
      };
    });

    return { items, nextCursor, hasMore };
  }

  if (entity === 'ATTENDANCE') {
    const filter: any = { schoolId };
    if (cursor && Types.ObjectId.isValid(cursor)) {
      filter._id = { $gt: new Types.ObjectId(cursor) };
    }

    const records = await AttendanceRecord.find(filter)
      .sort({ _id: 1 })
      .limit(limit + 1)
      .lean();

    const hasMore = records.length > limit;
    const page = records.slice(0, limit);
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]._id.toString() : null;

    const items = page.map((r: any) => ({
      id: r._id.toString(),
      studentId: r.studentId.toString(),
      sectionId: r.sectionId.toString(),
      classId: r.classId?.toString(),
      sessionId: r.sessionId?.toString(),
      date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : r.date,
      status: r.status,
      remarks: r.remarks,
      version: r.version || 1,
      schoolId: ctx.schoolId,
    }));

    return { items, nextCursor, hasMore };
  }

  throw badRequest(`Snapshot entity "${entity}" is not supported in this slice`);
}

/**
 * Legacy Incremental Pull Processor (Maintained for backward compatibility)
 */
export async function pullChanges(
  ctx: Ctx,
  body: SyncPullRequest,
  deviceIdHeader?: string,
): Promise<SyncPullResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);

  if (body.schoolId && body.schoolId !== ctx.schoolId) {
    throw forbidden('Tenant isolation violation: Client cannot pull changes for another school tenant');
  }

  const cursors = body.cursors || {};
  const nextCursors: Record<string, string> = { ...cursors };
  const limit = Math.min(body.limit || 100, 500);
  const changes: RemoteChangeItem[] = [];

  const filter: any = { schoolId };
  if (deviceIdHeader) {
    filter.originDeviceId = { $ne: deviceIdHeader };
  }

  const cursorEntries = Object.entries(cursors).filter(([_, c]) => Boolean(c));
  if (cursorEntries.length > 0) {
    const cursorOrs: any[] = [];
    for (const [entityType, cursor] of cursorEntries) {
      cursorOrs.push({ entityType, changeId: { $gt: cursor } });
    }
    const coveredTypes = cursorEntries.map(([t]) => t);
    cursorOrs.push({ entityType: { $nin: coveredTypes } });
    filter.$or = cursorOrs;
  }

  const changeDocs = await SyncChangeLog.find(filter)
    .sort({ timestamp: 1 })
    .limit(limit)
    .lean();

  for (const doc of changeDocs) {
    const cursor = cursors[doc.entityType];
    const isNewer = !cursor || doc.changeId > cursor || new Date(doc.timestamp) > new Date(cursor);
    if (isNewer) {
      changes.push({
        changeId: doc.changeId,
        entityType: doc.entityType,
        entityId: doc.entityId,
        operation: doc.operation as any,
        payload: doc.payload,
        remoteVersion: doc.remoteVersion,
        timestamp: doc.timestamp.toISOString(),
        originDeviceId: doc.originDeviceId || undefined,
      });
      nextCursors[doc.entityType] = doc.changeId;
    }
  }

  return {
    success: true,
    hasMore: changes.length >= limit,
    nextCursors,
    changes: changes.slice(0, limit),
    serverTime: new Date().toISOString(),
  };
}

/**
 * Workstation Device Registration
 */
export async function registerDevice(
  ctx: Ctx,
  body: DeviceRegisterRequest,
): Promise<DeviceRegisterResponse> {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  const deviceId = `dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  await SyncDevice.create({
    schoolId,
    deviceId,
    deviceName: body.deviceName,
    platform: body.platform,
    status: 'registered',
    registeredBy: new Types.ObjectId(ctx.userId),
    lastSeenAt: new Date(),
    lastHandshakeAt: new Date(),
  });

  const token = signSchoolAccessToken({
    userId: ctx.userId,
    schoolId: ctx.schoolId,
    role: ctx.role,
    tokenVersion: 1,
  });

  const refresh = await issueRefreshToken({
    subjectType: 'user',
    subjectId: ctx.userId,
    schoolId: ctx.schoolId,
  });

  return {
    success: true,
    deviceId,
    token,
    refreshToken: refresh.token,
    serverTime: new Date().toISOString(),
  };
}

/**
 * List Active Unresolved Conflicts for School
 */
export async function listConflicts(ctx: Ctx) {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  return SyncConflict.find({ schoolId, status: 'unresolved' })
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Resolve an Identified Conflict Idempotently
 */
export async function resolveConflict(
  ctx: Ctx,
  conflictId: string,
  body: ResolveConflictRequest,
) {
  const schoolId = new Types.ObjectId(ctx.schoolId);
  const record = await SyncConflict.findOne({ schoolId, conflictId });
  if (!record) throw notFound('Conflict not found');

  if (record.status === 'resolved') {
    throw conflict('This conflict has already been resolved and cannot be re-applied');
  }

  record.status = 'resolved';
  record.resolutionStrategy = body.resolutionStrategy;
  record.resolutionNotes = body.resolutionNotes;
  record.resolvedBy = new Types.ObjectId(ctx.userId);
  record.resolvedAt = new Date();
  await record.save();

  return {
    success: true,
    conflictId,
    status: 'resolved',
    strategy: body.resolutionStrategy,
  };
}

// ─── Helpers to Resolve Relations ──────────────────────────────────────────

async function resolveStudent(schoolId: Types.ObjectId, candidateId: any) {
  if (!candidateId) return null;
  const mapping = await SyncEntityMapping.findOne({ schoolId, entityType: 'STUDENT', localId: candidateId });
  if (mapping) {
    const student = await Student.findOne({ schoolId, _id: mapping.cloudId });
    if (student) return student;
  }
  if (Types.ObjectId.isValid(candidateId)) {
    const student = await Student.findOne({ schoolId, _id: new Types.ObjectId(candidateId) });
    if (student) return student;
  }
  return Student.findOne({ schoolId, admissionNo: candidateId });
}

async function resolveInvoice(schoolId: Types.ObjectId, candidateId: any) {
  if (!candidateId) return null;
  const mapping = await SyncEntityMapping.findOne({ schoolId, entityType: 'INVOICE', localId: candidateId });
  if (mapping) {
    const inv = await Invoice.findOne({ schoolId, _id: mapping.cloudId });
    if (inv) return inv;
  }
  if (Types.ObjectId.isValid(candidateId)) {
    const inv = await Invoice.findOne({ schoolId, _id: new Types.ObjectId(candidateId) });
    if (inv) return inv;
  }
  return Invoice.findOne({ schoolId, invoiceNo: candidateId });
}

async function resolveSession(schoolId: Types.ObjectId, candidateId?: any) {
  if (candidateId) {
    if (Types.ObjectId.isValid(candidateId)) {
      const s = await AcademicSession.findOne({ schoolId, _id: new Types.ObjectId(candidateId) });
      if (s) return s;
    }
    const byName = await AcademicSession.findOne({ schoolId, name: candidateId });
    if (byName) return byName;
    return AcademicSession.create({
      schoolId,
      name: candidateId,
      startDate: new Date('2025-04-01'),
      endDate: new Date('2026-03-31'),
      isCurrent: false,
    });
  }
  let session = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!session) {
    session =
      (await AcademicSession.findOne({ schoolId })) ||
      (await AcademicSession.create({
        schoolId,
        name: '2026-2027',
        startDate: new Date('2026-04-01'),
        endDate: new Date('2027-03-31'),
        isCurrent: true,
      }));
  }
  return session;
}

async function resolveClass(schoolId: Types.ObjectId, campusId: Types.ObjectId, candidateId?: any) {
  if (candidateId && Types.ObjectId.isValid(candidateId)) {
    const c = await SchoolClass.findOne({ schoolId, _id: new Types.ObjectId(candidateId) });
    if (c) return c;
  }
  let sClass = await SchoolClass.findOne({ schoolId });
  if (!sClass) {
    sClass = await SchoolClass.create({
      schoolId,
      campusId,
      name: 'Class 1',
      level: 1,
      status: 'active',
    });
  }
  return sClass;
}

async function resolveSection(
  schoolId: Types.ObjectId,
  campusId: Types.ObjectId,
  classId: Types.ObjectId,
  sessionId: Types.ObjectId,
  candidateId?: any,
) {
  if (candidateId && Types.ObjectId.isValid(candidateId)) {
    const s = await Section.findOne({ schoolId, _id: new Types.ObjectId(candidateId) });
    if (s) return s;
  }
  let section = await Section.findOne({ schoolId, classId });
  if (!section) {
    section = await Section.create({
      schoolId,
      campusId,
      classId,
      sessionId,
      name: 'Section A',
    });
  }
  return section;
}
