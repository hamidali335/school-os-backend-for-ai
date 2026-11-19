/**
 * Deterministic result computation. Grades, percentages and positions are calculated here
 * from stored marks — never by AI.
 */
export interface GradeBand {
  grade: string;
  minPercent: number;
  remark?: string | null;
}

export interface PaperInfo {
  paperId: string;
  subjectId: string;
  subjectName: string;
  maxMarks: number;
  passMarks: number;
  /**
   * Elective subject: a student who does not take it is recorded as "not taken" (MarkEntry
   * notTaken) and left out of the totals. A blank stays a missing mark (see computeStudentResult).
   */
  optional?: boolean;
}

export interface MarkEntry {
  paperId: string;
  obtained?: number | null;
  isAbsent?: boolean;
  /** Elective the student does not take (recorded explicitly). */
  notTaken?: boolean;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function gradeFor(percent: number, scale: GradeBand[]): { grade: string; remark?: string | null } {
  const sorted = [...scale].sort((a, b) => b.minPercent - a.minPercent);
  const band = sorted.find((b) => percent >= b.minPercent) ?? sorted[sorted.length - 1];
  return { grade: band?.grade ?? '-', remark: band?.remark };
}

export interface StudentResult {
  totalObtained: number;
  totalMax: number;
  percentage: number;
  grade: string;
  remark?: string | null;
  passed: boolean;
  failedSubjects: string[];
  incomplete: boolean;
  subjects: Array<{
    paperId: string;
    subjectId: string;
    subject: string;
    maxMarks: number;
    passMarks: number;
    obtained: number | null;
    isAbsent: boolean;
    percentage: number | null;
    grade: string | null;
    passed: boolean | null;
    /** Elective paper with no mark: not counted in totals. */
    notTaken?: boolean;
  }>;
}

/**
 * A student passes when every paper meets its pass mark and the overall percentage meets
 * the school pass percentage. Absent counts as 0 (it is an explicit status, never assumed).
 * An elective recorded as "not taken" is left out of the totals. A missing mark makes the result
 * incomplete, in an elective too: it is never assumed that the student does not take it.
 *
 * `blankElectiveNotTaken`: only for results published before "not taken" could be recorded,
 * when a blank elective was read as not taken; they are shown as they were published.
 */
export function computeStudentResult(
  papers: PaperInfo[],
  marks: MarkEntry[],
  scale: GradeBand[],
  passPercent: number,
  opts: { blankElectiveNotTaken?: boolean } = {},
): StudentResult {
  const byPaper = new Map(marks.map((m) => [m.paperId, m]));
  let totalObtained = 0;
  let totalMax = 0;
  let incomplete = false;
  const failedSubjects: string[] = [];
  const subjects = papers.map((p) => {
    const m = byPaper.get(p.paperId);
    const notTaken = Boolean(p.optional && m?.notTaken && !m.isAbsent);
    // "Not taken" on a subject that is no longer elective counts as a missing mark.
    const missing = !notTaken && (!m || (!m.isAbsent && (m.obtained === undefined || m.obtained === null)));
    if (p.optional && (notTaken || (missing && opts.blankElectiveNotTaken))) {
      return {
        paperId: p.paperId,
        subjectId: p.subjectId,
        subject: p.subjectName,
        maxMarks: p.maxMarks,
        passMarks: p.passMarks,
        obtained: null,
        isAbsent: false,
        percentage: null,
        grade: null,
        passed: null,
        notTaken: true,
      };
    }
    totalMax += p.maxMarks;
    if (missing) {
      incomplete = true;
      return {
        paperId: p.paperId,
        subjectId: p.subjectId,
        subject: p.subjectName,
        maxMarks: p.maxMarks,
        passMarks: p.passMarks,
        obtained: null,
        isAbsent: false,
        percentage: null,
        grade: null,
        passed: null,
      };
    }
    const obtained = m!.isAbsent ? 0 : (m!.obtained as number);
    totalObtained += obtained;
    const pct = round2((obtained / p.maxMarks) * 100);
    const passed = obtained >= p.passMarks;
    if (!passed) failedSubjects.push(p.subjectName);
    return {
      paperId: p.paperId,
      subjectId: p.subjectId,
      subject: p.subjectName,
      maxMarks: p.maxMarks,
      passMarks: p.passMarks,
      obtained,
      isAbsent: !!m!.isAbsent,
      percentage: pct,
      grade: gradeFor(pct, scale).grade,
      passed,
    };
  });
  const percentage = totalMax ? round2((totalObtained / totalMax) * 100) : 0;
  const { grade, remark } = gradeFor(percentage, scale);
  return {
    totalObtained,
    totalMax,
    percentage,
    grade,
    remark,
    passed: !incomplete && failedSubjects.length === 0 && percentage >= passPercent,
    failedSubjects,
    incomplete,
    subjects,
  };
}

/** Standard competition ranking: 1, 2, 2, 4. Incomplete results are not ranked. */
export function assignPositions<T extends { percentage: number; incomplete: boolean }>(
  rows: T[],
): Array<T & { position: number | null }> {
  const ranked = rows.filter((r) => !r.incomplete).sort((a, b) => b.percentage - a.percentage);
  const positions = new Map<T, number>();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    positions.set(r, prev && prev.percentage === r.percentage ? positions.get(prev)! : i + 1);
  });
  return rows.map((r) => ({ ...r, position: positions.get(r) ?? null }));
}

export function subjectStats(values: number[], maxMarks: number, passMarks: number) {
  if (!values.length) return { count: 0, average: null, highest: null, lowest: null, passRate: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    average: round2(sum / values.length),
    averagePercent: round2((sum / values.length / maxMarks) * 100),
    highest: Math.max(...values),
    lowest: Math.min(...values),
    passRate: round2((values.filter((v) => v >= passMarks).length / values.length) * 100),
  };
}
