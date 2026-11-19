import { model, Schema } from 'mongoose';
import { baseOptions, ObjectId, tenantField, withTenant } from '../../database/schema-helpers';

export const EXAM_STATUSES = ['draft', 'scheduled', 'marks_entry', 'published'] as const;

const ExamSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      sessionId: { type: ObjectId, ref: 'AcademicSession', required: true },
      name: { type: String, required: true, trim: true },
      term: { type: String, enum: ['first_term', 'mid_term', 'final_term', 'monthly_test', 'other'], default: 'other' },
      startDate: { type: Date },
      endDate: { type: Date },
      classIds: { type: [ObjectId], ref: 'SchoolClass', default: [] },
      status: { type: String, enum: EXAM_STATUSES, default: 'draft' },
      publishedAt: { type: Date },
      publishedBy: { type: ObjectId, ref: 'User' },
      /** Incremented on every date-sheet save; clients send it back to detect concurrent edits. */
      datesheetVersion: { type: Number, default: 0 },
    },
    baseOptions,
  ),
);
ExamSchema.index({ schoolId: 1, sessionId: 1, name: 1 }, { unique: true });
export const Exam = model('Exam', ExamSchema);

const ExamPaperSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      examId: { type: ObjectId, ref: 'Exam', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      subjectId: { type: ObjectId, ref: 'Subject', required: true },
      maxMarks: { type: Number, required: true, min: 1 },
      passMarks: { type: Number, required: true, min: 0 },
      date: { type: Date },
      startTime: { type: String },
      durationMinutes: { type: Number },
    },
    baseOptions,
  ),
);
ExamPaperSchema.index({ schoolId: 1, examId: 1, classId: 1, subjectId: 1 }, { unique: true });
export const ExamPaper = model('ExamPaper', ExamPaperSchema);

const MarkSchema = withTenant(
  new Schema(
    {
      ...tenantField,
      examId: { type: ObjectId, ref: 'Exam', required: true },
      paperId: { type: ObjectId, ref: 'ExamPaper', required: true },
      studentId: { type: ObjectId, ref: 'Student', required: true },
      sectionId: { type: ObjectId, ref: 'Section', required: true },
      classId: { type: ObjectId, ref: 'SchoolClass', required: true },
      subjectId: { type: ObjectId, ref: 'Subject', required: true },
      obtained: { type: Number, min: 0 },
      isAbsent: { type: Boolean, default: false },
      /**
       * Elective papers only: the student does not take this subject, recorded explicitly by
       * whoever enters marks (and in the audit log). A blank is never read as "not taken".
       */
      notTaken: { type: Boolean, default: false },
      remarks: { type: String },
      enteredBy: { type: ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
MarkSchema.index({ schoolId: 1, paperId: 1, studentId: 1 }, { unique: true });
MarkSchema.index({ schoolId: 1, examId: 1, sectionId: 1 });
MarkSchema.index({ schoolId: 1, studentId: 1 });
export const Mark = model('Mark', MarkSchema);
