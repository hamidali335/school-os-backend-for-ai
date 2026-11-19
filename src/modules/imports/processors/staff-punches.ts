import { oid, scope } from '../../../utils/tenant';
import { BiometricDevice, PunchEvent } from '../../biometric/biometric.models';
import {
  LinkResolver,
  noteAlsoDelivered,
  normaliseDeviceUserId,
  punchKey,
  storePunches,
} from '../../biometric/biometric.service';
import {
  detectDateOrder,
  parsePunchTime,
  parsePunchType,
  wallTime,
  type DateOrder,
  type ReadAs,
} from '../../biometric/punch-values';
import { acquirePunchLock, releasePunchLock, requirePunchLock } from '../../biometric/punch-lock';
import { deviceInCampus } from '../../biometric/access';
import { Employee } from '../../employees/employee.model';
import { schoolTimezone } from '../../schools/timezone';
import { fieldLabel } from '../import-fields';
import { RowReader, breathe, type Processor, type RowPlan } from './types';

interface Payload {
  deviceId: string;
  deviceUserId: string;
  punchedAt: string;
  localDate: string;
  punchType: 'in' | 'out' | 'unknown';
  rawType?: string;
  jobId?: string;
}

const label = (f: string) => fieldLabel('staff_punches', f);

interface DateExample {
  rowNo: number;
  original: string;
  interpreted: string;
  localDate: string;
  at: string;
  readAs: ReadAs;
  ambiguous: boolean;
  overridden: boolean;
}

/** How many example rows the review shows, per kind (unclear dates, dates read against the order, others). */
const EXAMPLES = { ambiguous: 4, overridden: 3, other: 2 };

/**
 * Staff attendance punches from a fingerprint machine's export (CSV, Excel or TXT). One row is
 * one punch. Nothing is matched by name: a punch belongs to the staff member its device user ID
 * is linked to (Staff attendance → Device users). Punches of device users not linked yet are kept
 * and counted as soon as the link is made; they are never dropped and never create staff.
 */
