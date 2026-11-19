import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import type { SchoolContext } from '../../types/context';
import { badRequest, conflict } from '../../utils/errors';
import { findOwned, oid, scope } from '../../utils/tenant';
import { atomic } from '../../database/transactions';
import { audit } from '../audit/audit.service';
import { AttendanceRecord } from '../attendance/attendance.model';
import { Employee } from '../employees/employee.model';
import { Exam } from '../examinations/exam.models';
import { Homework } from '../homework/homework.models';
import { StudentEnrollment } from '../students/student.models';
import { conflictsBetween, scanConflicts, type Conflict, type Slot } from '../timetable/conflicts';
import { TimetableEntry } from '../timetable/timetable.model';
import { AcademicRolloverBatch } from './academic-rollover-batch.model';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from './academics.models';

type Ctx = SchoolContext;

export interface AcademicRolloverPreviewInput {
  fromSessionId: string;
  toSessionId: string;
}

export interface TeacherAssignmentOverride {
  sectionClassId: string;
  sectionName: string;
  subjectId: string;
  teacherId: string;
}

export interface RoomAllocationOverride {
  sectionClassId: string;
  sectionName: string;
  room: string;
}

export interface AcademicRolloverExecuteInput extends AcademicRolloverPreviewInput {
  includeSections?: boolean;
  includeTeacherAssignments?: boolean;
  includeTimetable?: boolean;
  teacherOverrides?: TeacherAssignmentOverride[];
  excludedAssignmentIds?: string[];
  roomOverrides?: RoomAllocationOverride[];
  ignoreWarnings?: boolean;
}

