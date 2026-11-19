import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import type { SchoolContext } from '../../types/context';
import { badRequest } from '../../utils/errors';
import { oid, scope } from '../../utils/tenant';
import { AcademicSession, SchoolClass, Section, Subject, TeachingAssignment } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { FeeStructure } from '../fees/fees.models';
import { School } from '../schools/school.model';
import { Student } from '../students/student.models';
import { TimetableEntry } from '../timetable/timetable.model';
import { User } from '../users/user.model';

/**
 * Per-school setup-guide state. A step is complete when its page has been opened (`visited`)
 * or when the school's data already shows the work is done, whichever comes first, so the
 * guide never makes people wait. The data checks still run on every request and are shown as
 * the step's detail (for example "Missing: phone"). Also stored: the guide's display state, the
 * first time each step was completed, and manual confirmations.
 */
const OnboardingStateSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      minimized: { type: Boolean, default: false },
      dismissedAt: { type: Date },
      completedAt: { type: Map, of: Date, default: {} },
      acknowledged: { type: [String], default: [] },
      /** Steps whose page has been opened. Opening the page completes the step. */
      visited: { type: [String], default: [] },
      updatedBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
OnboardingStateSchema.index({ schoolId: 1 }, { unique: true, name: 'one_guide_per_school' });
export const OnboardingState = model('OnboardingState', OnboardingStateSchema);

export type StepStatus = 'complete' | 'incomplete' | 'attention' | 'blocked';

interface StepDef {
  key: string;
  title: string;
  description: string;
  required: boolean;
  dependsOn: string[];
  action: { label: string; href: string };
  /** Steps confirmed by the user rather than detected from data. */
  manual?: boolean;
}

/**
 * Order follows the data model: a section needs a session and a class; a teaching assignment
 * needs a section, a subject and a teacher; a student needs a section; fees are per class and
 * session; parent and student logins are created at admission.
 */
export const STEPS: StepDef[] = [
  {
    key: 'school_profile',
    title: 'Check your school profile',
    description:
      'Add the school phone number, city and address. They appear on fee challans, report cards and certificates.',
    required: true,
    dependsOn: [],
    action: { label: 'Open school profile', href: '/settings?tab=profile' },
  },
  {
    key: 'academic_session',
    title: 'Create the academic session',
    description:
      'A session is the school year, for example "2026-2027". Classes, students, fees and exams all belong to a session.',
    required: true,
    dependsOn: [],
    action: { label: 'Add session', href: '/academics?tab=sessions' },
  },
  {
    key: 'classes',
    title: 'Add your classes',
    description: 'Add every class you teach, such as Playgroup, Nursery, Class 1 to Class 10.',
    required: true,
    dependsOn: [],
    action: { label: 'Add class', href: '/academics?tab=classes' },
  },
  {
    key: 'sections',
    title: 'Add sections to each class',
    description:
      'Each class needs at least one section (A, B, Blue, Red...) in the current session. Students are admitted into a section.',
    required: true,
    dependsOn: ['academic_session', 'classes'],
    action: { label: 'Add section', href: '/academics?tab=sections' },
  },
  {
    key: 'subjects',
    title: 'Add subjects',
    description: 'Add the subjects taught (English, Urdu, Mathematics...) and tick the classes that study each one.',
    required: true,
    dependsOn: ['classes'],
    action: { label: 'Add subject', href: '/academics?tab=subjects' },
  },
  {
    key: 'staff',
    title: 'Register teachers and staff',
    description:
      'Add your teachers. Each teacher gets their own login automatically; office staff get a login only if you choose.',
    required: true,
    dependsOn: [],
    action: { label: 'Add teacher', href: '/staff?add=teaching' },
  },
  {
    key: 'teaching_assignments',
    title: 'Assign teachers to subjects',
    description:
      'Choose who teaches each subject in each section. Teachers can only see and manage the classes they are assigned to.',
    required: true,
    dependsOn: ['sections', 'subjects', 'staff'],
    action: { label: 'Assign teachers', href: '/academics?tab=assignments' },
  },
  {
    key: 'timetable',
    title: 'Make the timetable',
    description: 'Optional. Add the weekly periods for each section so teachers and parents can see the schedule.',
    required: false,
    dependsOn: ['teaching_assignments'],
    action: { label: 'Open timetable', href: '/timetable' },
  },
  {
    key: 'fees',
    title: 'Set up fees',
    description:
      'Recommended. Add fee heads (tuition, admission...) and the amount for each class, so monthly challans can be generated.',
    required: false,
    dependsOn: ['academic_session', 'classes'],
    action: { label: 'Set up fees', href: '/fees?tab=setup' },
  },
  {
    key: 'students',
    title: 'Admit students',
    description:
      'Admit students into their class and section with their parent details. Parent and student logins are created automatically.',
    required: true,
    dependsOn: ['sections'],
    action: { label: 'Admit student', href: '/students/new' },
  },
  {
    key: 'accounts',
    title: 'Share login links with parents and teachers',
    description:
      'New logins wait for activation. Open Users, copy each person’s activation link and send it to them (for example on WhatsApp).',
    required: false,
    dependsOn: ['students'],
    action: { label: 'Open users', href: '/settings?tab=users' },
  },
  {
    key: 'review_modules',
    title: 'Look around attendance, homework and exams',
    description: 'Optional. Visit Attendance, Homework and Exams to see how daily work is done.',
    required: false,
    dependsOn: [],
    manual: true,
    action: { label: 'Open attendance', href: '/attendance' },
  },
];

