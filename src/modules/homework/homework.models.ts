import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

const HomeworkSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      campusId: { type: ObjectId, ref: 'Campus', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      subjectId: { type: ObjectId, ref: 'Subject', required: true },
      /**
       * The teacher this homework is attributed to (historical record; not rewritten when the
       * subject's teacher later changes). Empty only when it was knowingly saved unassigned.
       */
      teacherId: { type: ObjectId, ref: 'Employee' },
      /**
       * creator: a teacher set it themselves; explicit: an administrator picked the teacher;
       * assignment: taken from the class-subject teaching assignment at creation;
       * backfill: filled in when a teacher was later assigned to the class-subject.
       */
      teacherSource: { type: String, enum: ['creator', 'explicit', 'assignment', 'backfill'] },
      /** Set when a substitute teacher created it while covering. */
      createdViaSubstituteId: { type: ObjectId, ref: 'SubstituteAssignment' },
      createdBy: { type: ObjectId, ref: 'User', required: true },
      title: { type: String, required: true, trim: true },
      description: { type: String, required: true },
      type: { type: String, enum: ['homework', 'assignment', 'project'], default: 'homework' },
      assignedOn: { type: Date, required: true },
      dueDate: { type: Date, required: true },
      maxMarks: { type: Number, min: 0 },
      attachmentIds: { type: [ObjectId], ref: 'FileObject', default: [] },
      status: { type: String, enum: ['published', 'closed'], default: 'published' },
    },
    baseOptions,
  ),
);
HomeworkSchema.index({ schoolId: 1, sectionId: 1, dueDate: -1 });
HomeworkSchema.index({ schoolId: 1, sectionId: 1, subjectId: 1 });
export const Homework = model('Homework', HomeworkSchema);

const SubmissionSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      homeworkId: { type: ObjectId, ref: 'Homework', required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      text: { type: String },
      attachmentIds: { type: [ObjectId], ref: 'FileObject', default: [] },
      submittedAt: { type: Date },
      isLate: { type: Boolean, default: false },
      status: { type: String, enum: ['pending', 'submitted', 'graded', 'returned'], default: 'submitted' },
      marks: { type: Number, min: 0 },
      feedback: { type: String },
      gradedBy: { type: ObjectId, ref: 'User' },
      gradedAt: { type: Date },
    },
    baseOptions,
  ),
);
SubmissionSchema.index({ schoolId: 1, homeworkId: 1, studentId: 1 }, { unique: true });
export const HomeworkSubmission = model('HomeworkSubmission', SubmissionSchema);
