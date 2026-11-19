import { Types } from 'mongoose';
import type { SchoolContext } from '../../types/context';
import { badRequest, forbidden, notFound } from '../../utils/errors';
import { campusScope, oid, scope } from '../../utils/tenant';
import { Employee } from '../employees/employee.model';
import { BiometricDevice } from './biometric.models';

/**
 * Campus restriction for staff attendance, as in the staff module: a user limited to some
 * campuses sees and changes only the staff of those campuses (others are "not found"). Users
 * without a campus restriction see the whole school. The school itself is always the
 * authenticated one (scope()).
 */

type MaybeCampusCtx = Pick<SchoolContext, 'schoolId'> & { campusIds?: string[] };

export const campusLimited = (ctx: MaybeCampusCtx): ctx is SchoolContext => Boolean(ctx.campusIds?.length);

/** A staff member of the caller's school and campuses; 404 otherwise (as GET /employees/:id). */
export async function staffInCampus(ctx: SchoolContext, employeeId: string, label = 'Staff member') {
  if (!Types.ObjectId.isValid(employeeId)) throw notFound(label);
  const emp = await Employee.findOne(scope(ctx, { _id: oid(employeeId), ...campusScope(ctx) })).lean();
  if (!emp) throw notFound(label);
  return emp;
}

/** The staff a campus-limited user may see; null when the user sees every campus. */
export async function visibleStaffIds(ctx: SchoolContext): Promise<Types.ObjectId[] | null> {
  if (!campusLimited(ctx)) return null;
  return Employee.find(scope(ctx, campusScope(ctx))).distinct('_id');
}

/**
 * Devices whose unlinked punches a campus-limited user may see (to link them to their staff):
 * devices of their campuses, and devices not assigned to a campus. Null: every device.
 */
export async function visibleDeviceIds(ctx: SchoolContext): Promise<Types.ObjectId[] | null> {
  if (!campusLimited(ctx)) return null;
  return BiometricDevice.find(
    scope(ctx, { $or: [{ campusId: null }, { campusId: { $in: ctx.campusIds.map(oid) } }] }),
  ).distinct('_id');
}

/** A device of the caller's campuses or a school-wide one (no campus): they may import from it. */
export const deviceInCampus = (ctx: MaybeCampusCtx, campusId: unknown) =>
  !campusLimited(ctx) || !campusId || ctx.campusIds.includes(String(campusId));

/**
 * Changing a device (its details, status or campus, removing it, its connector key) affects every
 * campus it serves: a campus-limited user may only change devices of their own campuses, never a
 * school-wide one or another campus' device.
 */
export function assertDeviceManageable(ctx: SchoolContext, campusId: unknown) {
  if (!campusLimited(ctx)) return;
  if (!campusId || !ctx.campusIds.includes(String(campusId)))
    throw forbidden(
      campusId
        ? 'This device belongs to a campus you do not have access to'
        : 'This device serves every campus: only a user with access to all campuses can change it',
      'CAMPUS_FORBIDDEN',
    );
}

/**
 * The campus a device is saved with, for the caller. A campus-limited user's devices always
 * belong to one of their campuses (their only campus when they do not choose one); others may
 * leave it empty (school-wide).
 */
export function deviceCampusFor(ctx: SchoolContext, requested: string | null | undefined) {
  if (!campusLimited(ctx)) return requested;
  const campusId = requested ?? (ctx.campusIds.length === 1 ? ctx.campusIds[0] : undefined);
  if (!campusId)
    throw badRequest('Choose the campus of this device', [
      { path: 'body.campusId', message: 'Choose one of your campuses' },
    ]);
  assertDeviceManageable(ctx, campusId);
  return campusId;
}

/**
 * For a campus-limited caller: every one of these staff members must be in the caller's
 * campuses. Used where one action also changes other staff's days (a link that moves punches,
 * an import, an undo), so it cannot reach into another campus indirectly.
 */
export async function assertStaffInCampus(ctx: MaybeCampusCtx, employeeIds: unknown[], what: string) {
  if (!campusLimited(ctx)) return;
  const ids = [...new Set(employeeIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  const allowed = await Employee.countDocuments(scope(ctx, { _id: { $in: ids.map(oid) }, ...campusScope(ctx) }));
  if (allowed !== ids.length)
    throw forbidden(`${what} staff of a campus you do not have access to`, 'CAMPUS_FORBIDDEN');
}
