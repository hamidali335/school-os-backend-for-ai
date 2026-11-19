import type { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { escapeRegex, textSearchFilter } from '../../utils/pagination';
import { campusScope, scope } from '../../utils/tenant';
import { Parent, Student } from './student.models';

/**
 * A phone search that ignores formatting: "0329-3903346", "03293903346" and "+923293903346" all
 * find the same number. Undefined when the text is not phone-like (letters, or under 4 digits).
 */
export function phoneRegex(text: string | undefined): RegExp | undefined {
  if (!text || /[a-z]/i.test(text)) return undefined;
  const digits = text.replace(/\D/g, '');
  if (digits.length < 4) return undefined;
  const core = digits.replace(/^(0092|92|0)(?=3)/, '');
  // Allow spaces/dashes between digits as they may be stored as typed.
  return new RegExp(core.split('').map(escapeRegex).join('[\s-]?'));
}

/** Parents of this school whose name or phone matches (capped). */
export async function parentIdsMatching(ctx: SchoolContext, text: string | undefined, limit = 200) {
  const phone = phoneRegex(text);
  const match = textSearchFilter(text, ['name'], [], phone ? [{ phone }, { whatsapp: phone }] : []);
  if (!match) return [];
  const parents = await Parent.find(scope(ctx, match)).select('_id').limit(limit).lean();
  return parents.map((p) => p._id);
}

/**
 * A student search: the name in any order and spacing ("Usman Bukhari"), admission or roll
 * number, or one of the given parents (found by name or phone).
 */
export function studentTextFilter(text: string | undefined, parentIds: Types.ObjectId[] = []) {
  return textSearchFilter(
    text,
    ['firstName', 'lastName'],
    ['admissionNo', 'rollNo'],
    parentIds.length ? [{ 'guardians.parentId': { $in: parentIds } }] : [],
  );
}

/**
 * Students matching a free-text search on another list (invoices, payments, certificates):
 * name, admission or roll number, or a parent's name or phone. Always within the user's school
 * and campuses; callers still apply their own visibility rules.
 */
export async function studentIdsMatching(
  ctx: SchoolContext,
  text: string | undefined,
  limit = 1000,
): Promise<Types.ObjectId[]> {
  const parentIds = await parentIdsMatching(ctx, text);
  const match = studentTextFilter(text, parentIds);
  if (!match) return [];
  const students = await Student.find(scope(ctx, { ...campusScope(ctx), ...match }))
    .select('_id')
    .limit(limit)
    .lean();
  return students.map((s) => s._id);
}
