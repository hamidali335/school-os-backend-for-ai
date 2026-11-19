import { beforeAll, describe, expect, it } from 'vitest';
import { api, buildSchool, type SchoolFixture } from './fixtures';
import { useTestApp } from './helpers';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from '../src/modules/academics/academics.models';
import { Employee } from '../src/modules/employees/employee.model';
import { TimetableEntry } from '../src/modules/timetable/timetable.model';
import { AcademicRolloverBatch } from '../src/modules/academics/academic-rollover-batch.model';
import { AttendanceRecord } from '../src/modules/attendance/attendance.model';
import { Exam } from '../src/modules/examinations/exam.models';
import { Homework } from '../src/modules/homework/homework.models';
import { User } from '../src/modules/users/user.model';

const t = useTestApp();
let s1: SchoolFixture;
let s2: SchoolFixture;

let targetSession: any;
let class6: any;
let sec6A: any;

let scienceSub: any;

let teacherActive2: any;
let teacherResigned: any;

let assignmentScience: any;
let assignmentResigned: any;

let timetable1: any;
let timetable2: any;

beforeAll(async () => {
  s1 = await buildSchool(t.app, { students: 2 });
  s2 = await buildSchool(t.app, { students: 1 });

  // 1. Create target session for School 1
  targetSession = await api(t.app, s1.ownerToken, 'post', '/academics/sessions', {
    name: '2027-2028',
    startDate: '2027-04-01',
    endDate: '2028-03-31',
    status: 'planned',
  });

  // 2. Additional Class in School 1
  class6 = await api(t.app, s1.ownerToken, 'post', '/academics/classes', {
    campusId: s1.campusId,
    name: 'Class 6',
    level: 6,
  });

  // 3. Additional Teachers
  teacherActive2 = await api(t.app, s1.ownerToken, 'post', '/employees', {
    campusId: s1.campusId,
    employeeNo: 'T-102',
    firstName: 'Fatima',
    lastName: 'Ali',
    designation: 'Science Teacher',
    staffType: 'teaching',
    status: 'active',
  });

  teacherResigned = await Employee.create({
    schoolId: s1.schoolId,
    campusId: s1.campusId,
    employeeNo: 'T-103',
    firstName: 'Tariq',
    lastName: 'Mahmood',
    designation: 'Former Teacher',
    staffType: 'teaching',
    status: 'resigned',
  });

  // Update Section A room & class teacher
  await api(t.app, s1.ownerToken, 'patch', `/academics/sections/${s1.sectionA}`, {
    room: 'Room-101',
    classTeacherId: s1.teacherEmployeeId,
  });

  // Update Section B room & resigned teacher
  await api(t.app, s1.ownerToken, 'patch', `/academics/sections/${s1.sectionB}`, {
    room: 'Room-102',
    classTeacherId: teacherResigned._id,
  });

  sec6A = await api(t.app, s1.ownerToken, 'post', '/academics/sections', {
    campusId: s1.campusId,
    classId: class6._id,
    sessionId: s1.sessionId,
    name: 'A',
    capacity: 38,
    room: 'Room-201',
    classTeacherId: teacherActive2._id,
  });

  // 4. Additional Subject
  scienceSub = await api(t.app, s1.ownerToken, 'post', '/academics/subjects', {
    name: 'General Science',
    code: 'SCI-56',
    classIds: [s1.classId, class6._id],
    isElective: false,
  });

  // 5. Source session Teaching Assignments
  // assignment for Math in sectionA already created by buildSchool
  assignmentScience = await api(t.app, s1.ownerToken, 'post', '/academics/teaching-assignments', {
    sectionId: s1.sectionA,
    subjectId: scienceSub._id,
    teacherId: teacherActive2._id,
  });

  // Direct insert resigned teacher assignment into source session to simulate historical record
  assignmentResigned = await TeachingAssignment.create({
    schoolId: s1.schoolId,
    sessionId: s1.sessionId,
    sectionId: s1.sectionB,
    subjectId: s1.englishId,
    teacherId: teacherResigned._id,
  });

  // 6. Source session Timetable Entries
  timetable1 = await api(t.app, s1.ownerToken, 'post', '/timetable', {
    sectionId: s1.sectionA,
    subjectId: s1.mathId,
    teacherId: s1.teacherEmployeeId,
    dayOfWeek: 1, // Monday
    startTime: '08:00',
    endTime: '08:45',
    room: 'Room-101',
  });

  timetable2 = await api(t.app, s1.ownerToken, 'post', '/timetable', {
    sectionId: s1.sectionA,
    subjectId: scienceSub._id,
    teacherId: teacherActive2._id,
    dayOfWeek: 1, // Monday
    startTime: '08:45',
    endTime: '09:30',
    room: 'Room-101',
  });
});

