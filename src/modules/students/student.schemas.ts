import { email, isoDate, objectId, phonePk, z } from '../../utils/zod';

/** Student and inline parent fields, shared by the student routes and the student import. */
export const ParentInline = z.object({
  name: z.string().trim().min(2).max(100),
  phone: phonePk(),
  relation: z.enum(['father', 'mother', 'guardian', 'other']).optional(),
  cnic: z
    .string()
    .trim()
    .regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC must be 13 digits')
    .optional(),
  email: email().optional(),
  whatsapp: phonePk().optional(),
  occupation: z.string().trim().max(80).optional(),
  address: z.string().trim().max(300).optional(),
});

export const Guardian = z.object({
  parentId: objectId().optional(),
  parent: ParentInline.optional().openapi({ description: 'Create (or reuse by phone) a parent record inline' }),
  relation: z.string().trim().max(30).optional(),
  isPrimary: z.boolean().optional(),
});

export const StudentBody = z.object({
  campusId: objectId(),
  admissionNo: z.string().trim().max(30).optional().openapi({ description: 'Auto-generated when omitted' }),
  rollNo: z.string().trim().max(20).optional(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  gender: z.enum(['male', 'female', 'other']),
  dateOfBirth: isoDate().optional(),
  bFormNo: z.string().trim().max(20).optional().openapi({ description: 'NADRA B-Form number (sensitive)' }),
  bloodGroup: z.string().trim().max(5).optional(),
  medicalNotes: z.string().trim().max(1000).optional().openapi({ description: 'Sensitive' }),
  address: z.string().trim().max(300).optional(),
  phone: phonePk().optional(),
  sessionId: objectId(),
  classId: objectId(),
  sectionId: objectId(),
  admissionDate: isoDate().optional(),
  previousSchool: z.string().trim().max(120).optional(),
  guardians: z.array(Guardian).max(4).optional(),
});
