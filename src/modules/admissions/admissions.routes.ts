import type { Api } from '../../utils/api';
import {
  docBase,
  email,
  idParams,
  isoDate,
  isoDateTime,
  objectId,
  paginationQuery,
  phonePk,
  queryBool,
  z,
} from '../../utils/zod';
import { StudentRes } from '../students/students.routes';
import * as svc from './admissions.service';
import { INQUIRY_SOURCES, INQUIRY_STAGES } from './inquiry.model';

const InquiryRes = z
  .object({
    ...docBase,
    campusId: objectId(),
    inquiryNo: z.string(),
    studentName: z.string(),
    gender: z.string().optional(),
    dateOfBirth: z.string().optional(),
    classSoughtId: z.any().optional(),
    classSoughtName: z.string().optional(),
    parentName: z.string(),
    phone: z.string(),
    email: z.string().optional(),
    source: z.enum(INQUIRY_SOURCES),
    stage: z.enum(INQUIRY_STAGES),
    priority: z.enum(['low', 'medium', 'high']),
    assignedTo: z.any().optional(),
    nextFollowUpAt: z.string().nullable().optional(),
    lastContactedAt: z.string().optional(),
    followUps: z
      .array(
        z.object({
          at: z.string(),
          byName: z.string().optional(),
          channel: z.string(),
          note: z.string().optional(),
          outcome: z.string().optional(),
        }),
      )
      .optional(),
    lostReason: z.string().optional(),
    convertedStudentId: objectId().optional(),
    notes: z.string().optional(),
  })
  .openapi('Inquiry');

const InquiryBody = z.object({
  campusId: objectId(),
  studentName: z.string().trim().min(2).max(120),
  gender: z.enum(['male', 'female', 'other']).optional(),
  dateOfBirth: isoDate().optional(),
  classSoughtId: objectId().optional(),
  parentName: z.string().trim().min(2).max(120),
  phone: phonePk(),
  email: email().optional(),
  address: z.string().trim().max(300).optional(),
  previousSchool: z.string().trim().max(120).optional(),
  source: z.enum(INQUIRY_SOURCES).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assignedTo: objectId().optional(),
  nextFollowUpAt: isoDateTime().optional(),
  notes: z.string().trim().max(1000).optional(),
});

export function registerAdmissionRoutes(api: Api) {
  const tags = ['Admissions'];

  api.route({
    method: 'get',
    path: '/admissions/inquiries',
    tags,
    auth: 'school',
    permission: 'admissions:read',
    summary: 'List admission inquiries',
    query: paginationQuery.extend({
      stage: z.enum(INQUIRY_STAGES).optional(),
      source: z.enum(INQUIRY_SOURCES).optional(),
      assignedTo: objectId().optional(),
      campusId: objectId().optional(),
      followUpDue: queryBool().openapi({ description: 'Only open inquiries whose follow-up is due now or overdue' }),
      q: z.string().max(100).optional(),
    }),
    response: InquiryRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listInquiries(ctx, query),
  });

  api.route({
    method: 'post',
    path: '/admissions/inquiries',
    tags,
    auth: 'school',
    permission: 'admissions:manage',
    summary: 'Create an inquiry',
    description: 'Rejects a duplicate open inquiry for the same student name and phone (409).',
    body: InquiryBody,
    response: InquiryRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createInquiry(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/admissions/inquiries/:id',
    tags,
    auth: 'school',
    permission: 'admissions:read',
    summary: 'Inquiry with follow-up history',
    params: idParams,
    response: InquiryRes,
    handler: ({ ctx, params }) => svc.getInquiry(ctx, params.id),
  });

  api.route({
    method: 'patch',
    path: '/admissions/inquiries/:id',
    tags,
    auth: 'school',
    permission: 'admissions:manage',
    summary: 'Update an inquiry (details, stage, assignee, next follow-up)',
    params: idParams,
    body: InquiryBody.partial().extend({ stage: z.enum(INQUIRY_STAGES).optional() }),
    response: InquiryRes,
    handler: ({ ctx, params, body }) => svc.updateInquiry(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/admissions/inquiries/:id/follow-ups',
    tags,
    auth: 'school',
    permission: 'admissions:manage',
    summary: 'Log a follow-up and schedule the next one',
    params: idParams,
    body: z.object({
      channel: z.enum(['call', 'visit', 'sms', 'whatsapp', 'email', 'other']),
      note: z.string().trim().min(2).max(1000),
      outcome: z.string().trim().max(200).optional(),
      nextFollowUpAt: isoDateTime().nullable().optional(),
      stage: z.enum(INQUIRY_STAGES).optional(),
    }),
    response: InquiryRes,
    status: 201,
    handler: ({ ctx, params, body }) => svc.addFollowUp(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/admissions/inquiries/:id/lost',
    tags,
    auth: 'school',
    permission: 'admissions:manage',
    summary: 'Close an inquiry as lost',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(2).max(300) }),
    response: InquiryRes,
    handler: ({ ctx, params, body }) => svc.markLost(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/admissions/inquiries/:id/convert',
    tags,
    auth: 'school',
    permission: ['admissions:manage', 'students:manage'],
    summary: 'Admit: convert an inquiry into an enrolled student',
    description: 'Creates the student (and parent record from the inquiry) and marks the inquiry admitted.',
    params: idParams,
    body: z.object({
      sessionId: objectId(),
      classId: objectId(),
      sectionId: objectId(),
      gender: z.enum(['male', 'female', 'other']),
      firstName: z.string().trim().min(1).max(60).optional(),
      lastName: z.string().trim().max(60).optional(),
      admissionNo: z.string().trim().max(30).optional(),
      rollNo: z.string().trim().max(20).optional(),
      dateOfBirth: isoDate().optional(),
      bFormNo: z.string().trim().max(20).optional(),
      address: z.string().trim().max(300).optional(),
      previousSchool: z.string().trim().max(120).optional(),
      admissionDate: isoDate().optional(),
    }),
    response: z.object({ inquiryId: objectId(), student: StudentRes }),
    status: 201,
    handler: ({ ctx, params, body }) => svc.convertInquiry(ctx, params.id, body),
  });

  api.route({
    method: 'get',
    path: '/admissions/pipeline',
    tags,
    auth: 'school',
    permission: 'admissions:read',
    summary: 'Admissions funnel: counts per stage and source, conversion rate, follow-ups due',
    query: z.object({ from: isoDate().optional(), to: isoDate().optional() }),
    response: z.object({
      total: z.number(),
      open: z.number(),
      stages: z.record(z.string(), z.number()),
      conversionRate: z.number().openapi({ description: 'admitted / (admitted + lost), percent' }),
      bySource: z.array(
        z.object({ source: z.string(), total: z.number(), admitted: z.number(), conversionRate: z.number() }),
      ),
      followUps: z.object({ overdue: z.number(), dueToday: z.number() }),
    }),
    handler: ({ ctx, query }) => svc.pipeline(ctx, query),
  });
}
