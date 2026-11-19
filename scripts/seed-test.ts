import mongoose, { Types } from 'mongoose';
import { connectDatabase } from '../src/database/connection';
import { onboardSchool } from '../src/modules/schools/schools.service';
import { User } from '../src/modules/users/user.model';
import { hashPassword } from '../src/modules/auth/tokens';
import { AcademicSession, SchoolClass, Section } from '../src/modules/academics/academics.models';
import { Student, StudentEnrollment } from '../src/modules/students/student.models';
import { Invoice } from '../src/modules/fees/fees.models';
import { School } from '../src/modules/schools/school.model';

export const TEST_SEED_PASSWORD = 'TestPassword123!';
export const TEST_SCHOOL_CODE = 'TSTSCH';

export async function seedTestDatabase() {
  console.log('[SEED-TEST] Connecting to test database...');
  await connectDatabase();

  const sid = await School.findOne({ code: TEST_SCHOOL_CODE });
  if (sid) {
    console.log('[SEED-TEST] School already exists, cleaning previous test data...');
    const sOid = sid._id;
    await Promise.all([
      User.deleteMany({ schoolId: sOid }),
      AcademicSession.deleteMany({ schoolId: sOid }),
      SchoolClass.deleteMany({ schoolId: sOid }),
      Section.deleteMany({ schoolId: sOid }),
      Student.deleteMany({ schoolId: sOid }),
      StudentEnrollment.deleteMany({ schoolId: sOid }),
      Invoice.deleteMany({ schoolId: sOid }),
      School.deleteOne({ _id: sOid }),
    ]);
  }

  console.log('[SEED-TEST] Onboarding test school...');
  const onboard = await onboardSchool({
    name: 'Test Foundation School',
    code: TEST_SCHOOL_CODE,
    city: 'Lahore',
    owner: {
      name: 'Test Administrator',
      email: 'admin@tstsch.example',
      password: TEST_SEED_PASSWORD,
    },
  });

  const schoolId = onboard.school._id as Types.ObjectId;
  const campusId = onboard.campus._id as Types.ObjectId;
  const pwHash = await hashPassword(TEST_SEED_PASSWORD);

  console.log('[SEED-TEST] Creating Teacher and Accountant users...');
  const teacherUser = await User.create({
    schoolId,
    name: 'Test Teacher',
    email: 'teacher@tstsch.example',
    passwordHash: pwHash,
    role: 'teacher',
    status: 'active',
    campusIds: [campusId],
  });

  const accountantUser = await User.create({
    schoolId,
    name: 'Test Accountant',
    email: 'accountant@tstsch.example',
    passwordHash: pwHash,
    role: 'accountant',
    status: 'active',
    campusIds: [campusId],
  });

  console.log('[SEED-TEST] Creating Academic Session, Classes and Sections...');
  const session = await AcademicSession.create({
    schoolId,
    name: '2026-2027',
    startDate: new Date('2026-04-01'),
    endDate: new Date('2027-03-31'),
    isCurrent: true,
  });

  const class1 = await SchoolClass.create({
    schoolId,
    campusId,
    name: 'Grade 1',
    level: 1,
    status: 'active',
  });

  const class2 = await SchoolClass.create({
    schoolId,
    campusId,
    name: 'Grade 2',
    level: 2,
    status: 'active',
  });

  const section1A = await Section.create({
    schoolId,
    campusId,
    classId: class1._id,
    sessionId: session._id,
    name: 'Section A',
  });

  const section2A = await Section.create({
    schoolId,
    campusId,
    classId: class2._id,
    sessionId: session._id,
    name: 'Section A',
  });

  console.log('[SEED-TEST] Creating 40 students with enrollments...');
  const studentIds: Types.ObjectId[] = [];
  for (let i = 1; i <= 40; i++) {
    const isClass1 = i <= 20;
    const assignedClass = isClass1 ? class1 : class2;
    const assignedSection = isClass1 ? section1A : section2A;
    const admNo = `ADM-2026-${String(i).padStart(3, '0')}`;

    const student = (await Student.create({
      schoolId,
      campusId,
      sessionId: session._id,
      classId: assignedClass._id,
      sectionId: assignedSection._id,
      admissionNo: admNo,
      firstName: `Student${i}`,
      lastName: 'Khan',
      gender: i % 2 === 0 ? 'female' : 'male',
      dateOfBirth: new Date('2018-05-15'),
      status: 'active',
      phone: `030012345${String(i).padStart(2, '0')}`,
    })) as any;

    studentIds.push(student._id as Types.ObjectId);

    await StudentEnrollment.create({
      schoolId,
      studentId: student._id,
      sessionId: session._id,
      classId: assignedClass._id,
      sectionId: assignedSection._id,
      rollNo: String((i - 1) % 20 + 1),
      status: 'active',
    });
  }

  console.log('[SEED-TEST] Creating 2 test invoices...');
  await Invoice.create({
    schoolId,
    campusId,
    sessionId: session._id,
    classId: class1._id,
    sectionId: section1A._id,
    studentId: studentIds[0],
    invoiceNo: 'INV-2026-0001',
    period: '2026-04',
    issueDate: new Date('2026-04-01'),
    dueDate: new Date('2026-04-10'),
    subtotal: 5000,
    total: 5000,
    paid: 0,
    balance: 5000,
    status: 'unpaid',
    items: [{ name: 'Monthly Tuition Fee', amount: 5000 }],
  });

  await Invoice.create({
    schoolId,
    campusId,
    sessionId: session._id,
    classId: class1._id,
    sectionId: section1A._id,
    studentId: studentIds[1],
    invoiceNo: 'INV-2026-0002',
    period: '2026-04',
    issueDate: new Date('2026-04-01'),
    dueDate: new Date('2026-04-10'),
    subtotal: 5000,
    total: 5000,
    paid: 0,
    balance: 5000,
    status: 'unpaid',
    items: [{ name: 'Monthly Tuition Fee', amount: 5000 }],
  });

  console.log('[SEED-TEST] Test database successfully seeded!');
  return {
    schoolId: schoolId.toString(),
    campusId: campusId.toString(),
    adminEmail: 'admin@tstsch.example',
    teacherEmail: 'teacher@tstsch.example',
    accountantEmail: 'accountant@tstsch.example',
    password: TEST_SEED_PASSWORD,
    studentCount: 40,
    invoiceCount: 2,
  };
}

if (require.main === module) {
  seedTestDatabase()
    .then((res) => {
      console.log('Seed summary:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
