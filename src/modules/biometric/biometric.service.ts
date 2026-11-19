import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import type { SchoolContext, SystemContext } from '../../types/context';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../utils/errors';
import { paginate } from '../../utils/pagination';
import { assertRefs, campusScope, findOwned, oid, scope } from '../../utils/tenant';
import { Campus } from '../campuses/campus.model';
import { audit } from '../audit/audit.service';
import { Employee } from '../employees/employee.model';
import { schoolTimezone } from '../schools/timezone';
import {
  assertDeviceManageable,
  assertStaffInCampus,
  campusLimited,
  deviceCampusFor,
  staffInCampus,
  visibleDeviceIds,
  visibleStaffIds,
} from './access';
import { INTEGRATIONS, type IntegrationMethod } from './adapters/registry';
import { BiometricDevice, DeviceUserLink, PunchEvent } from './biometric.models';
import { assertBiometricIndexes } from './index-check';
import { parsePunchTime, parsePunchType } from './punch-values';
import { recomputeStaffDays } from './staff-attendance.service';

type Ctx = SchoolContext;
type TenantCtx = Pick<SchoolContext, 'schoolId'>;

/* ───────────────────────────── Identity of a punch ───────────────────────────── */

/** "0017" and "17" from two exports of one machine are the same device user. */
export function normaliseDeviceUserId(raw: string): string {
  const s = raw.trim();
  return /^\d{1,18}$/.test(s) ? BigInt(s).toString() : s;
}

/** The same punch (device, device user, time to the second) is stored once, however it arrives. */
export function punchKey(deviceId: unknown, deviceUserId: string, at: Date): string {
  return crypto
    .createHash('sha256')
    .update(`${String(deviceId)}|${deviceUserId}|${Math.floor(at.getTime() / 1000)}`)
    .digest('hex');
}

/** Device user → staff member: a link for that device wins over a link for all devices. */
export class LinkResolver {
  private constructor(private readonly byKey: Map<string, string>) {}

  static async load(ctx: TenantCtx) {
    const links = await DeviceUserLink.find(scope(ctx)).select('deviceId deviceUserId employeeId').lean();
    return new LinkResolver(
      new Map(links.map((l) => [`${l.deviceId ? String(l.deviceId) : '*'}|${l.deviceUserId}`, String(l.employeeId)])),
    );
  }

  employeeFor(deviceId: unknown, deviceUserId: string): string | undefined {
    return this.byKey.get(`${String(deviceId)}|${deviceUserId}`) ?? this.byKey.get(`*|${deviceUserId}`);
  }

  /** These links with one more (or, with `employeeId` null, one fewer): to see what a change would do. */
  with(deviceId: unknown, deviceUserId: string, employeeId: string | null) {
    const next = new Map(this.byKey);
    const key = `${deviceId ? String(deviceId) : '*'}|${deviceUserId}`;
    if (employeeId) next.set(key, employeeId);
    else next.delete(key);
    return new LinkResolver(next);
  }
}

export interface IncomingPunch {
  deviceUserId: string;
  punchedAt: Date;
  localDate: string;
  punchType: 'in' | 'out' | 'unknown';
  rawType?: string;
  rowNo?: number;
}

/**
 * Store punches from one device: each once (a punch already stored is counted as a duplicate,
 * not an error), linked to a staff member when the device user is linked, then the affected staff
 * days are brought up to date. Used by file imports and the connector API alike.
 *
 * A user limited to some campuses (an import) can only store punches of their campuses' staff.
 * When a punch was already stored by a file, the connector or the other import that also held it
 * is noted on the punch, so undoing that file keeps it (see import-undo.ts).
 */
