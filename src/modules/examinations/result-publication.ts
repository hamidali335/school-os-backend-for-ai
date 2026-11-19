import type { SchoolContext, SystemContext } from '../../types/context';
import { findOwned, scope } from '../../utils/tenant';
import { SchoolClass, Section, Subject } from '../academics/academics.models';
import { Student } from '../students/student.models';
import { Exam, ExamPaper, Mark } from './exam.models';

type Actor = SchoolContext | SystemContext;

/** At most this many student names are listed per section and subject (the count is exact). */
const NAMES_PER_GROUP = 50;

export type ReadinessStudent = { studentId: string; name: string; admissionNo: string; rollNo?: string };

export type ReadinessGroup = {
  classId: string;
  className: string;
  sectionId: string;
  sectionName: string;
  paperId: string;
  subject: string;
  /** Number of students in the section roster for this paper. */
  roster: number;
  /** No marks and no Absent status saved. */
  missingCount: number;
  missing: ReadinessStudent[];
  /** Saved marks outside 0..maxMarks (should not happen; checked defensively). */
  invalidCount: number;
  invalid: Array<ReadinessStudent & { obtained: number; maxMarks: number }>;
};

/**
 * Can this exam's results be published? Every active student in the roster of every paper
 * (the same roster teachers see when entering marks) needs either valid marks within
 * 0..maxMarks or an explicit Absent status, and in an elective paper possibly an explicit
 * "Not taken" (the student does not take the subject). A blank is never treated as zero,
 * absent or not taken: the school has no list of who takes which elective, so whoever enters
 * the marks records it, and the entry is in the audit log.
 *
 * `electiveGaps` lists the elective papers with blanks again, for the screen to explain that
 * "Not taken" resolves them; they block publication like any other blank.
 */