const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export async function previewAcademicRollover(ctx: Ctx, input: AcademicRolloverPreviewInput) {
  if (input.fromSessionId === input.toSessionId) {
    throw badRequest('Source and target academic sessions must be different');
  }

  const [fromSession, toSession] = await Promise.all([
    findOwned(AcademicSession, ctx, input.fromSessionId, 'Source session'),
    findOwned(AcademicSession, ctx, input.toSessionId, 'Target session'),
  ]);

  // Fetch all relevant data for both sessions
  const [
    sourceSections,
    targetSections,
    classes,
    subjects,
    teachers,
    sourceAssignments,
    targetAssignments,
    sourceTimetableEntries,
    targetTimetableEntries,
  ] = await Promise.all([
    Section.find(scope(ctx, { sessionId: fromSession._id }))
      .populate('classId', 'name level campusId')
      .lean(),
    Section.find(scope(ctx, { sessionId: toSession._id }))
      .populate('classId', 'name level campusId')
      .lean(),
    SchoolClass.find(scope(ctx, { status: 'active' })).sort({ level: 1 }).lean(),
    Subject.find(scope(ctx, {})).lean(),
    Employee.find(scope(ctx, { staffType: 'teaching' }))
      .select('_id firstName lastName employeeNo designation status staffType')
      .lean(),
    TeachingAssignment.find(scope(ctx, { sessionId: fromSession._id })).lean(),
    TeachingAssignment.find(scope(ctx, { sessionId: toSession._id })).lean(),
    TimetableEntry.find(scope(ctx, { sessionId: fromSession._id })).lean(),
    TimetableEntry.find(scope(ctx, { sessionId: toSession._id })).lean(),
  ]);

  const teacherMap = new Map(teachers.map((t) => [t._id.toString(), t]));
  const subjectMap = new Map(subjects.map((s) => [s._id.toString(), s]));
  const classMap = new Map(classes.map((c) => [c._id.toString(), c]));

  // 1. SECTION CONTINUITY & ROOM ALLOCATION
  const targetSectionKey = (classId: string, name: string) => `${classId}::${name.trim().toLowerCase()}`;
  const existingTargetSectionsByKey = new Map<string, any>();
  for (const ts of targetSections) {
    const cid = ts.classId?._id?.toString() ?? ts.classId?.toString();
    if (cid) {
      existingTargetSectionsByKey.set(targetSectionKey(cid, ts.name), ts);
    }
  }

  const sectionPreviews = sourceSections.map((sec) => {
    const classIdStr = sec.classId?._id?.toString() ?? sec.classId?.toString();
    const className = (sec.classId as any)?.name ?? 'Unknown Class';
    const classLevel = (sec.classId as any)?.level ?? 0;
    const key = targetSectionKey(classIdStr, sec.name);
    const existing = existingTargetSectionsByKey.get(key);

    const classTeacher = sec.classTeacherId ? teacherMap.get(sec.classTeacherId.toString()) : null;
    const isTeacherActive = classTeacher ? classTeacher.status === 'active' : true;
    let warning: string | undefined;
    if (classTeacher && !isTeacherActive) {
      warning = `Class teacher ${classTeacher.firstName} ${classTeacher.lastName ?? ''} is ${classTeacher.status}; replacement recommended.`;
    }

    return {
      sourceSectionId: sec._id.toString(),
      targetSectionId: existing ? existing._id.toString() : null,
      classId: classIdStr,
      className,
      classLevel,
      sectionName: sec.name,
      campusId: sec.campusId.toString(),
      capacity: sec.capacity ?? 40,
      room: existing?.room ?? sec.room ?? '',
      classTeacherId: sec.classTeacherId ? sec.classTeacherId.toString() : null,
      classTeacherName: classTeacher ? `${classTeacher.firstName} ${classTeacher.lastName ?? ''}`.trim() : null,
      classTeacherStatus: classTeacher?.status ?? null,
      alreadyExists: Boolean(existing),
      action: existing ? ('reuse' as const) : ('create' as const),
      warning,
    };
  });

  // Map sourceSectionId -> targetSectionId (or planned key)
  const sourceToTargetSectionId = new Map<string, string>();
  for (const sp of sectionPreviews) {
    if (sp.targetSectionId) {
      sourceToTargetSectionId.set(sp.sourceSectionId, sp.targetSectionId);
    }
  }

  // 2. SUBJECT CONFIGURATION AND MAPPINGS
  const subjectPreviews = subjects.map((sub) => {
    const assignedClassNames = (sub.classIds || [])
      .map((cid: any) => classMap.get(cid.toString())?.name)
      .filter(Boolean);
    return {
      _id: sub._id.toString(),
      name: sub.name,
      code: sub.code,
      isElective: Boolean(sub.isElective),
      classCount: (sub.classIds || []).length,
      assignedClasses: assignedClassNames,
      status: (sub.classIds || []).length > 0 ? ('configured' as const) : ('unassigned' as const),
    };
  });

  // 3. TEACHER ASSIGNMENT CARRY-FORWARD
  const existingTargetAssignmentKey = (sectionId: string, subjectId: string) => `${sectionId}::${subjectId}`;
  const existingTargetAssignments = new Set(
    targetAssignments.map((a) => existingTargetAssignmentKey(a.sectionId.toString(), a.subjectId.toString())),
  );

  const assignmentPreviews = sourceAssignments.map((a) => {
    const secPreview = sectionPreviews.find((s) => s.sourceSectionId === a.sectionId.toString());
    const teacher = a.teacherId ? teacherMap.get(a.teacherId.toString()) : null;
    const subject = a.subjectId ? subjectMap.get(a.subjectId.toString()) : null;

    const targetSectionId = secPreview?.targetSectionId;
    const alreadyExists = targetSectionId
      ? existingTargetAssignments.has(existingTargetAssignmentKey(targetSectionId, a.subjectId.toString()))
      : false;

    let status: 'ready' | 'warning' | 'conflict' | 'already_exists' = 'ready';
    let message: string | undefined;

    if (alreadyExists) {
      status = 'already_exists';
      message = 'Teaching assignment already exists in target session.';
    } else if (!teacher) {
      status = 'warning';
      message = 'Assigned teacher not found or removed.';
    } else if (teacher.status !== 'active') {
      status = 'warning';
      message = `Teacher ${teacher.firstName} ${teacher.lastName ?? ''} is ${teacher.status}; replacement recommended.`;
    } else if (
      subject &&
      subject.classIds?.length &&
      secPreview?.classId &&
      !subject.classIds.map(String).includes(secPreview.classId)
    ) {
      status = 'conflict';
      message = `Subject ${subject.name} is not configured for ${secPreview.className}.`;
    }

    return {
      sourceAssignmentId: a._id.toString(),
      sourceSectionId: a.sectionId.toString(),
      className: secPreview?.className ?? 'Unknown',
      classLevel: secPreview?.classLevel ?? 0,
      sectionName: secPreview?.sectionName ?? 'Unknown',
      subjectId: a.subjectId.toString(),
      subjectName: subject?.name ?? 'Unknown',
      subjectCode: subject?.code ?? '',
      teacherId: a.teacherId ? a.teacherId.toString() : null,
      teacherName: teacher ? `${teacher.firstName} ${teacher.lastName ?? ''}`.trim() : 'Unassigned',
      teacherEmployeeNo: teacher?.employeeNo ?? '',
      teacherStatus: teacher?.status ?? 'missing',
      status,
      message,
    };
  });

  // 4. TIMETABLE AND PERIOD CARRY-FORWARD & CONFLICT SCANNING
  // Build hypothetical target slots
  const proposedSlots: Slot[] = [];
  const timetablePreviews = sourceTimetableEntries.map((te) => {
    const secPreview = sectionPreviews.find((s) => s.sourceSectionId === te.sectionId.toString());
    const subject = subjectMap.get(te.subjectId.toString());
    const teacher = te.teacherId ? teacherMap.get(te.teacherId.toString()) : null;
    const room = te.room || secPreview?.room || '';

    const slot: Slot = {
      id: te._id.toString(),
      sectionId: secPreview?.targetSectionId || `temp_${secPreview?.sourceSectionId}`,
      teacherId: te.teacherId ? te.teacherId.toString() : null,
      campusId: te.campusId.toString(),
      room,
      dayOfWeek: te.dayOfWeek,
      startMinutes: te.startMinutes,
      endMinutes: te.endMinutes,
    };
    proposedSlots.push(slot);

    return {
      sourceEntryId: te._id.toString(),
      sourceSectionId: te.sectionId.toString(),
      className: secPreview?.className ?? 'Unknown',
      sectionName: secPreview?.sectionName ?? 'Unknown',
      subjectId: te.subjectId.toString(),
      subjectName: subject?.name ?? 'Unknown',
      teacherId: te.teacherId ? te.teacherId.toString() : null,
      teacherName: teacher ? `${teacher.firstName} ${teacher.lastName ?? ''}`.trim() : null,
      teacherStatus: teacher?.status ?? (te.teacherId ? 'missing' : 'unassigned'),
      dayOfWeek: te.dayOfWeek,
      dayName: WEEKDAYS[te.dayOfWeek] ?? `Day ${te.dayOfWeek}`,
      startTime: te.startTime,
      endTime: te.endTime,
      startMinutes: te.startMinutes,
      endMinutes: te.endMinutes,
      room,
    };
  });

  // Include existing target timetable entries for comprehensive conflict check,
  // excluding exact matching slots that represent already-copied periods
  const existingTargetSlots: Slot[] = targetTimetableEntries.map((te) => ({
    id: te._id.toString(),
    sectionId: te.sectionId.toString(),
    teacherId: te.teacherId ? te.teacherId.toString() : null,
    campusId: te.campusId.toString(),
    room: te.room ?? '',
    dayOfWeek: te.dayOfWeek,
    startMinutes: te.startMinutes,
    endMinutes: te.endMinutes,
  }));

  const proposedSlotKeys = new Set(
    proposedSlots.map((s) => `${s.sectionId}::${s.dayOfWeek}::${s.startMinutes}::${s.endMinutes}`),
  );
  const unrelatedTargetSlots = existingTargetSlots.filter(
    (s) => !proposedSlotKeys.has(`${s.sectionId}::${s.dayOfWeek}::${s.startMinutes}::${s.endMinutes}`),
  );

  const allSlots = [...unrelatedTargetSlots, ...proposedSlots];
  const detectedConflicts = scanConflicts(allSlots);

  const formattedConflicts = detectedConflicts.map((c) => {
    const slotA = allSlots.find((s) => s.id === c.entryId);
    const slotB = allSlots.find((s) => s.id === c.withEntryId);
    const dayName = WEEKDAYS[c.dayOfWeek] ?? `Day ${c.dayOfWeek}`;
    return {
      type: c.type,
      dayOfWeek: c.dayOfWeek,
      dayName,
      message: c.message,
      entryId: c.entryId,
      withEntryId: c.withEntryId,
      timeSpan: slotA ? `${Math.floor(slotA.startMinutes / 60)}:${String(slotA.startMinutes % 60).padStart(2, '0')} - ${Math.floor(slotA.endMinutes / 60)}:${String(slotA.endMinutes % 60).padStart(2, '0')}` : '',
      room: slotA?.room || slotB?.room || undefined,
    };
  });

  // Calculate summaries & overall readiness
  const totalSections = sectionPreviews.length;
  const newSections = sectionPreviews.filter((s) => !s.alreadyExists).length;
  const reusedSections = sectionPreviews.filter((s) => s.alreadyExists).length;

  const totalAssignments = assignmentPreviews.length;
  const readyAssignments = assignmentPreviews.filter((a) => a.status === 'ready').length;
  const warningAssignments = assignmentPreviews.filter((a) => a.status === 'warning').length;
  const conflictAssignments = assignmentPreviews.filter((a) => a.status === 'conflict').length;
  const alreadyExistsAssignments = assignmentPreviews.filter((a) => a.status === 'already_exists').length;

  const missingTeachersCount = assignmentPreviews.filter(
    (a) => a.teacherStatus !== 'active' && a.teacherStatus !== 'already_exists',
  ).length;

  let overallStatus: 'ready' | 'needs_review' | 'conflict' = 'ready';
  if (formattedConflicts.length > 0 || conflictAssignments > 0) {
    overallStatus = 'conflict';
  } else if (warningAssignments > 0 || missingTeachersCount > 0) {
    overallStatus = 'needs_review';
  }

  return {
    fromSession: { _id: fromSession._id.toString(), name: fromSession.name },
    toSession: { _id: toSession._id.toString(), name: toSession.name },
    overallStatus,
    summary: {
      totalSections,
      newSectionsToCreate: newSections,
      reusedSections,
      totalSubjects: subjects.length,
      totalTeachingAssignments: totalAssignments,
      readyAssignments,
      warningAssignments,
      conflictAssignments,
      alreadyExistsAssignments,
      missingTeachersCount,
      totalTimetablePeriods: timetablePreviews.length,
      conflictsCount: formattedConflicts.length,
    },
    sections: sectionPreviews,
    subjects: subjectPreviews,
    teachingAssignments: assignmentPreviews,
    timetablePeriods: timetablePreviews,
    conflicts: formattedConflicts,
    canExecute: overallStatus !== 'conflict',
  };
}