interface Evaluation {
  done: boolean;
  detail?: string;
  progress?: { done: number; total: number };
}

async function evaluate(ctx: SchoolContext, acknowledged: Set<string>): Promise<Record<string, Evaluation>> {
  const school = await School.findById(ctx.schoolId).select('phone address city settings.currentSessionId').lean();
  const sessionId = school?.settings?.currentSessionId ?? null;
  const session = sessionId
    ? await AcademicSession.findOne(scope(ctx, { _id: sessionId }))
        .select('_id name')
        .lean()
    : null;
  const [
    classes,
    sections,
    subjects,
    teachers,
    assignments,
    timetable,
    feeStructures,
    students,
    pending,
    activeParents,
  ] = await Promise.all([
    SchoolClass.find(scope(ctx, { status: 'active' }))
      .select('_id name')
      .lean(),
    session
      ? Section.find(scope(ctx, { sessionId: session._id }))
          .select('_id classId')
          .lean()
      : [],
    Subject.find(scope(ctx)).select('_id classIds').lean(),
    Employee.countDocuments(scope(ctx, { staffType: 'teaching', status: 'active' })),
    session
      ? TeachingAssignment.find(scope(ctx, { sessionId: session._id }))
          .select('sectionId subjectId')
          .lean()
      : [],
    session ? TimetableEntry.countDocuments(scope(ctx, { sessionId: session._id })) : 0,
    session
      ? FeeStructure.find(scope(ctx, { sessionId: session._id }))
          .select('classId')
          .lean()
      : [],
    session ? Student.countDocuments(scope(ctx, { sessionId: session._id, status: 'active' })) : 0,
    User.countDocuments(scope(ctx, { status: 'pending' })),
    User.countDocuments(scope(ctx, { role: 'parent', status: 'active' })),
  ]);

  const missingProfile = (['phone', 'city', 'address'] as const).filter((f) => !school?.[f]);
  const classIdsWithSection = new Set(sections.map((s) => s.classId.toString()));
  const classesWithoutSection = classes.filter((c) => !classIdsWithSection.has(c._id.toString()));
  const subjectsFor = (classId: string) =>
    subjects.filter((s) => !s.classIds?.length || s.classIds.map(String).includes(classId));
  const classesWithoutSubject = classes.filter((c) => subjectsFor(c._id.toString()).length === 0);
  const assigned = new Set(assignments.map((a) => `${a.sectionId}:${a.subjectId}`));
  let pairs = 0;
  let covered = 0;
  for (const sec of sections)
    for (const sub of subjectsFor(sec.classId.toString())) {
      pairs++;
      if (assigned.has(`${sec._id}:${sub._id}`)) covered++;
    }
  const classesWithFees = new Set(feeStructures.map((f) => f.classId.toString()));
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  return {
    school_profile: {
      done: missingProfile.length === 0,
      detail: missingProfile.length ? `Missing: ${missingProfile.join(', ')}` : undefined,
    },
    academic_session: {
      done: Boolean(session),
      detail: session ? `Current session: ${session.name}` : 'No current session is set',
    },
    classes: {
      done: classes.length > 0,
      detail: classes.length ? plural(classes.length, 'class', 'classes') : undefined,
    },
    sections: {
      done: classes.length > 0 && Boolean(session) && classesWithoutSection.length === 0,
      progress: { done: classes.length - classesWithoutSection.length, total: classes.length },
      detail: classesWithoutSection.length
        ? `No section yet: ${classesWithoutSection
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ')}${classesWithoutSection.length > 5 ? '…' : ''}`
        : undefined,
    },
    subjects: {
      done: subjects.length > 0 && classesWithoutSubject.length === 0,
      progress: { done: classes.length - classesWithoutSubject.length, total: classes.length },
      detail: classesWithoutSubject.length
        ? `No subjects yet: ${classesWithoutSubject
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ')}${classesWithoutSubject.length > 5 ? '…' : ''}`
        : subjects.length
          ? plural(subjects.length, 'subject')
          : undefined,
    },
    staff: { done: teachers > 0, detail: teachers ? plural(teachers, 'teacher') : undefined },
    teaching_assignments: {
      done: pairs > 0 && covered === pairs,
      progress: { done: covered, total: pairs },
      detail: pairs ? `${covered} of ${pairs} class subjects have a teacher` : undefined,
    },
    timetable: { done: timetable > 0, detail: timetable ? plural(timetable, 'period') : undefined },
    fees: {
      done: classes.length > 0 && classes.every((c) => classesWithFees.has(c._id.toString())),
      progress: { done: classes.filter((c) => classesWithFees.has(c._id.toString())).length, total: classes.length },
    },
    students: { done: students > 0, detail: students ? plural(students, 'student') : undefined },
    accounts: {
      done: students > 0 && activeParents > 0 && pending === 0,
      detail: pending
        ? `${plural(pending, 'login')} waiting for activation`
        : activeParents
          ? undefined
          : 'No parent has signed in yet',
    },
    review_modules: { done: acknowledged.has('review_modules') },
  };
}