export async function storePunches(
  ctx: TenantCtx & { campusIds?: string[] },
  device: { _id: Types.ObjectId },
  punches: IncomingPunch[],
  source: 'file' | 'connector',
  importJobId?: unknown,
) {
  await assertBiometricIndexes();
  const links = await LinkResolver.load(ctx);
  const docs = punches.map((p) => {
    const deviceUserId = normaliseDeviceUserId(p.deviceUserId);
    const employeeId = links.employeeFor(device._id, deviceUserId);
    return {
      schoolId: oid(ctx.schoolId),
      deviceId: device._id,
      deviceUserId,
      employeeId: employeeId ? oid(employeeId) : null,
      punchedAt: p.punchedAt,
      localDate: p.localDate,
      punchType: p.punchType,
      rawType: p.rawType,
      source,
      ...(importJobId ? { importJobId: oid(String(importJobId)) } : {}),
      ...(p.rowNo ? { rowNo: p.rowNo } : {}),
      dedupeKey: punchKey(device._id, deviceUserId, p.punchedAt),
    };
  });
  await assertStaffInCampus(
    ctx,
    docs.map((d) => d.employeeId),
    'These punches belong to',
  );
  let inserted: typeof docs = [];
  try {
    inserted = (await PunchEvent.insertMany(docs, { ordered: false })) as unknown as typeof docs;
  } catch (err) {
    const e = err as {
      code?: number;
      writeErrors?: Array<{ code?: number; err?: { code?: number } }>;
      insertedDocs?: typeof docs;
    };
    const errors = e.writeErrors ?? [];
    // Only "already stored" is expected; anything else is a real failure.
    if (!errors.length || errors.some((w) => (w.code ?? w.err?.code) !== 11000)) throw err;
    inserted = e.insertedDocs ?? [];
  }
  if (inserted.length < docs.length) {
    const stored = new Set(inserted.map((d) => d.dedupeKey));
    await noteAlsoDelivered(
      ctx,
      docs.filter((d) => !stored.has(d.dedupeKey)).map((d) => d.dedupeKey),
      source === 'connector' ? 'connector' : importJobId,
    );
  }
  await recomputeStaffDays(
    ctx,
    inserted.filter((d) => d.employeeId).map((d) => ({ employeeId: d.employeeId, localDate: d.localDate })),
  );
  return {
    received: punches.length,
    stored: inserted.length,
    duplicates: punches.length - inserted.length,
    linked: inserted.filter((d) => d.employeeId).length,
  };
}

/**
 * Punches already stored by a file import were delivered again: by the connector, or by another
 * import whose file also held them. Noted on the punch, so undoing the import that stored it
 * keeps the punch for the other source (see import-undo.ts).
 */
export async function noteAlsoDelivered(ctx: TenantCtx, dedupeKeys: string[], by: unknown) {
  if (!dedupeKeys.length || !by) return;
  for (let i = 0; i < dedupeKeys.length; i += 1000) {
    const keys = dedupeKeys.slice(i, i + 1000);
    if (by === 'connector')
      await PunchEvent.updateMany(scope(ctx, { dedupeKey: { $in: keys }, source: 'file' }), {
        $set: { alsoFromConnector: true },
      });
    else
      await PunchEvent.updateMany(
        scope(ctx, { dedupeKey: { $in: keys }, importJobId: { $exists: true, $ne: oid(String(by)) } }),
        { $addToSet: { alsoImportJobIds: oid(String(by)) } },
      );
  }
}

/* ───────────────────────────── Devices ───────────────────────────── */

const deviceView = (d: Record<string, any>) => {
  const { connectorKeyHash: _hash, ...rest } = d;
  return { ...rest, integrationInfo: INTEGRATIONS[d.integration as IntegrationMethod] };
};

export async function listDevices(ctx: Ctx) {
  const devices = await BiometricDevice.find(scope(ctx)).sort({ name: 1 }).lean();
  const counts = await PunchEvent.aggregate([
    { $match: { schoolId: oid(ctx.schoolId) } },
    {
      $group: {
        _id: '$deviceId',
        punches: { $sum: 1 },
        unlinked: { $sum: { $cond: [{ $eq: ['$employeeId', null] }, 1, 0] } },
      },
    },
  ]);
  const byDevice = new Map(counts.map((c) => [String(c._id), c]));
  return devices.map((d) => ({
    ...deviceView(d),
    punches: byDevice.get(String(d._id))?.punches ?? 0,
    unlinkedPunches: byDevice.get(String(d._id))?.unlinked ?? 0,
  }));
}

