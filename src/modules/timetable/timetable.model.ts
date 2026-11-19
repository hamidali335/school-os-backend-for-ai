import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

const TimetableEntrySchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      subjectId: { type: ObjectId, ref: 'Subject', required: true },
      teacherId: { type: ObjectId, ref: 'Employee' },
      /** ISO weekday: 1 = Monday ... 7 = Sunday */
      dayOfWeek: { type: Number, required: true, min: 1, max: 7 },
      startTime: { type: String, required: true },
      endTime: { type: String, required: true },
      startMinutes: { type: Number, required: true },
      endMinutes: { type: Number, required: true },
      room: { type: String, trim: true },
    },
    baseOptions,
  ),
);
TimetableEntrySchema.index({ schoolId: 1, sessionId: 1, dayOfWeek: 1, sectionId: 1 });
TimetableEntrySchema.index({ schoolId: 1, sessionId: 1, dayOfWeek: 1, teacherId: 1 });
TimetableEntrySchema.index({ schoolId: 1, sessionId: 1, dayOfWeek: 1, campusId: 1, room: 1 });
export const TimetableEntry = model('TimetableEntry', TimetableEntrySchema);