export async function getOnboarding(ctx: SchoolContext) {
  // Created on first use: every school (including ones created before this feature) has a guide.
  const state = await OnboardingState.findOneAndUpdate(
    scope(ctx),
    { $setOnInsert: { schoolId: oid(ctx.schoolId) } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  const acknowledged = new Set<string>(state!.acknowledged ?? []);
  const visited = new Set<string>((state as { visited?: string[] }).visited ?? []);
  const completedAt = new Map<string, Date>(
    Object.entries((state!.completedAt as unknown as Record<string, Date>) ?? {}),
  );
  const results = await evaluate(ctx, acknowledged);
  for (const key of visited) if (results[key]) results[key] = { ...results[key], done: true };

  const newlyDone: Record<string, Date> = {};
  const status = new Map<string, StepStatus>();
  for (const s of STEPS) {
    const r = results[s.key];
    const blocked = s.dependsOn.some((d) => !results[d]?.done);
    let st: StepStatus = r.done ? 'complete' : completedAt.has(s.key) ? 'attention' : 'incomplete';
    if (!r.done && blocked && !completedAt.has(s.key)) st = 'blocked';
    status.set(s.key, st);
    if (r.done && !completedAt.has(s.key)) newlyDone[`completedAt.${s.key}`] = new Date();
  }
  if (Object.keys(newlyDone).length) await OnboardingState.updateOne(scope(ctx), { $set: newlyDone });

  const steps = STEPS.map((s, i) => ({
    key: s.key,
    number: i + 1,
    title: s.title,
    description: s.description,
    required: s.required,
    manual: Boolean(s.manual),
    dependsOn: s.dependsOn,
    action: s.action,
    status: status.get(s.key)!,
    detail: results[s.key].detail ?? null,
    progress: results[s.key].progress ?? null,
    completedAt: (newlyDone[`completedAt.${s.key}`] ?? completedAt.get(s.key))?.toISOString() ?? null,
    blockedBy: s.dependsOn.filter((d) => !results[d]?.done),
  }));
  const required = steps.filter((s) => s.required);
  return {
    steps,
    summary: {
      done: steps.filter((s) => s.status === 'complete').length,
      total: steps.length,
      requiredDone: required.filter((s) => s.status === 'complete').length,
      requiredTotal: required.length,
      allRequiredComplete: required.every((s) => s.status === 'complete'),
      nextStep:
        steps.find((s) => s.required && s.status !== 'complete')?.key ??
        steps.find((s) => s.status !== 'complete')?.key ??
        null,
    },
    state: {
      minimized: Boolean(state!.minimized),
      dismissed: Boolean(state!.dismissedAt),
      dismissedAt: state!.dismissedAt?.toISOString() ?? null,
    },
  };
}

export async function updateOnboardingState(ctx: SchoolContext, input: { minimized?: boolean; dismissed?: boolean }) {
  const set: Record<string, unknown> = { updatedBy: oid(ctx.userId) };
  const unset: Record<string, 1> = {};
  if (input.minimized !== undefined) set.minimized = input.minimized;
  if (input.dismissed === true) set.dismissedAt = new Date();
  if (input.dismissed === false) {
    unset.dismissedAt = 1;
    set.minimized = false;
  }
  await OnboardingState.updateOne(
    scope(ctx),
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $setOnInsert: { schoolId: oid(ctx.schoolId) },
    },
    { upsert: true },
  );
  if (input.dismissed !== undefined)
    await audit(ctx, {
      action: input.dismissed ? 'onboarding.dismissed' : 'onboarding.resumed',
      entityType: 'School',
      entityId: ctx.schoolId,
    });
  return getOnboarding(ctx);
}

export async function acknowledgeStep(ctx: SchoolContext, key: string, acknowledged: boolean) {
  const step = STEPS.find((s) => s.key === key);
  if (!step) throw badRequest('Unknown setup step');
  if (!step.manual) throw badRequest('This step is completed automatically when the work is done');
  await OnboardingState.updateOne(
    scope(ctx),
    {
      ...(acknowledged ? { $addToSet: { acknowledged: key } } : { $pull: { acknowledged: key, visited: key } }),
      ...(acknowledged ? {} : { $unset: { [`completedAt.${key}`]: 1 } }),
      $setOnInsert: { schoolId: oid(ctx.schoolId) },
    },
    { upsert: true },
  );
  return getOnboarding(ctx);
}

/** Opening a step's page completes it. Idempotent; unknown keys are rejected by the route. */
export async function visitStep(ctx: SchoolContext, key: string) {
  if (!STEPS.some((s) => s.key === key)) throw badRequest('Unknown setup step');
  await OnboardingState.updateOne(
    scope(ctx),
    { $addToSet: { visited: key }, $setOnInsert: { schoolId: oid(ctx.schoolId) } },
    { upsert: true },
  );
  return getOnboarding(ctx);
}