type DeviceInput = {
  name: string;
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  location?: string;
  campusId?: string | null;
  integration: IntegrationMethod;
};

function assertUsable(method: IntegrationMethod) {
  const info = INTEGRATIONS[method];
  if (!info.usable)
    throw badRequest(
      `${info.label} is planned but not available yet. Register the device with File import for now.`,
      [{ path: 'body.integration', message: 'Not available yet' }],
      'INTEGRATION_NOT_AVAILABLE',
    );
}

export async function createDevice(ctx: Ctx, input: DeviceInput) {
  assertUsable(input.integration);
  await assertBiometricIndexes();
  const campusId = deviceCampusFor(ctx, input.campusId);
  if (campusId) await assertRefs(ctx, [[Campus, campusId, 'campusId']]);
  try {
    const doc = await BiometricDevice.create({
      ...input,
      ...(campusId ? { campusId } : {}),
      schoolId: ctx.schoolId,
      createdBy: ctx.userId,
    });
    await audit(ctx, {
      action: 'biometric_device.create',
      entityType: 'BiometricDevice',
      entityId: doc._id,
      metadata: { name: input.name, integration: input.integration },
    });
    return deviceView(doc.toObject());
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict('A device with this name already exists', undefined, 'DUPLICATE');
    throw err;
  }
}

export async function updateDevice(
  ctx: Ctx,
  id: string,
  input: Partial<DeviceInput> & { status?: 'active' | 'disabled' },
) {
  const device = await findOwned(BiometricDevice, ctx, id, 'Device');
  assertDeviceManageable(ctx, device.campusId);
  // Moving it to another campus (or to every campus, null) needs access to that one too.
  if (input.campusId !== undefined) assertDeviceManageable(ctx, input.campusId);
  await assertBiometricIndexes();
  if (input.integration && input.integration !== device.integration) {
    assertUsable(input.integration);
    if (await PunchEvent.exists(scope(ctx, { deviceId: device._id })))
      throw conflict('This device already has punches; register a new device for another connection method');
  }
  if (input.campusId) await assertRefs(ctx, [[Campus, input.campusId, 'campusId']]);
  try {
    const updated = await BiometricDevice.findOneAndUpdate(
      scope(ctx, { _id: device._id }),
      { $set: input },
      { returnDocument: 'after', runValidators: true },
    ).lean();
    await audit(ctx, {
      action: 'biometric_device.update',
      entityType: 'BiometricDevice',
      entityId: device._id,
      metadata: { fields: Object.keys(input) },
    });
    return deviceView(updated!);
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict('A device with this name already exists', undefined, 'DUPLICATE');
    throw err;
  }
}

/** A device with punches is kept for the record: disable it instead. */
export async function deleteDevice(ctx: Ctx, id: string) {
  const device = await findOwned(BiometricDevice, ctx, id, 'Device');
  assertDeviceManageable(ctx, device.campusId);
  await assertBiometricIndexes();
  if (await PunchEvent.exists(scope(ctx, { deviceId: device._id })))
    throw conflict(
      'This device has attendance punches. Disable it instead: its punches stay part of staff attendance.',
      undefined,
      'DEVICE_HAS_PUNCHES',
    );
  await DeviceUserLink.deleteMany(scope(ctx, { deviceId: device._id }));
  await BiometricDevice.deleteOne(scope(ctx, { _id: device._id }));
  await audit(ctx, {
    action: 'biometric_device.delete',
    entityType: 'BiometricDevice',
    entityId: device._id,
    metadata: { name: device.name },
  });
}

/**
 * What can honestly be said about a device's connection. File-import devices are never
 * contacted; connector devices report when punches last arrived.
 */