export async function publishReadiness(actor: Actor, examId: string) {
  const exam = await findOwned(Exam, actor, examId, 'Exam');
  const papers = await ExamPaper.find(scope(actor, { examId: exam._id })).lean();
  const classIds = [...new Set(papers.map((p) => p.classId.toString()))];
  const [subjects, classes, sections, students, marks] = await Promise.all([
    Subject.find(scope(actor, { _id: { $in: papers.map((p) => p.subjectId) } }))
      .select('name isElective')
      .lean(),
    SchoolClass.find(scope(actor, { _id: { $in: classIds } }))
      .select('name level')
      .lean(),
    Section.find(scope(actor, { classId: { $in: classIds } }))
      .select('name classId')
      .lean(),
    Student.find(scope(actor, { classId: { $in: classIds }, status: 'active' }))
      .select('firstName lastName admissionNo rollNo classId sectionId')
      .sort({ rollNo: 1, firstName: 1 })
      .lean(),
    Mark.find(scope(actor, { examId: exam._id }))
      .select('paperId studentId obtained isAbsent notTaken')
      .lean(),
  ]);
  const subjectById = new Map(subjects.map((s) => [s._id.toString(), s]));
  const classById = new Map(classes.map((c) => [c._id.toString(), c]));
  const sectionById = new Map(sections.map((s) => [s._id.toString(), s]));
  const markByKey = new Map(marks.map((m) => [`${m.paperId}:${m.studentId}`, m]));

  const groups: ReadinessGroup[] = [];
  const electiveGaps: Array<{ className: string; sectionName: string; subject: string; withoutMarks: number }> = [];
  for (const paper of papers) {
    const subject = subjectById.get(paper.subjectId.toString());
    const cls = classById.get(paper.classId.toString());
    const inClass = students.filter((s) => s.classId.toString() === paper.classId.toString());
    const bySection = new Map<string, typeof inClass>();
    for (const s of inClass)
      bySection.set(s.sectionId.toString(), [...(bySection.get(s.sectionId.toString()) ?? []), s]);
    for (const [sectionId, roster] of bySection) {
      const section = sectionById.get(sectionId);
      const missing: ReadinessStudent[] = [];
      const invalid: ReadinessGroup['invalid'] = [];
      for (const st of roster) {
        const row: ReadinessStudent = {
          studentId: st._id.toString(),
          name: `${st.firstName} ${st.lastName ?? ''}`.trim(),
          admissionNo: st.admissionNo,
          ...(st.rollNo ? { rollNo: st.rollNo } : {}),
        };
        const m = markByKey.get(`${paper._id}:${st._id}`);
        // "Not taken" resolves an elective only; on any other subject it is still missing.
        const notTaken = Boolean(subject?.isElective && m?.notTaken && !m.isAbsent);
        if (notTaken) continue;
        if (!m || (!m.isAbsent && (m.obtained === null || m.obtained === undefined))) missing.push(row);
        else if (!m.isAbsent && (m.obtained! < 0 || m.obtained! > paper.maxMarks))
          invalid.push({ ...row, obtained: m.obtained!, maxMarks: paper.maxMarks });
      }
      const base = {
        classId: paper.classId.toString(),
        className: cls?.name ?? 'Class',
        sectionId,
        sectionName: section?.name ?? 'Section',
        paperId: paper._id.toString(),
        subject: subject?.name ?? 'Subject',
      };
      if (subject?.isElective && missing.length)
        electiveGaps.push({
          className: base.className,
          sectionName: base.sectionName,
          subject: base.subject,
          withoutMarks: missing.length,
        });
      if (missing.length || invalid.length)
        groups.push({
          ...base,
          roster: roster.length,
          missingCount: missing.length,
          missing: missing.slice(0, NAMES_PER_GROUP),
          invalidCount: invalid.length,
          invalid: invalid.slice(0, NAMES_PER_GROUP),
        });
    }
  }
  const level = (classId: string) => classById.get(classId)?.level ?? 0;
  groups.sort(
    (a, b) =>
      level(a.classId) - level(b.classId) ||
      a.sectionName.localeCompare(b.sectionName) ||
      a.subject.localeCompare(b.subject),
  );
  const missingEntries = groups.reduce((n, g) => n + g.missingCount, 0);
  const invalidEntries = groups.reduce((n, g) => n + g.invalidCount, 0);
  const studentsAffected = new Set(groups.flatMap((g) => [...g.missing, ...g.invalid].map((s) => s.studentId))).size;
  return {
    examId: exam._id.toString(),
    status: exam.status,
    papers: papers.length,
    ready: papers.length > 0 && groups.length === 0,
    missingEntries,
    invalidEntries,
    studentsAffected,
    groups,
    electiveGaps,
    message: readinessMessage(papers.length, groups, missingEntries, invalidEntries, electiveGaps.length > 0),
  };
}

/** One plain sentence for the screen, naming the first affected class, section and subject. */
export function readinessMessage(
  papers: number,
  groups: ReadinessGroup[],
  missingEntries: number,
  invalidEntries: number,
  electiveBlank = false,
): string {
  if (!papers) return 'Result cannot be published. The exam has no papers yet.';
  if (!groups.length) return 'All marks are complete. The result can be published.';
  const g = groups[0];
  const first = `${g.className}, Section ${g.sectionName}, ${g.subject}`;
  const parts: string[] = [];
  if (missingEntries)
    parts.push(
      groups.length === 1
        ? `Marks or an approved status are missing for ${g.missingCount} student${g.missingCount === 1 ? '' : 's'} in ${first}.`
        : `Marks or an approved status are missing for ${missingEntries} entr${missingEntries === 1 ? 'y' : 'ies'} across ${groups.length} class subjects (first: ${first}).`,
    );
  if (missingEntries && electiveBlank)
    parts.push('In an elective, mark a student who does not take the subject as Not taken.');
  if (invalidEntries)
    parts.push(`${invalidEntries} saved mark${invalidEntries === 1 ? ' is' : 's are'} outside the allowed range.`);
  return `Result cannot be published. ${parts.join(' ')}`;
}