export async function executeAcademicRollover(ctx: Ctx, input: AcademicRolloverExecuteInput) {
  const preview = await previewAcademicRollover(ctx, input);

  if (preview.overallStatus === 'conflict' && !input.ignoreWarnings) {
    throw conflict(
      'Academic rollover has unresolved conflicts (room/teacher overlaps or invalid subject mappings). Resolve them or acknowledge overrides before proceeding.',
      { conflicts: preview.conflicts },
    );
  }

  const [fromSession, toSession] = await Promise.all([
    findOwned(AcademicSession, ctx, input.fromSessionId, 'Source session'),
    findOwned(AcademicSession, ctx, input.toSessionId, 'Target session'),
  ]);

  const includeSections = input.includeSections ?? true;
  const includeTeacherAssignments = input.includeTeacherAssignments ?? true;
  const includeTimetable = input.includeTimetable ?? true;

  const excludedAssignmentSet = new Set(input.excludedAssignmentIds || []);

  // Map overrides
  const teacherOverrideMap = new Map<string, string>();
  for (const ov of input.teacherOverrides || []) {
    teacherOverrideMap.set(`${ov.sectionClassId}::${ov.sectionName.trim().toLowerCase()}::${ov.subjectId}`, ov.teacherId);
  }

  const roomOverrideMap = new Map<string, string>();
  for (const ro of input.roomOverrides || []) {
    roomOverrideMap.set(`${ro.sectionClassId}::${ro.sectionName.trim().toLowerCase()}`, ro.room);
  }

  const createdSectionIds: Types.ObjectId[] = [];
  const reusedSectionIds: Types.ObjectId[] = [];
  const createdTeachingAssignmentIds: Types.ObjectId[] = [];
  const createdTimetableEntryIds: Types.ObjectId[] = [];

  // 1. SECTION CONTINUITY EXECUTION
  // Map sourceSectionId -> targetSectionId (real ObjectId string)
  const sourceToTargetSectionId = new Map<string, string>();

  for (const s of preview.sections) {
    const roomOverride = roomOverrideMap.get(`${s.classId}::${s.sectionName.trim().toLowerCase()}`);
    const finalRoom = roomOverride !== undefined ? roomOverride : s.room;

    if (s.alreadyExists && s.targetSectionId) {
      sourceToTargetSectionId.set(s.sourceSectionId, s.targetSectionId);
      reusedSectionIds.push(oid(s.targetSectionId));
      // Update room if override provided
      if (roomOverride !== undefined) {
        await Section.updateOne(scope(ctx, { _id: oid(s.targetSectionId) }), { $set: { room: finalRoom } });
      }
    } else if (includeSections) {
      // Create missing section in target session
      const classTeacherOid = s.classTeacherId && s.classTeacherStatus === 'active' ? oid(s.classTeacherId) : undefined;
      const newSec = await Section.create({
        schoolId: oid(ctx.schoolId),
        sessionId: oid(input.toSessionId),
        campusId: oid(s.campusId),
        classId: oid(s.classId),
        name: s.sectionName,
        capacity: s.capacity,
        room: finalRoom,
        classTeacherId: classTeacherOid,
      });
      sourceToTargetSectionId.set(s.sourceSectionId, newSec._id.toString());
      createdSectionIds.push(newSec._id);
    }
  }

  // 2. TEACHER ASSIGNMENTS EXECUTION
  if (includeTeacherAssignments) {
    for (const a of preview.teachingAssignments) {
      if (excludedAssignmentSet.has(a.sourceAssignmentId)) {
        continue;
      }

      const targetSectionId = sourceToTargetSectionId.get(a.sourceSectionId);
      if (!targetSectionId) continue;

      const secPreview = preview.sections.find((s) => s.sourceSectionId === a.sourceSectionId);
      const classIdStr = secPreview?.classId ?? '';
      const overrideKey = `${classIdStr}::${a.sectionName.trim().toLowerCase()}::${a.subjectId}`;
      const teacherOverride = teacherOverrideMap.get(overrideKey);
      const finalTeacherId = teacherOverride || (a.teacherStatus === 'active' ? a.teacherId : null);

      if (!finalTeacherId) {
        // Skip unassigned assignments unless admin assigned one
        continue;
      }

      // Check if assignment already exists
      const existing = await TeachingAssignment.findOne(
        scope(ctx, {
          sessionId: oid(input.toSessionId),
          sectionId: oid(targetSectionId),
          subjectId: oid(a.subjectId),
        }),
      ).lean();

      if (!existing) {
        const createdAssignment = await TeachingAssignment.create({
          schoolId: oid(ctx.schoolId),
          sessionId: oid(input.toSessionId),
          sectionId: oid(targetSectionId),
          subjectId: oid(a.subjectId),
          teacherId: oid(finalTeacherId),
        });
        createdTeachingAssignmentIds.push(createdAssignment._id);
      }
    }
  }

  // 3. TIMETABLE AND PERIOD EXECUTION
  if (includeTimetable) {
    for (const p of preview.timetablePeriods) {
      const targetSectionId = sourceToTargetSectionId.get(p.sourceSectionId);
      if (!targetSectionId) continue;

      const secPreview = preview.sections.find((s) => s.sourceSectionId === p.sourceSectionId);
      const classIdStr = secPreview?.classId ?? '';
      const overrideKey = `${classIdStr}::${p.sectionName.trim().toLowerCase()}::${p.subjectId}`;
      const teacherOverride = teacherOverrideMap.get(overrideKey);
      const finalTeacherId = teacherOverride || (p.teacherStatus === 'active' ? p.teacherId : null);

      const roomOverride = roomOverrideMap.get(`${classIdStr}::${p.sectionName.trim().toLowerCase()}`);
      const finalRoom = roomOverride !== undefined ? roomOverride : p.room;

      // Duplicate prevention: check if timetable slot already occupied in target session
      const existingEntry = await TimetableEntry.findOne(
        scope(ctx, {
          sessionId: oid(input.toSessionId),
          sectionId: oid(targetSectionId),
          dayOfWeek: p.dayOfWeek,
          startMinutes: p.startMinutes,
          endMinutes: p.endMinutes,
        }),
      ).lean();

      if (!existingEntry) {
        const entry = await TimetableEntry.create({
          schoolId: oid(ctx.schoolId),
          sessionId: oid(input.toSessionId),
          campusId: oid(secPreview?.campusId ?? ctx.schoolId),
          sectionId: oid(targetSectionId),
          subjectId: oid(p.subjectId),
          teacherId: finalTeacherId ? oid(finalTeacherId) : undefined,
          dayOfWeek: p.dayOfWeek,
          startTime: p.startTime,
          endTime: p.endTime,
          startMinutes: p.startMinutes,
          endMinutes: p.endMinutes,
          room: finalRoom,
        });
        createdTimetableEntryIds.push(entry._id);
      }
    }
  }

  // Generate batch number
  const year = new Date().getFullYear();
  const existingBatchesCount = await AcademicRolloverBatch.countDocuments(scope(ctx, {}));
  const batchNumber = `ARB-${year}-${String(existingBatchesCount + 1).padStart(3, '0')}`;

  const batch = await AcademicRolloverBatch.create({
    schoolId: oid(ctx.schoolId),
    batchNumber,
    fromSessionId: oid(input.fromSessionId),
    toSessionId: oid(input.toSessionId),
    executedBy: ctx.userId ? oid(ctx.userId) : undefined,
    executedAt: new Date(),
    status: 'completed',
    createdSectionIds,
    reusedSectionIds,
    createdTeachingAssignmentIds,
    createdTimetableEntryIds,
    summary: {
      sectionsCreatedCount: createdSectionIds.length,
      sectionsReusedCount: reusedSectionIds.length,
      teachingAssignmentsCount: createdTeachingAssignmentIds.length,
      timetableEntriesCount: createdTimetableEntryIds.length,
    },
  });

  // Update target AcademicSession status
  await AcademicSession.updateOne(
    scope(ctx, { _id: oid(input.toSessionId) }),
    {
      $set: {
        academicRolloverStatus: 'completed',
        academicRolloverAt: new Date(),
        academicRolloverFromSessionId: oid(input.fromSessionId),
      },
    },
  );

  await audit(ctx, {
    action: 'academic_rollover.executed',
    entityType: 'AcademicRolloverBatch',
    entityId: batch._id,
    metadata: {
      batchNumber,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      sectionsCreated: createdSectionIds.length,
      sectionsReused: reusedSectionIds.length,
      assignmentsCreated: createdTeachingAssignmentIds.length,
      timetableEntriesCreated: createdTimetableEntryIds.length,
    },
  });

  return {
    success: true,
    batchId: batch._id.toString(),
    batchNumber,
    summary: {
      sectionsCreated: createdSectionIds.length,
      sectionsReused: reusedSectionIds.length,
      teachingAssignmentsCreated: createdTeachingAssignmentIds.length,
      timetableEntriesCreated: createdTimetableEntryIds.length,
    },
  };
}