export async function deviceStatus(ctx: Ctx, id: string) {
  const device = await findOwned(BiometricDevice, ctx, id, 'Device');
  if (device.integration === 'file_import')
    return {
      state: 'not_applicable' as const,
      message: 'This device is not contacted: its punches arrive when an export file is imported.',
      lastEventAt: device.lastEventAt ?? null,
    };
  if (device.integration === 'connector_api') {
    if (!device.connectorKeyHint)
      return {
        state: 'not_configured' as const,
        message: 'No connector key yet: create one and enter it in the connector.',
        lastEventAt: null,
      };
    return device.lastSyncAt
      ? {
          state: 'received' as const,
          message: `Punches last received ${device.lastSyncAt.toISOString()} (${device.lastSyncResult ?? ''})`.trim(),
          lastEventAt: device.lastEventAt ?? null,
        }
      : { state: 'waiting' as const, message: 'The connector has not sent anything yet.', lastEventAt: null };
  }
  return {
    state: 'unavailable' as const,
    message: `${INTEGRATIONS[device.integration as IntegrationMethod].label} is not available yet.`,
    lastEventAt: null,
  };
}

/** A new connector key (replaces any previous one). Shown once; only its hash is kept. */
export async function createConnectorKey(ctx: Ctx, id: string) {
  const device = await findOwned(BiometricDevice, ctx, id, 'Device');
  assertDeviceManageable(ctx, device.campusId);
  if (device.integration !== 'connector_api')
    throw badRequest('Connector keys are only for devices using the Connector API');
  const secret = crypto.randomBytes(32).toString('base64url');
  const key = `sbk_${String(device._id)}_${secret}`;
  await BiometricDevice.updateOne(scope(ctx, { _id: device._id }), {
    $set: {
      connectorKeyHash: sha256(key),
      connectorKeyHint: `…${secret.slice(-4)}`,
      connectorKeyCreatedAt: new Date(),
    },
  });
  await audit(ctx, { action: 'biometric_device.connector_key', entityType: 'BiometricDevice', entityId: device._id });
  return { key, hint: `…${secret.slice(-4)}` };
}

export async function revokeConnectorKey(ctx: Ctx, id: string) {
  const device = await findOwned(BiometricDevice, ctx, id, 'Device');
  assertDeviceManageable(ctx, device.campusId);
  await BiometricDevice.updateOne(scope(ctx, { _id: device._id }), {
    $unset: { connectorKeyHash: 1, connectorKeyHint: 1, connectorKeyCreatedAt: 1 },
  });
  await audit(ctx, {
    action: 'biometric_device.connector_key_revoked',
    entityType: 'BiometricDevice',
    entityId: device._id,
  });
}

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/* ───────────────────────────── Device users ───────────────────────────── */

export async function listLinks(ctx: Ctx) {
  const staff = await visibleStaffIds(ctx);
  return DeviceUserLink.find(scope(ctx, staff ? { employeeId: { $in: staff } } : {}))
    .populate('employeeId', 'firstName lastName employeeNo status')
    .populate('deviceId', 'name')
    .sort({ deviceUserId: 1 })
    .lean();
}

/**
 * Device users whose punches are not linked to anyone yet, with how many punches are waiting,
 * and a suggestion when the ID is exactly a staff member's Employee No (never by name).
 */
