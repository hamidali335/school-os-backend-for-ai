import type { SchoolContext } from '../../types/context';
import { badRequest } from '../../utils/errors';
import { scope } from '../../utils/tenant';
import { audit } from '../audit/audit.service';
import { FeeHead } from './fees.models';

type Ctx = SchoolContext;

/**
 * Common fee heads used by Pakistani private schools. These are names and billing rules only,
 * never amounts: each school chooses which to add, renames or disables them, and sets its own
 * amounts per class. Nothing is added unless an administrator picks it.
 */
export const DEFAULT_FEE_HEADS = [
  {
    code: 'TUITION',
    name: 'Monthly Tuition Fee',
    frequency: 'monthly',
    billing: 'class',
    concessionApplies: true,
    description: 'Charged every month. Standing concessions (sibling, staff, merit) reduce this fee.',
  },
  {
    code: 'ADMISSION',
    name: 'Admission Fee',
    frequency: 'one_time',
    billing: 'class',
    concessionApplies: false,
    description: "Charged once, on the student's first invoice.",
  },
  {
    code: 'REGISTRATION',
    name: 'Registration / Prospectus Fee',
    frequency: 'one_time',
    billing: 'class',
    concessionApplies: false,
    description: "Charged once, on the student's first invoice.",
  },
  {
    code: 'ANNUAL',
    name: 'Annual Charges',
    frequency: 'annual',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged in the month(s) you choose for each class, usually at the start of the session.',
  },
  {
    code: 'EXAM',
    name: 'Examination Fee',
    frequency: 'term',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged in the exam months you choose (for example before mid-term and final-term).',
  },
  {
    code: 'COMPUTER',
    name: 'Computer Fee',
    frequency: 'monthly',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged every month to the classes you add it to.',
  },
  {
    code: 'LAB',
    name: 'Science Laboratory Fee',
    frequency: 'monthly',
    billing: 'class',
    concessionApplies: false,
    description: 'Usually only for classes with practicals: add it to those classes only.',
  },
  {
    code: 'LIBRARY',
    name: 'Library Fee',
    frequency: 'annual',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged in the month(s) you choose for each class.',
  },
  {
    code: 'SPORTS',
    name: 'Sports Fee',
    frequency: 'annual',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged in the month(s) you choose for each class.',
  },
  {
    code: 'SECURITY',
    name: 'Security Deposit (refundable)',
    frequency: 'one_time',
    billing: 'class',
    concessionApplies: false,
    description: 'Charged once at admission. Refunds follow your school policy and are not automatic.',
  },
  {
    code: 'TRANSPORT',
    name: 'Transport Fee',
    frequency: 'monthly',
    billing: 'per_student',
    concessionApplies: false,
    description: 'Only for students who use school transport: add it on their individual invoices.',
  },
  {
    code: 'BOOKS',
    name: 'Books & Stationery',
    frequency: 'one_time',
    billing: 'per_student',
    concessionApplies: false,
    description: 'Only for students who buy books from the school: add it on their invoices.',
  },
  {
    code: 'UNIFORM',
    name: 'Uniform',
    frequency: 'one_time',
    billing: 'per_student',
    concessionApplies: false,
    description: 'Only for students who buy uniform from the school: add it on their invoices.',
  },
  {
    code: 'MISC',
    name: 'Miscellaneous / Other Charges',
    frequency: 'one_time',
    billing: 'per_student',
    concessionApplies: false,
    description: 'Approved one-off charges for individual students.',
  },
] as const;

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Each default with whether the school already has it (same code or same name). */
export async function defaultFeeHeads(ctx: Ctx) {
  const existing = await FeeHead.find(scope(ctx)).select('code name').lean();
  const codes = new Set(existing.map((h) => h.code.toUpperCase()));
  const names = new Map(existing.map((h) => [normalise(h.name), h.name]));
  return DEFAULT_FEE_HEADS.map((d) => {
    const sameName = names.get(normalise(d.name));
    return {
      ...d,
      exists: codes.has(d.code) || Boolean(sameName),
      existingName: codes.has(d.code)
        ? (existing.find((h) => h.code.toUpperCase() === d.code)?.name ?? null)
        : (sameName ?? null),
    };
  });
}

/**
 * Adds the chosen defaults. Idempotent: a default whose code or name already exists is skipped,
 * and the unique code index stops a concurrent double add. Existing heads are never changed.
 */
export async function addDefaultFeeHeads(ctx: Ctx, codes: string[]) {
  const wanted = [...new Set(codes.map((c) => c.toUpperCase()))];
  const unknown = wanted.filter((c) => !DEFAULT_FEE_HEADS.some((d) => d.code === c));
  if (unknown.length) throw badRequest(`Unknown default fee heads: ${unknown.join(', ')}`);
  const status = await defaultFeeHeads(ctx);
  const created: string[] = [];
  const skipped: Array<{ code: string; reason: string }> = [];
  for (const d of status.filter((x) => wanted.includes(x.code))) {
    if (d.exists) {
      skipped.push({ code: d.code, reason: `Already exists as "${d.existingName}"` });
      continue;
    }
    try {
      await FeeHead.create({
        schoolId: ctx.schoolId,
        code: d.code,
        name: d.name,
        frequency: d.frequency,
        billing: d.billing,
        concessionApplies: d.concessionApplies,
        description: d.description,
        isActive: true,
      });
      created.push(d.code);
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        skipped.push({ code: d.code, reason: 'Added at the same moment by someone else' });
      else throw err;
    }
  }
  if (created.length)
    await audit(ctx, {
      action: 'fee_head.defaults_added',
      entityType: 'FeeHead',
      summary: `Added ${created.length} common fee heads`,
      metadata: { created },
    });
  return { created, skipped };
}