export async function checkAcademicRolloverRollback(ctx: Ctx, targetSessionId: string) {
  const session = await findOwned(AcademicSession, ctx, targetSessionId, 'Target session');

  const blockers: Array<{ type: string; count: number; message: string }> = [];

  // 1. Check Attendance
  const attendanceCount = await AttendanceRecord.countDocuments(scope(ctx, { sessionId: session._id }));
  if (attendanceCount > 0) {
    blockers.push({
      type: 'attendance',
      count: attendanceCount,
      message: `${attendanceCount} student attendance records have already been marked in this session.`,
    });
  }

  // 2. Check Exams
  const examCount = await Exam.countDocuments(scope(ctx, { sessionId: session._id }));
  if (examCount > 0) {
    blockers.push({
      type: 'exams',
      count: examCount,
      message: `${examCount} exams have already been scheduled or recorded in this session.`,
    });
  }

  // 3. Check Homework
  const homeworkCount = await Homework.countDocuments(scope(ctx, { sessionId: session._id }));
  if (homeworkCount > 0) {
    blockers.push({
      type: 'homework',
      count: homeworkCount,
      message: `${homeworkCount} homework tasks have been assigned in this session.`,
    });
  }

  const latestBatch = await AcademicRolloverBatch.findOne(
    scope(ctx, { toSessionId: session._id, status: 'completed' }),
  )
    .sort({ executedAt: -1 })
    .lean();

  return {
    canRollback: blockers.length === 0,
    alreadyRolledBack: session.academicRolloverStatus === 'rolled_back' || !latestBatch,
    sessionId: session._id.toString(),
    batchId: latestBatch?._id?.toString() ?? null,
    batchNumber: latestBatch?.batchNumber ?? null,
    blockers,
  };
}

