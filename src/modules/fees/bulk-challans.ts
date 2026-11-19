import type { SchoolContext } from '../../types/context';
import { badRequest } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import { visibleStudentIds } from '../academics/access.service';
import { Section } from '../academics/academics.models';
import { audit } from '../audit/audit.service';
import { Student } from '../students/student.models';
import type { ChallanData } from '../../services/pdf';
import { challanData } from './family-voucher';
import { Invoice } from './fees.models';

type Ctx = SchoolContext;

/** More than this in one PDF is refused: choose a class or section. */
export const BULK_CHALLAN_LIMIT = 800;

/**
 * The challans of one month for a whole class, a section or the school, in print order (section,
 * then roll number, then name), each exactly as its own challan prints it, with previous dues.
 * "open" leaves out challans that are fully paid.
 */
export async function bulkChallans(
  ctx: Ctx,
  q: { period: string; classId?: string; sectionId?: string; include: 'open' | 'all' },
): Promise<{ challans: ChallanData[]; label: string }> {
  const filter: Record<string, unknown> = scope(ctx, {
    period: q.period,
    kind: { $ne: 'opening' },
    status: q.include === 'open' ? { $in: ['unpaid', 'partial'] } : { $ne: 'cancelled' },
    ...campusScope(ctx),
  });
  if (q.classId) filter.classId = oid(q.classId);
  if (q.sectionId) filter.sectionId = oid(q.sectionId);
  const visible = await visibleStudentIds(ctx);
  if (visible) filter.studentId = { $in: visible.map(oid) };
  const invoices = await Invoice.find(filter).select('_id studentId sectionId').lean();
  if (invoices.length > BULK_CHALLAN_LIMIT)
    throw badRequest(
      `${invoices.length} challans: more than ${BULK_CHALLAN_LIMIT} at once. Choose a class or section.`,
      undefined,
      'TOO_MANY_CHALLANS',
    );
  const [students, sections] = await Promise.all([
    Student.find(scope(ctx, { _id: { $in: invoices.map((i) => i.studentId) } }))
      .select('firstName lastName rollNo')
      .lean(),
    Section.find(scope(ctx, { _id: { $in: [...new Set(invoices.map((i) => String(i.sectionId)))].map(oid) } }))
      .select('name')
      .lean(),
  ]);
  const studentOf = new Map(students.map((s) => [String(s._id), s]));
  const sectionName = new Map(sections.map((s) => [String(s._id), s.name]));
  const roll = (v: unknown) => (/^\d+$/.test(String(v ?? '')) ? Number(v) : Number.MAX_SAFE_INTEGER);
  const nameOf = (id: unknown) => {
    const s = studentOf.get(String(id));
    return s ? `${s.firstName} ${s.lastName ?? ''}`.trim() : '';
  };
  invoices.sort(
    (a, b) =>
      (sectionName.get(String(a.sectionId)) ?? '').localeCompare(sectionName.get(String(b.sectionId)) ?? '') ||
      roll(studentOf.get(String(a.studentId))?.rollNo) - roll(studentOf.get(String(b.studentId))?.rollNo) ||
      nameOf(a.studentId).localeCompare(nameOf(b.studentId)),
  );
  const challans: ChallanData[] = [];
  for (const inv of invoices)
    challans.push(await challanData(ctx, String(inv._id), undefined, { withPreviousDues: true }));
  const first = challans[0];
  const label = [
    q.period,
    q.sectionId ? `${first?.className ?? ''}-${first?.sectionName ?? ''}` : q.classId ? first?.className : 'all',
  ]
    .filter(Boolean)
    .join('-')
    .replace(/[^\w-]+/g, '_');
  await audit(ctx, {
    action: 'invoice.challans_printed',
    entityType: 'Invoice',
    summary: `Printed ${challans.length} challans for ${q.period}`,
    metadata: {
      period: q.period,
      classId: q.classId,
      sectionId: q.sectionId,
      include: q.include,
      count: challans.length,
    },
  });
  return { challans, label };
}