export async function unlinkedDeviceUsers(ctx: Ctx) {
  const devicesShown = await visibleDeviceIds(ctx);
  const groups = await PunchEvent.aggregate<{
    _id: { deviceId: Types.ObjectId; deviceUserId: string };
    punches: number;
    first: Date;
    last: Date;
  }>([
    {
      $match: {
        schoolId: oid(ctx.schoolId),
        employeeId: null,
        ...(devicesShown ? { deviceId: { $in: devicesShown } } : {}),
      },
    },
    {
      $group: {
        _id: { deviceId: '$deviceId', deviceUserId: '$deviceUserId' },
        punches: { $sum: 1 },
        first: { $min: '$punchedAt' },
        last: { $max: '$punchedAt' },
      },
    },
    { $sort: { '_id.deviceUserId': 1 } },
    { $limit: 1000 },
  ]);
  const staff = await Employee.find(scope(ctx, { status: { $ne: 'archived' }, ...campusScope(ctx) }))
    .select('firstName lastName employeeNo')
    .lean();
  const byNo = new Map(staff.map((s) => [normaliseDeviceUserId(s.employeeNo).toLowerCase(), s]));
  const devices = new Map(
    (await BiometricDevice.find(scope(ctx)).select('name').lean()).map((d) => [String(d._id), d.name]),
  );
  return groups.map((g) => {
    const match = byNo.get(g._id.deviceUserId.toLowerCase());
    return {
      deviceId: String(g._id.deviceId),
      deviceName: devices.get(String(g._id.deviceId)) ?? '',
      deviceUserId: g._id.deviceUserId,
      punches: g.punches,
      first: g.first,
      last: g.last,
      suggestion: match
        ? {
            employeeId: String(match._id),
            name: [match.firstName, match.lastName].filter(Boolean).join(' '),
            employeeNo: match.employeeNo,
            reason: 'The device user ID is this staff member’s Employee No',
          }
        : null,
    };
  });
}

/**
 * Link a device user to a staff member (for one device, or for every device when `deviceId` is
 * null). Punches already waiting for this device user are linked and their days worked out.
 */