export const staffPunchesProcessor: Processor<Payload> = {
  async plan(ctx, rows, options, meta) {
    const warnings: string[] = [];
    const out: RowPlan<Payload>[] = [];
    const device = options.deviceId
      ? await BiometricDevice.findOne(scope(ctx, { _id: oid(options.deviceId) })).lean()
      : null;
    const deviceProblem = !options.deviceId
      ? 'Choose the device these punches come from'
      : !device
        ? 'The chosen device no longer exists'
        : device.status !== 'active'
          ? `${device.name} is disabled: enable it to import its punches`
          : device.integration !== 'file_import'
            ? `${device.name} does not use File import`
            : !deviceInCampus(ctx, device.campusId)
              ? `${device.name} belongs to a campus you do not have access to`
              : null;
    if (deviceProblem) warnings.push(deviceProblem);

    const timeZone = await schoolTimezone(ctx.schoolId);
    const dateCells = rows.map((r) => r.cells.dateTime || r.cells.date || '');
    const detected = detectDateOrder(dateCells);
    const chosen: DateOrder | null =
      options.dateOrder === 'dmy' || options.dateOrder === 'mdy' ? options.dateOrder : null;
    const words = (o: DateOrder) => (o === 'dmy' ? 'day/month/year' : 'month/day/year');
    let order: DateOrder | null = chosen;
    if (detected === 'mixed')
      warnings.push(
        'The file has dates in both day/month and month/day order. Each date that only fits one order is read that way; check the file.',
      );
    else if (detected && !chosen) {
      order = detected;
      warnings.push(`Dates like 03/04/2026 are read as ${words(detected)} (decided from the file).`);
    } else if (detected && chosen && detected !== chosen)
      warnings.push(
        `Some dates only make sense as ${words(detected)}, but the options say ${words(chosen)}: check the date order.`,
      );

    const links = await LinkResolver.load(ctx);
    const staff = new Map(
      (await Employee.find(scope(ctx)).select('firstName lastName employeeNo status campusId').lean()).map((e) => [
        String(e._id),
        e,
      ]),
    );
    // A user limited to some campuses imports punches of their campuses' staff only.
    const campusAllowed = (campusId: unknown) => !ctx.campusIds.length || ctx.campusIds.includes(String(campusId));
    const seen = new Map<string, number>();
    const unlinked = new Map<string, number>();
    const examples: Record<keyof typeof EXAMPLES, DateExample[]> = { ambiguous: [], overridden: [], other: [] };
    let ambiguousRows = 0;
    let overriddenRows = 0;
    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      if (deviceProblem) r.error(undefined, deviceProblem);
      const rawUser = r.req('deviceUserId', (v) =>
        v.length <= 40 ? { ok: true, value: v } : { ok: false, error: 'is too long' },
      );
      const deviceUserId = rawUser ? normaliseDeviceUserId(rawUser) : undefined;
      const when = r.has('dateTime') ? r.raw('dateTime') : r.raw('date');
      const time = r.has('dateTime') ? undefined : r.raw('time') || undefined;
      let parsed: ReturnType<typeof parsePunchTime> | undefined;
      if (!when) r.error(r.has('dateTime') ? 'dateTime' : 'date', 'is required');
      else if (!r.has('dateTime') && !time)
        r.error('time', 'is required when the date and the time are in separate columns');
      else {
        parsed = parsePunchTime(when, time, { order, timeZone });
        if (!parsed.ok) r.error(r.has('dateTime') ? 'dateTime' : 'date', parsed.error);
        else {
          // A date with a number above 12 fits one order only, and is read that way: said on the row.
          const overridden = Boolean(
            order && (parsed.readAs === 'dmy' || parsed.readAs === 'mdy') && parsed.readAs !== order,
          );
          if (overridden)
            r.warn(
              r.has('dateTime') ? 'dateTime' : 'date',
              `read as ${words(parsed.readAs as DateOrder)}: "${when}" only fits that order (the dates of this file are read as ${words(order!)})`,
            );
          if (parsed.ambiguous) ambiguousRows++;
          if (overridden) overriddenRows++;
          const kind = overridden ? 'overridden' : parsed.ambiguous ? 'ambiguous' : 'other';
          if (examples[kind].length < EXAMPLES[kind])
            examples[kind].push({
              rowNo: row.rowNo,
              original: time ? `${when} ${time}` : when,
              interpreted: wallTime(parsed.at, timeZone),
              localDate: parsed.localDate,
              at: parsed.at.toISOString(),
              readAs: parsed.readAs,
              ambiguous: parsed.ambiguous,
              overridden,
            });
        }
      }
      const rawType = r.raw('punchType') || undefined;
      const punchType = rawType ? parsePunchType(rawType) : 'unknown';
      if (rawType && punchType === 'unknown')
        r.info('punchType', `"${rawType}" is kept as given; it is not read as arrival or departure`);
      const plan: RowPlan<Payload> = { rowNo: row.rowNo, check: 'create', issues: r.issues, changes: [] };
      if (r.failed || !deviceUserId || !parsed?.ok || !device) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const key = punchKey(device._id, deviceUserId, parsed.at);
      const first = seen.get(key);
      if (first) {
        out.push({
          ...plan,
          check: 'duplicate',
          key,
          issues: [...r.issues, { level: 'info', message: `The same punch as row ${first}` }],
        });
        continue;
      }
      seen.set(key, row.rowNo);
      const employeeId = links.employeeFor(device._id, deviceUserId);
      const emp = employeeId ? staff.get(employeeId) : undefined;
      if (emp && !campusAllowed(emp.campusId)) {
        r.error('deviceUserId', 'is linked to a staff member of a campus you do not have access to');
        out.push({ ...plan, check: 'invalid', issues: r.issues });
        continue;
      }
      if (emp) {
        r.info(
          'deviceUserId',
          `linked to ${[emp.firstName, emp.lastName].filter(Boolean).join(' ')} (${emp.employeeNo})`,
        );
        if (emp.status !== 'active') r.warn('deviceUserId', `this staff member is ${emp.status.replace('_', ' ')}`);
      } else {
        unlinked.set(deviceUserId, (unlinked.get(deviceUserId) ?? 0) + 1);
        r.warn(
          'deviceUserId',
          `device user ${deviceUserId} is not linked to a staff member yet: the punch is saved and counted once you link it`,
        );
      }
      out.push({
        ...plan,
        key,
        // One device's punches are saved one at a time in file order (see startRun).
        groupKeys: [`device:${String(device._id)}`],
        issues: r.issues,
        payload: {
          deviceId: String(device._id),
          deviceUserId,
          punchedAt: parsed.at.toISOString(),
          localDate: parsed.localDate,
          punchType,
          rawType,
          jobId: meta?.jobId,
        },
      });
    }
    // Punches imported before (this file again, or an overlapping export) are recognised.
    const keys = out.filter((p) => p.check === 'create' && p.key).map((p) => p.key!);
    const stored = new Set<string>();
    for (let i = 0; i < keys.length; i += 1000)
      for (const p of await PunchEvent.find(scope(ctx, { dedupeKey: { $in: keys.slice(i, i + 1000) } }))
        .select('dedupeKey')
        .lean())
        stored.add(p.dedupeKey);
    for (const p of out)
      if (p.check === 'create' && stored.has(p.key!)) {
        p.check = 'exists';
        p.issues = [...p.issues, { level: 'info', message: 'Already imported' }];
      }
    if (unlinked.size) {
      const ids = [...unlinked.keys()];
      warnings.push(
        `${ids.length} device user ID(s) are not linked to staff yet (${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ', …' : ''}): their punches are saved and counted once you link them in Staff attendance → Device users.`,
      );
    }
    // How the dates are read, with examples: exactly what the import saves (the payloads above).
    const datePreview = {
      timeZone,
      order,
      orderSource: chosen ? 'chosen' : order ? 'detected' : 'none',
      ambiguousRows,
      overriddenRows,
      examples: [...examples.ambiguous, ...examples.overridden, ...examples.other].sort((a, b) => a.rowNo - b.rowNo),
    };
    return { rows: out, warnings, summary: { datePreview } };
  },

  /**
   * Before saving: punches this file holds that an earlier import already stored ("already
   * imported") are noted as also in this import, so undoing that earlier import keeps them. The
   * rows themselves are then saved one at a time, as before (one group per device).
   */
  /** Never at the same time as an undo of a punch import in the school (see punch-lock.ts). */
  runLock: {
    acquire: (ctx, holder) => requirePunchLock(ctx, holder, 'import'),
    // Renewing also re-takes a lock that is free (e.g. a run resumed in another process).
    renew: (ctx, holder) => acquirePunchLock(ctx, holder, 'import'),
    release: (ctx, holder) => releasePunchLock(ctx, holder),
  },

  async startRun(ctx, plans) {
    const existing = plans.filter((p) => p.check === 'exists' && p.key && p.payload?.jobId);
    if (existing.length)
      await noteAlsoDelivered(
        ctx,
        existing.map((p) => p.key!),
        existing[0].payload!.jobId,
      );
    return { apply: (plan) => staffPunchesProcessor.apply(ctx, plan), refresh: async () => undefined };
  },

  async apply(ctx, plan) {
    const p = plan.payload!;
    const res = await storePunches(
      ctx,
      { _id: oid(p.deviceId) },
      [
        {
          deviceUserId: p.deviceUserId,
          punchedAt: new Date(p.punchedAt),
          localDate: p.localDate,
          punchType: p.punchType,
          rawType: p.rawType,
          rowNo: plan.rowNo,
        },
      ],
      'file',
      p.jobId,
    );
    if (!res.stored) return { result: 'skipped', message: 'Already imported' };
    return {
      result: 'created',
      message: res.linked
        ? `Punch saved for ${p.localDate}`
        : `Punch saved; waiting for device user ${p.deviceUserId} to be linked`,
    };
  },
};