describe('Phase 4: Academic Rollover Preview & Architecture Foundation', () => {
  it('previews section continuity, teacher assignments, subjects, and timetable carry-forward', async () => {
    const res = await api(
      t.app,
      s1.ownerToken,
      'get',
      `/academics/rollover/preview?fromSessionId=${s1.sessionId}&toSessionId=${targetSession._id}`,
    );

    expect(res.fromSession.name).toBe('2026-2027');
    expect(res.toSession.name).toBe('2027-2028');

    // Section continuity metrics (Class 5 A, Class 5 B, Class 6 A)
    expect(res.summary.totalSections).toBe(3);
    expect(res.summary.newSectionsToCreate).toBe(3);
    expect(res.summary.reusedSections).toBe(0);

    // Inactive teacher detected with warning
    expect(res.summary.missingTeachersCount).toBeGreaterThanOrEqual(1);
    const resignedAssignment = res.teachingAssignments.find(
      (a: any) => a.subjectCode === 'ENG' || a.subjectName === 'English',
    );
    expect(resignedAssignment).toBeDefined();
    expect(resignedAssignment.teacherStatus).toBe('resigned');
    expect(resignedAssignment.status).toBe('warning');

    // Timetable carry-forward preview
    expect(res.summary.totalTimetablePeriods).toBe(2);
    expect(res.summary.conflictsCount).toBe(0);
    expect(res.canExecute).toBe(true);
  });

  it('detects timetable conflicts when overlapping period exists', async () => {
    // Add conflicting timetable entry in source session (same teacher as timetable1, same day, overlapping time)
    const conflictingEntry = await TimetableEntry.create({
      schoolId: s1.schoolId,
      sessionId: s1.sessionId,
      campusId: s1.campusId,
      sectionId: sec6A._id,
      subjectId: s1.mathId,
      teacherId: s1.teacherEmployeeId, // same teacher as timetable1 (08:00 - 08:45)
      dayOfWeek: 1,
      startTime: '08:15',
      endTime: '09:00',
      startMinutes: 495,
      endMinutes: 540,
      room: 'Room-201',
    });

    try {
      const res = await api(
        t.app,
        s1.ownerToken,
        'get',
        `/academics/rollover/preview?fromSessionId=${s1.sessionId}&toSessionId=${targetSession._id}`,
      );

      expect(res.summary.conflictsCount).toBeGreaterThanOrEqual(1);
      expect(res.overallStatus).toBe('conflict');
      expect(res.canExecute).toBe(false);
    } finally {
      await TimetableEntry.deleteOne({ schoolId: s1.schoolId, _id: conflictingEntry._id });
    }
  });

  it('detects room double-booking conflict on overlapping periods', async () => {
    // Add conflicting room booking: different section and teacher, but same room and overlapping time
    const roomClashEntry = await TimetableEntry.create({
      schoolId: s1.schoolId,
      sessionId: s1.sessionId,
      campusId: s1.campusId,
      sectionId: sec6A._id,
      subjectId: scienceSub._id,
      teacherId: teacherActive2._id,
      dayOfWeek: 1,
      startTime: '08:00',
      endTime: '08:45',
      startMinutes: 480,
      endMinutes: 525,
      room: 'Room-101', // Room-101 is already booked by secA at 08:00-08:45
    });

    try {
      const res = await api(
        t.app,
        s1.ownerToken,
        'get',
        `/academics/rollover/preview?fromSessionId=${s1.sessionId}&toSessionId=${targetSession._id}`,
      );

      expect(res.summary.conflictsCount).toBeGreaterThanOrEqual(1);
      const roomConflict = res.conflicts.find((c: any) => c.type === 'room');
      expect(roomConflict).toBeDefined();
      expect(roomConflict.message).toContain('Room is already booked');
    } finally {
      await TimetableEntry.deleteOne({ schoolId: s1.schoolId, _id: roomClashEntry._id });
    }
  });
});