export async function linkDeviceUser(
  ctx: Ctx,
  input: { deviceId?: string | null; deviceUserId: string; employeeId: string },
) {
  const deviceUserId = normaliseDeviceUserId(input.deviceUserId);
  if (!deviceUserId) throw badRequest('Device user ID is required');
  await assertBiometricIndexes();
  const employee = await staffInCampus(ctx, input.employeeId);
  if (employee.status === 'archived') throw badRequest('This staff member is archived');
  const device = input.deviceId ? await findOwned(BiometricDevice, ctx, input.deviceId, 'Device') : null;
  // A device link takes punches over from a link for all devices: a campus-limited user may only
  // move punches between staff of their campuses.
  if (campusLimited(ctx)) {
    const after = (await LinkResolver.load(ctx)).with(device?._id ?? null, deviceUserId, String(employee._id));
    await assertStaffInCampus(
      ctx,
      (await relinkPlan(ctx, deviceUserId, after)).staff,
      'This link would move punches of',
    );
  }
  let link;
  try {
    link = await DeviceUserLink.create({
      schoolId: ctx.schoolId,
      deviceId: device?._id ?? null,
      deviceUserId,
      employeeId: employee._id,
      createdBy: ctx.userId,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict(
        `Device user ${deviceUserId} is already linked${device ? ` on ${device.name}` : ' for all devices'}. Remove that link first.`,
        undefined,
        'DUPLICATE',
      );
    throw err;
  }
  const relinked = await relink(ctx, deviceUserId);
  await audit(ctx, {
    action: 'biometric_link.create',
    entityType: 'DeviceUserLink',
    entityId: link._id,
    metadata: {
      deviceUserId,
      employeeId: String(employee._id),
      deviceId: device ? String(device._id) : null,
      punchesLinked: relinked,
    },
  });
  return { link: link.toObject(), punchesLinked: relinked };
}

export async function unlinkDeviceUser(ctx: Ctx, id: string) {
  const link = await findOwned(DeviceUserLink, ctx, id, 'Link');
  await assertBiometricIndexes();
  if (campusLimited(ctx)) {
    await staffInCampus(ctx, String(link.employeeId), 'Link');
    // Without this link, a link for all devices may take its punches over.
    const after = (await LinkResolver.load(ctx)).with(link.deviceId, link.deviceUserId, null);
    await assertStaffInCampus(
      ctx,
      (await relinkPlan(ctx, link.deviceUserId, after)).staff,
      'Removing this link would move punches to',
    );
  }
  await DeviceUserLink.deleteOne(scope(ctx, { _id: link._id }));
  const relinked = await relink(ctx, link.deviceUserId);
  await audit(ctx, {
    action: 'biometric_link.delete',
    entityType: 'DeviceUserLink',
    entityId: link._id,
    metadata: { deviceUserId: link.deviceUserId, employeeId: String(link.employeeId) },
  });
  return { punchesChanged: relinked };
}

/**
 * What applying `links` to every punch of one device user ID would change: the punches that
 * change hands, grouped by (from, to) staff member, the days to work out again, and every staff
 * member involved.
 */
async function relinkPlan(ctx: TenantCtx, deviceUserId: string, links: LinkResolver) {
  const punches = await PunchEvent.find(scope(ctx, { deviceUserId })).select('deviceId employeeId localDate').lean();
  const moves = new Map<string, { from: Types.ObjectId | null; to: string | null; ids: Types.ObjectId[] }>();
  const days: Array<{ employeeId: unknown; localDate: string }> = [];
  for (const p of punches) {
    const to = links.employeeFor(p.deviceId, deviceUserId) ?? null;
    if (String(p.employeeId ?? '') === String(to ?? '')) continue;
    const key = `${String(p.employeeId ?? '')}|${to ?? ''}`;
    const move = moves.get(key) ?? { from: (p.employeeId as Types.ObjectId | null) ?? null, to, ids: [] };
    move.ids.push(p._id);
    moves.set(key, move);
    if (p.employeeId) days.push({ employeeId: p.employeeId, localDate: p.localDate });
    if (to) days.push({ employeeId: to, localDate: p.localDate });
  }
  const staff = [...moves.values()].flatMap((m) => [m.from, m.to]).filter(Boolean);
  return { moves: [...moves.values()], days, staff };
}

/**
 * Re-apply the links to every punch of one device user ID, then rework the affected days (the
 * old and the new staff member's, each once). The punches change hands in a few bulk updates (one
 * per pair of staff members, 1,000 punches at a time), each only for punches still held by the
 * staff member they are taken from. Returns how many punches changed hands.
 */
async function relink(ctx: TenantCtx, deviceUserId: string) {
  const { moves, days } = await relinkPlan(ctx, deviceUserId, await LinkResolver.load(ctx));
  const ops = moves.flatMap((m) => {
    const out = [];
    for (let i = 0; i < m.ids.length; i += 1000)
      out.push({
        updateMany: {
          filter: scope(ctx, { _id: { $in: m.ids.slice(i, i + 1000) }, employeeId: m.from }),
          update: { $set: { employeeId: m.to ? oid(m.to) : null } },
        },
      });
    return out;
  });
  const changed = ops.length ? (await PunchEvent.bulkWrite(ops, { ordered: true })).modifiedCount : 0;
  await recomputeStaffDays(ctx, days);
  return changed;
}

/* ───────────────────────────── Punches ───────────────────────────── */

/**
 * Raw punches. A campus-limited user sees the punches of their campuses' staff, and unlinked
 * punches of the devices they may link (see visibleDeviceIds).
 */
export async function listPunches(
  ctx: Ctx,
  q: { page: number; limit: number; date?: string; employeeId?: string; deviceId?: string; unlinked?: boolean },
) {
  const filter: Record<string, unknown> = scope(ctx);
  if (q.date) filter.localDate = q.date;
  if (q.employeeId) filter.employeeId = oid(q.employeeId);
  if (q.deviceId) filter.deviceId = oid(q.deviceId);
  if (q.unlinked) filter.employeeId = null;
  const [staff, devices] = await Promise.all([visibleStaffIds(ctx), visibleDeviceIds(ctx)]);
  if (staff && devices) filter.$or = [{ employeeId: { $in: staff } }, { employeeId: null, deviceId: { $in: devices } }];
  return paginate(PunchEvent, filter, {
    page: q.page,
    limit: q.limit,
    sort: { punchedAt: -1 },
    select: 'deviceId deviceUserId employeeId punchedAt localDate punchType rawType source importJobId',
    populate: [
      { path: 'employeeId', select: 'firstName lastName employeeNo' },
      { path: 'deviceId', select: 'name' },
    ],
  });
}

/* ───────────────────────────── Connector API ───────────────────────────── */

/** The device a connector key belongs to; 401 for an unknown, revoked or malformed key. */
export async function deviceForConnectorKey(key: string | undefined) {
  const m = key ? /^sbk_([a-f\d]{24})_[A-Za-z0-9_-]{40,}$/.exec(key) : null;
  if (!m) throw unauthorized('A valid connector key is required', 'INVALID_CONNECTOR_KEY');
  const device = await BiometricDevice.findById(m[1])
    .select('+connectorKeyHash schoolId status integration')
    .setOptions({ crossTenant: true })
    .lean();
  const expected = device?.connectorKeyHash ? Buffer.from(device.connectorKeyHash, 'hex') : Buffer.alloc(32);
  const given = Buffer.from(sha256(key!), 'hex');
  if (!device?.connectorKeyHash || !crypto.timingSafeEqual(expected, given))
    throw unauthorized('A valid connector key is required', 'INVALID_CONNECTOR_KEY');
  if (device.status !== 'active') throw forbidden('This device is disabled', 'DEVICE_DISABLED');
  if (device.integration !== 'connector_api')
    throw forbidden('This device does not use the Connector API', 'DEVICE_NOT_CONNECTOR');
  return device;
}

/**
 * Punches sent by a connector. Times must carry their time zone (ISO 8601 with Z or an offset),
 * so the connector's PC settings cannot shift them. Each punch is answered: stored, duplicate
 * or rejected with the reason; one bad punch never blocks the others.
 */
export async function ingestPunches(
  key: string | undefined,
  body: { punches: Array<{ deviceUserId: string; timestamp: string; punchType?: string }> },
) {
  const device = await deviceForConnectorKey(key);
  const ctx: SystemContext = { kind: 'system', schoolId: String(device.schoolId), label: 'Biometric connector' };
  const timeZone = await schoolTimezone(ctx.schoolId);
  const rejected: Array<{ index: number; reason: string }> = [];
  const ok: IncomingPunch[] = [];
  body.punches.forEach((p, index) => {
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(p.timestamp.trim())) {
      rejected.push({ index, reason: 'timestamp must include its time zone (e.g. 2026-10-24T08:01:33+05:00)' });
      return;
    }
    const t = parsePunchTime(p.timestamp, undefined, { order: null, timeZone });
    if (!t.ok) {
      rejected.push({ index, reason: `timestamp ${t.error}` });
      return;
    }
    const deviceUserId = normaliseDeviceUserId(p.deviceUserId);
    if (!deviceUserId) {
      rejected.push({ index, reason: 'deviceUserId is empty' });
      return;
    }
    ok.push({
      deviceUserId,
      punchedAt: t.at,
      localDate: t.localDate,
      punchType: p.punchType ? parsePunchType(p.punchType) : 'unknown',
      rawType: p.punchType,
    });
  });
  const result = ok.length
    ? await storePunches(ctx, device, ok, 'connector')
    : { received: 0, stored: 0, duplicates: 0, linked: 0 };
  const latest = ok.reduce<Date | undefined>((m, p) => (!m || p.punchedAt > m ? p.punchedAt : m), undefined);
  await BiometricDevice.updateOne(
    { schoolId: device.schoolId, _id: device._id },
    {
      $set: {
        lastSyncAt: new Date(),
        lastSyncResult: `${result.stored} stored, ${result.duplicates} already stored, ${rejected.length} rejected`,
      },
      ...(latest ? { $max: { lastEventAt: latest } } : {}),
    },
  );
  return { stored: result.stored, duplicates: result.duplicates, linked: result.linked, rejected };
}