export async function rollbackAcademicRollover(
  ctx: Ctx,
  input: { targetSessionId: string; reason: string },
) {
  if (!input.reason?.trim() || input.reason.trim().length < 3) {
    throw badRequest('A valid reason (at least 3 characters) is required for academic rollover rollback');
  }

  const check = await checkAcademicRolloverRollback(ctx, input.targetSessionId);
  if (!check.canRollback) {
    throw conflict(
      'Academic rollover rollback is blocked because target session has active academic activity (attendance, exams, or homework).',
      { blockers: check.blockers },
      'ROLLBACK_BLOCKED',
    );
  }

  const batches = await AcademicRolloverBatch.find(
    scope(ctx, { toSessionId: oid(input.targetSessionId), status: 'completed' }),
  );

  if (!batches || batches.length === 0) {
    throw badRequest('No active academic rollover batch found for this session');
  }

  return atomic(async () => {
    const allTimetableEntryIds = batches.flatMap((b) => b.createdTimetableEntryIds || []);
    const allTeachingAssignmentIds = batches.flatMap((b) => b.createdTeachingAssignmentIds || []);
    const allSectionIds = batches.flatMap((b) => b.createdSectionIds || []);

    // 1. Remove created Timetable Entries
    if (allTimetableEntryIds.length) {
      await TimetableEntry.deleteMany(scope(ctx, { _id: { $in: allTimetableEntryIds } }));
    }

    // 2. Remove created Teaching Assignments
    if (allTeachingAssignmentIds.length) {
      await TeachingAssignment.deleteMany(scope(ctx, { _id: { $in: allTeachingAssignmentIds } }));
    }

    // 3. Remove created Sections (only if no student enrollments reference them)
    if (allSectionIds.length) {
      const enrolledSectionIds = await StudentEnrollment.distinct('sectionId', {
        schoolId: oid(ctx.schoolId),
        sectionId: { $in: allSectionIds },
      });
      const enrolledSet = new Set(enrolledSectionIds.map(String));
      const safeToDelete = allSectionIds.filter((id) => !enrolledSet.has(id.toString()));

      if (safeToDelete.length > 0) {
        await Section.deleteMany(scope(ctx, { _id: { $in: safeToDelete } }));
      }
    }

    // Mark batches rolled back
    for (const batch of batches) {
      batch.status = 'rolled_back';
      batch.rolledBackAt = new Date();
      batch.rolledBackBy = ctx.userId ? oid(ctx.userId) : undefined;
      batch.rollbackReason = input.reason.trim();
      await batch.save();
    }

    // Mark AcademicSession as rolled back
    await AcademicSession.updateOne(
      scope(ctx, { _id: oid(input.targetSessionId) }),
      { $set: { academicRolloverStatus: 'rolled_back' } },
    );

    await audit(ctx, {
      action: 'academic_rollover.rolled_back',
      entityType: 'AcademicRolloverBatch',
      entityId: batches[0]._id,
      metadata: {
        batchNumbers: batches.map((b) => b.batchNumber),
        targetSessionId: input.targetSessionId,
        reason: input.reason.trim(),
      },
    });

    return {
      success: true,
      batchId: batches[0]._id.toString(),
      batchNumber: batches[0].batchNumber,
      status: 'rolled_back',
    };
  });
}

export async function listAcademicRolloverBatches(ctx: Ctx, sessionId?: string) {
  const filter: Record<string, any> = {};
  if (sessionId) {
    filter.toSessionId = oid(sessionId);
  }

  const batches = await AcademicRolloverBatch.find(scope(ctx, filter))
    .populate('fromSessionId', 'name startDate endDate')
    .populate('toSessionId', 'name startDate endDate')
    .populate('executedBy', 'name email')
    .populate('rolledBackBy', 'name email')
    .sort({ executedAt: -1 })
    .lean();

  return batches;
}