describe('Phase 4: Academic Rollover Execution & Section/Assignment Continuity', () => {
  it('executes rollover with teacher replacement and custom room allocation', async () => {
    // Replace resigned teacher with active teacher 2 for English
    const res = await api(t.app, s1.ownerToken, 'post', '/academics/rollover/execute', {
      fromSessionId: s1.sessionId,
      toSessionId: targetSession._id,
      includeSections: true,
      includeTeacherAssignments: true,
      includeTimetable: true,
      teacherOverrides: [
        {
          sectionClassId: s1.classId,
          sectionName: 'B',
          subjectId: s1.englishId,
          teacherId: teacherActive2._id,
        },
      ],
      roomOverrides: [
        {
          sectionClassId: s1.classId,
          sectionName: 'A',
          room: 'Room-101-Renovated',
        },
      ],
    });

    expect(res.success).toBe(true);
    expect(res.batchNumber).toMatch(/^ARB-\d{4}-\d{3}$/);
    expect(res.summary.sectionsCreated).toBe(3);
    expect(res.summary.teachingAssignmentsCreated).toBe(3);
    expect(res.summary.timetableEntriesCreated).toBe(2);

    // Verify target session sections exist
    const targetSections = await Section.find({ schoolId: s1.schoolId, sessionId: targetSession._id }).lean();
    expect(targetSections.length).toBe(3);

    const targetSec5A = targetSections.find((s) => s.name === 'A' && String(s.classId) === String(s1.classId));
    expect(targetSec5A).toBeDefined();
    expect(targetSec5A?.room).toBe('Room-101-Renovated'); // Room override applied
    expect(String(targetSec5A?.classTeacherId)).toBe(String(s1.teacherEmployeeId));

    // Verify target session teaching assignments
    const targetAssignments = await TeachingAssignment.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).lean();
    expect(targetAssignments.length).toBe(3);

    // Verify replaced teacher on Class 5B English
    const targetSec5B = targetSections.find((s) => s.name === 'B' && String(s.classId) === String(s1.classId));
    const targetEngAssignment = targetAssignments.find(
      (a) => String(a.sectionId) === String(targetSec5B?._id) && String(a.subjectId) === String(s1.englishId),
    );
    expect(targetEngAssignment).toBeDefined();
    expect(String(targetEngAssignment?.teacherId)).toBe(String(teacherActive2._id)); // replaced!

    // Verify target session timetables
    const targetTimetables = await TimetableEntry.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).lean();
    expect(targetTimetables.length).toBe(2);
    expect(targetTimetables[0].dayOfWeek).toBe(1);
    expect(targetTimetables[0].startTime).toBe('08:00');
    expect(targetTimetables[0].endTime).toBe('08:45');

    // Verify target AcademicSession status updated
    const updatedSession = await AcademicSession.findOne({ schoolId: s1.schoolId, _id: targetSession._id }).lean();
    expect(updatedSession?.academicRolloverStatus).toBe('completed');
  });

  it('preserves historical source session records completely unchanged', async () => {
    // Check source sections
    const srcSections = await Section.find({ schoolId: s1.schoolId, sessionId: s1.sessionId }).lean();
    expect(srcSections.length).toBe(3);
    const src5A = srcSections.find((s) => s.name === 'A' && String(s.classId) === String(s1.classId));
    expect(src5A?.room).toBe('Room-101'); // Original room untouched!

    // Check source teaching assignments
    const srcAssignments = await TeachingAssignment.find({
      schoolId: s1.schoolId,
      sessionId: s1.sessionId,
    }).lean();
    expect(srcAssignments.length).toBe(3);
    const srcEngAssignment = srcAssignments.find((a) => String(a.subjectId) === String(s1.englishId));
    expect(String(srcEngAssignment?.teacherId)).toBe(String(teacherResigned._id)); // Resigned teacher still historical teacher!

    // Check source timetables
    const srcTimetables = await TimetableEntry.find({ schoolId: s1.schoolId, sessionId: s1.sessionId }).lean();
    expect(srcTimetables.length).toBe(2);
  });

  it('guarantees idempotency on repeated execution without duplicates', async () => {
    const res = await api(t.app, s1.ownerToken, 'post', '/academics/rollover/execute', {
      fromSessionId: s1.sessionId,
      toSessionId: targetSession._id,
      includeSections: true,
      includeTeacherAssignments: true,
      includeTimetable: true,
    });

    expect(res.success).toBe(true);
    expect(res.summary.sectionsCreated).toBe(0); // 0 new sections created (all 3 reused)
    expect(res.summary.sectionsReused).toBe(3);
    expect(res.summary.teachingAssignmentsCreated).toBe(0); // 0 duplicate assignments
    expect(res.summary.timetableEntriesCreated).toBe(0); // 0 duplicate timetable entries

    // Total counts in target session remain unchanged
    const targetSections = await Section.find({ schoolId: s1.schoolId, sessionId: targetSession._id }).countDocuments();
    expect(targetSections).toBe(3);

    const targetAssignments = await TeachingAssignment.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).countDocuments();
    expect(targetAssignments).toBe(3);
  });

  it('enforces multi-tenant isolation and rejects cross-tenant rollover', async () => {
    // School 2 attempts to rollover School 1's sessions
    await expect(
      api(t.app, s2.ownerToken, 'post', '/academics/rollover/execute', {
        fromSessionId: s1.sessionId,
        toSessionId: targetSession._id,
      }),
    ).rejects.toThrow();

    // School 1 attempts to rollover School 2's session as target
    await expect(
      api(t.app, s1.ownerToken, 'post', '/academics/rollover/execute', {
        fromSessionId: s1.sessionId,
        toSessionId: s2.sessionId,
      }),
    ).rejects.toThrow();
  });
});

