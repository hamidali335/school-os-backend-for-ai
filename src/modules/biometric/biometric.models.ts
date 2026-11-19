import { model, Schema } from 'mongoose';
import { baseOptions, createdOnlyOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';
import { INTEGRATION_METHODS } from './adapters/registry';

/**
 * Biometric attendance for STAFF. Kept apart from student attendance (AttendanceRecord):
 * - a device (a fingerprint machine the school registers),
 * - links from a device user ID to a staff member, made explicitly by an administrator,
 * - raw punches exactly as the device recorded them (never changed, never merged),
 * - one daily attendance record per staff member and day, worked out from the punches unless
 *   someone marked the day by hand.
 * No fingerprint images or templates are stored anywhere: only who punched, where and when.
 */

export const DEVICE_STATUSES = ['active', 'disabled'] as const;

const BiometricDeviceSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      campusId: { type: ObjectId, ref: 'Campus' },
      name: { type: String, required: true, trim: true },
      manufacturer: { type: String, trim: true },
      model: { type: String, trim: true },
      serialNumber: { type: String, trim: true },
      location: { type: String, trim: true },
      integration: { type: String, enum: INTEGRATION_METHODS, required: true },
      status: { type: String, enum: DEVICE_STATUSES, default: 'active' },
      /** Connector API key: only its SHA-256 hash is kept; the key is shown once when created. */
      connectorKeyHash: { type: String, select: false },
      connectorKeyHint: { type: String },
      connectorKeyCreatedAt: { type: Date },
      lastEventAt: { type: Date },
      lastSyncAt: { type: Date },
      lastSyncResult: { type: String },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
BiometricDeviceSchema.index({ schoolId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const BiometricDevice = model('BiometricDevice', BiometricDeviceSchema);

/**
 * "Device user 17 is Ayesha Khan." Device user IDs are numbered per machine, so a link belongs
 * to one device, or to every device of the school (`deviceId` null) when the school enrols staff
 * with the same number on all its machines.
 */
const DeviceUserLinkSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      deviceId: { type: ObjectId, ref: 'BiometricDevice', default: null },
      deviceUserId: { type: String, required: true, trim: true },
      employeeId: { type: ObjectId, ref: 'Employee', required: true },
      createdBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
DeviceUserLinkSchema.index({ schoolId: 1, deviceId: 1, deviceUserId: 1 }, { unique: true });
DeviceUserLinkSchema.index({ schoolId: 1, employeeId: 1 });
export const DeviceUserLink = model('DeviceUserLink', DeviceUserLinkSchema);

export const PUNCH_TYPES = ['in', 'out', 'unknown'] as const;
export const PUNCH_SOURCES = ['file', 'connector'] as const;

const PunchEventSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      deviceId: { type: ObjectId, ref: 'BiometricDevice', required: true },
      deviceUserId: { type: String, required: true },
      /** Set once the device user is linked to a staff member (now or later). */
      employeeId: { type: ObjectId, ref: 'Employee', default: null },
      punchedAt: { type: Date, required: true },
      /** The school's calendar day of the punch (YYYY-MM-DD in the school's time zone). */
      localDate: { type: String, required: true },
      punchType: { type: String, enum: PUNCH_TYPES, default: 'unknown' },
      /** The punch type exactly as the device or file gave it. */
      rawType: { type: String },
      source: { type: String, enum: PUNCH_SOURCES, required: true },
      importJobId: { type: ObjectId, ref: 'ImportJob' },
      rowNo: { type: Number },
      /** Later imports whose file also held this punch (found "already imported"): undoing the
       *  import that stored it hands the punch to one of them instead of deleting it. */
      alsoImportJobIds: { type: [ObjectId], default: undefined },
      /** The connector also sent this punch after a file stored it: undoing that import keeps it. */
      alsoFromConnector: { type: Boolean },
      /** Device + device user + time to the second: the same punch is stored once, however often it is imported. */
      dedupeKey: { type: String, required: true },
    },
    createdOnlyOptions,
  ),
);
PunchEventSchema.index({ schoolId: 1, dedupeKey: 1 }, { unique: true });
PunchEventSchema.index({ schoolId: 1, employeeId: 1, localDate: 1 });
PunchEventSchema.index({ schoolId: 1, deviceId: 1, deviceUserId: 1 });
PunchEventSchema.index({ schoolId: 1, localDate: 1 });
// Undoing an import finds exactly its punches, and the punches other imports also held.
PunchEventSchema.index({ schoolId: 1, importJobId: 1 });
PunchEventSchema.index({ schoolId: 1, alsoImportJobIds: 1 }, { sparse: true });
export const PunchEvent = model('PunchEvent', PunchEventSchema);

export const STAFF_ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'leave', 'half_day'] as const;

const StaffAttendanceSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      employeeId: { type: ObjectId, ref: 'Employee', required: true },
      /** Calendar day, stored as UTC midnight of the school's local day (as other date fields). */
      date: { type: Date, required: true },
      status: { type: String, enum: STAFF_ATTENDANCE_STATUSES, required: true },
      /** biometric: worked out from punches; manual: set by a person (never overwritten by punches). */
      source: { type: String, enum: ['biometric', 'manual'], required: true },
      note: { type: String, trim: true },
      /** Arrival and departure (HH:mm, school time) from an uploaded attendance file. */
      times: { in: { type: String }, out: { type: String } },
      markedBy: { type: ObjectId, ref: 'User' },
      markedAt: { type: Date },
      /** The day's punches, kept up to date whatever the source. */
      punches: {
        count: { type: Number, default: 0 },
        first: { type: Date },
        last: { type: Date },
        in: { type: Number, default: 0 },
        out: { type: Number, default: 0 },
      },
      /** A disagreement for a person to resolve, e.g. marked absent by hand but punched in. */
      conflict: {
        code: { type: String },
        message: { type: String },
        at: { type: Date },
      },
      /** Someone kept the mark after a conflict: the same punches do not raise it again. */
      conflictDismissed: { type: Boolean, default: false },
    },
    baseOptions,
  ),
);
StaffAttendanceSchema.index({ schoolId: 1, employeeId: 1, date: 1 }, { unique: true });
StaffAttendanceSchema.index({ schoolId: 1, date: 1 });
StaffAttendanceSchema.index({ schoolId: 1, 'conflict.code': 1 });
export const StaffAttendance = model('StaffAttendance', StaffAttendanceSchema);