describe('Phase 4: Safe Rollback & Dependency Protection', () => {
  it('blocks rollback when dependent student attendance exists in target session', async () => {
    const targetSec = await Section.findOne({ schoolId: s1.schoolId, sessionId: targetSession._id }).lean();
    expect(targetSec).toBeDefined();

    // Create student attendance record in target session
    const att = await AttendanceRecord.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      sessionId: targetSession._id,
      classId: targetSec!.classId,
      sectionId: targetSec!._id,
      studentId: s1.students[0],
      date: new Date('2027-04-10'),
      status: 'present',
    });

    const check = await api(
      t.app,
      s1.ownerToken,
      'get',
      `/academics/rollover/rollback-check?targetSessionId=${targetSession._id}`,
    );

    expect(check.canRollback).toBe(false);
    expect(check.blockers.length).toBeGreaterThanOrEqual(1);
    expect(check.blockers[0].type).toBe('attendance');

    // Attempting rollback throws conflict
    await expect(
      api(t.app, s1.ownerToken, 'post', '/academics/rollover/rollback', {
        targetSessionId: targetSession._id,
        reason: 'Attempting rollback with attendance',
      }),
    ).rejects.toThrow();

    // Clean up attendance record for next guard test
    await AttendanceRecord.deleteOne({ schoolId: s1.schoolId, _id: att._id });
  });

  it('blocks rollback when dependent exam exists in target session', async () => {
    const exam = await Exam.create({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
      name: 'Midterm Exam 2027',
      startDate: new Date('2027-09-01'),
      endDate: new Date('2027-09-15'),
      status: 'draft',
    });

    const check = await api(
      t.app,
      s1.ownerToken,
      'get',
      `/academics/rollover/rollback-check?targetSessionId=${targetSession._id}`,
    );

    expect(check.canRollback).toBe(false);
    expect(check.blockers.find((b: any) => b.type === 'exams')).toBeDefined();

    await expect(
      api(t.app, s1.ownerToken, 'post', '/academics/rollover/rollback', {
        targetSessionId: targetSession._id,
        reason: 'Attempting rollback with exam',
      }),
    ).rejects.toThrow();

    await Exam.deleteOne({ schoolId: s1.schoolId, _id: exam._id });
  });

  it('blocks rollback when dependent homework exists in target session', async () => {
    const targetSec = await Section.findOne({ schoolId: s1.schoolId, sessionId: targetSession._id }).lean();
    const anyUser = await User.findOne({ schoolId: s1.schoolId }).lean();
    const hw = await Homework.create({
      schoolId: s1.schoolId,
      campusId: s1.campusId,
      sessionId: targetSession._id,
      sectionId: targetSec!._id,
      subjectId: s1.mathId,
      title: 'Summer Assignment',
      description: 'Solve questions 1-10',
      assignedOn: new Date('2027-06-01'),
      dueDate: new Date('2027-06-15'),
      createdBy: anyUser!._id,
    });

    const check = await api(
      t.app,
      s1.ownerToken,
      'get',
      `/academics/rollover/rollback-check?targetSessionId=${targetSession._id}`,
    );

    expect(check.canRollback).toBe(false);
    expect(check.blockers.find((b: any) => b.type === 'homework')).toBeDefined();

    await expect(
      api(t.app, s1.ownerToken, 'post', '/academics/rollover/rollback', {
        targetSessionId: targetSession._id,
        reason: 'Attempting rollback with homework',
      }),
    ).rejects.toThrow();

    await Homework.deleteOne({ schoolId: s1.schoolId, _id: hw._id });
  });

  it('executes clean rollback when unblocked, preserving historical session data', async () => {
    const check = await api(
      t.app,
      s1.ownerToken,
      'get',
      `/academics/rollover/rollback-check?targetSessionId=${targetSession._id}`,
    );
    expect(check.canRollback).toBe(true);

    const res = await api(t.app, s1.ownerToken, 'post', '/academics/rollover/rollback', {
      targetSessionId: targetSession._id,
      reason: 'Administrative schedule revision before term starts',
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe('rolled_back');

    // Verify target timetables removed
    const targetTimetables = await TimetableEntry.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).countDocuments();
    expect(targetTimetables).toBe(0);

    // Verify target assignments removed
    const targetAssignments = await TeachingAssignment.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).countDocuments();
    expect(targetAssignments).toBe(0);

    // Verify target sections removed (since no students were enrolled)
    const targetSections = await Section.find({
      schoolId: s1.schoolId,
      sessionId: targetSession._id,
    }).countDocuments();
    expect(targetSections).toBe(0);

    // Verify target session status is rolled_back
    const targetSessionDoc = await AcademicSession.findOne({ schoolId: s1.schoolId, _id: targetSession._id }).lean();
    expect(targetSessionDoc?.academicRolloverStatus).toBe('rolled_back');

    // Verify historical source session remains 100% intact
    const srcSections = await Section.find({ schoolId: s1.schoolId, sessionId: s1.sessionId }).countDocuments();
    expect(srcSections).toBe(3);

    const srcAssignments = await TeachingAssignment.find({
      schoolId: s1.schoolId,
      sessionId: s1.sessionId,
    }).countDocuments();
    expect(srcAssignments).toBe(3);

    const srcTimetables = await TimetableEntry.find({
      schoolId: s1.schoolId,
      sessionId: s1.sessionId,
    }).countDocuments();
    expect(srcTimetables).toBe(2);
  });
});
