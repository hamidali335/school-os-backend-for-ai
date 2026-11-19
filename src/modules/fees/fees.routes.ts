import { challanFigures, renderChallan, renderChallans, renderFamilyVoucher, renderReceipt } from '../../services/pdf';
import { loadBrand } from '../branding/branding.service';
import type { Api } from '../../utils/api';
import { crudRoutes, refuseIfReferenced } from '../../utils/crud';
import { findOwned, oid, scope } from '../../utils/tenant';
import {
  amountPkr,
  billingPeriod,
  docBase,
  idParams,
  isoDate,
  isoDateTime,
  objectId,
  paginationQuery,
  queryBool,
  z,
} from '../../utils/zod';
import { ApprovalRes } from '../approvals/approvals.routes';
import { audit } from '../audit/audit.service';
import { PAYMENT_METHODS } from '../accounts/accounts.models';
import { School } from '../schools/school.model';
import { Parent } from '../students/student.models';
import { AppError, badRequest } from '../../utils/errors';
import {
  FEE_FREQUENCIES,
  FEE_HEAD_BILLING,
  FeeHead,
  FeeStructure,
  INVOICE_KINDS,
  INVOICE_STATUSES,
} from './fees.models';
import { addDefaultFeeHeads, DEFAULT_FEE_HEADS, defaultFeeHeads } from './fee-defaults';
import * as feeTemplate from './fee-template';
import * as feeRollover from './fee-rollover.service';
import { createStudentInvoice, studentInvoicePreview } from './student-invoice';
import * as svc from './fees.service';
import { bulkChallans } from './bulk-challans';
import { challanData, familyAccount, familyReference, previousDues } from './family-voucher';

const FeeHeadRes = z
  .object({
    ...docBase,
    name: z.string(),
    code: z.string(),
    frequency: z.enum(FEE_FREQUENCIES),
    billing: z.enum(FEE_HEAD_BILLING).optional(),
    concessionApplies: z.boolean(),
    description: z.string().optional(),
    isActive: z.boolean(),
  })
  .openapi('FeeHead');

const BreakdownLine = z
  .object({
    line: z.string(),
    name: z.string(),
    feeHeadId: z.string().nullable(),
    charged: z.number(),
    discount: z.number(),
    net: z.number(),
    paid: z.number(),
    waived: z.number(),
    outstanding: z.number(),
    status: z.enum(['paid', 'partial', 'unpaid']),
  })
  .openapi('InvoiceLineStatus');

const FeeStructureRes = z
  .object({
    ...docBase,
    sessionId: objectId(),
    classId: z.any(),
    name: z.string(),
    items: z.array(z.object({ feeHeadId: z.any(), amount: z.number(), billingMonths: z.array(z.number()) })),
    isActive: z.boolean(),
  })
  .openapi('FeeStructure');

const InvoiceRes = z
  .object({
    ...docBase,
    campusId: objectId(),
    studentId: z.any().openapi({ description: 'Student id, or populated {firstName,lastName,admissionNo}' }),
    invoiceNo: z.string(),
    kind: z.enum(INVOICE_KINDS).openapi({ description: 'opening = dues from before School OS (fee import)' }),
    period: z.string(),
    issueDate: z.string(),
    dueDate: z.string(),
    items: z.array(z.object({ name: z.string(), amount: z.number(), feeHeadId: objectId().optional() })),
    subtotal: z.number(),
    concession: z.number(),
    waiver: z.number(),
    lateFee: z.number(),
    total: z.number(),
    paid: z.number(),
    balance: z.number(),
    status: z.enum(INVOICE_STATUSES),
    installments: z.array(z.any()),
  })
  .openapi('Invoice');

const PaymentRes = z
  .object({
    ...docBase,
    invoiceId: z.any(),
    studentId: z.any(),
    receiptNo: z.string(),
    amount: z.number(),
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().optional(),
    receivedAt: z.string(),
    receivedByName: z.string().optional(),
    allocations: z.array(z.object({ installmentNo: z.number(), amount: z.number() })),
    balanceAfter: z.number().optional(),
    status: z.enum(['valid', 'reversed']),
    headAllocations: z.array(z.object({ line: z.string(), name: z.string(), amount: z.number() })).optional(),
    allocationSource: z.enum(['chosen', 'automatic']).optional().openapi({
      description: 'How the fees this payment settles were decided; absent on payments recorded before this was kept',
    }),
  })
  .openapi('Payment');

const PaymentBreakdown = z
  .object({
    available: z.boolean().openapi({ description: 'false for older payments whose fee breakdown was not recorded' }),
    source: z.enum(['chosen', 'automatic']).nullable(),
    lines: z.array(z.object({ name: z.string(), due: z.number(), paidNow: z.number(), remaining: z.number() })),
    unallocated: z.number(),
  })
  .openapi('PaymentBreakdown');

export function registerFeeRoutes(api: Api) {
  const tag = 'Fees';
  const tags = [tag];

  crudRoutes(api, {
    path: '/fees/heads',
    tag,
    label: 'fee head',
    model: FeeHead,
    read: 'fees:read',
    write: 'fees:manage',
    createSchema: z.object({
      name: z.string().trim().min(2).max(60).openapi({ example: 'Tuition Fee' }),
      code: z.string().trim().min(1).max(15).openapi({ example: 'TUITION' }),
      frequency: z.enum(FEE_FREQUENCIES),
      billing: z.enum(FEE_HEAD_BILLING).optional(),
      concessionApplies: z.boolean().optional(),
      description: z.string().max(300).optional(),
      isActive: z.boolean().optional(),
    }),
    response: FeeHeadRes,
    sort: { name: 1 },
    searchFields: ['name', 'code'],
    beforeDelete: refuseIfReferenced([
      [FeeStructure, 'items.feeHeadId', 'fee structures'],
      [feeTemplate.FeeTemplate, 'items.feeHeadId', 'the default fee structure'],
    ]),
  });

  api.route({
    method: 'get',
    path: '/fees/default-heads',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Common fee heads the school can add, and which it already has',
    description: 'Names and billing rules only, never amounts. Nothing is added until POST /fees/default-heads.',
    response: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        frequency: z.enum(FEE_FREQUENCIES),
        billing: z.enum(FEE_HEAD_BILLING),
        concessionApplies: z.boolean(),
        description: z.string(),
        exists: z.boolean(),
        existingName: z.string().nullable(),
      }),
    ),
    handler: ({ ctx }) => defaultFeeHeads(ctx),
  });

  api.route({
    method: 'post',
    path: '/fees/default-heads',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Add chosen common fee heads (skips any the school already has)',
    description:
      'Idempotent: a head whose code or name already exists is skipped and existing heads are never changed.',
    body: z.object({
      codes: z
        .array(z.enum(DEFAULT_FEE_HEADS.map((d) => d.code) as [string, ...string[]]))
        .min(1)
        .max(DEFAULT_FEE_HEADS.length),
    }),
    response: z.object({
      created: z.array(z.string()),
      skipped: z.array(z.object({ code: z.string(), reason: z.string() })),
    }),
    handler: ({ ctx, body }) => addDefaultFeeHeads(ctx, body.codes),
  });

  api.route({
    method: 'get',
    path: '/fees/structures',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'List fee structures',
    query: z.object({ sessionId: objectId().optional(), classId: objectId().optional() }),
    response: z.array(FeeStructureRes),
    handler: ({ ctx, query }) =>
      FeeStructure.find(
        scope(ctx, {
          ...(query.sessionId ? { sessionId: oid(query.sessionId) } : {}),
          ...(query.classId ? { classId: oid(query.classId) } : {}),
        }),
      )
        .populate('classId', 'name level')
        .populate('items.feeHeadId', 'name code frequency')
        .lean(),
  });

  api.route({
    method: 'put',
    path: '/fees/structures',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Create or replace the fee structure for a class in a session',
    body: z.object({
      sessionId: objectId(),
      classId: objectId(),
      name: z.string().trim().min(2).max(80),
      items: z
        .array(
          z.object({
            feeHeadId: objectId(),
            amount: amountPkr(),
            billingMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
          }),
        )
        .min(1)
        .max(30),
    }),
    response: FeeStructureRes,
    handler: ({ ctx, body }) => svc.upsertFeeStructure(ctx, body),
  });

  api.route({
    method: 'delete',
    path: '/fees/structures/:id',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Delete a fee structure',
    params: idParams,
    status: 204,
    handler: async ({ ctx, params }) => {
      const doc = await findOwned(FeeStructure, ctx, params.id, 'Fee structure');
      await FeeStructure.deleteOne(scope(ctx, { _id: doc._id }));
      await audit(ctx, { action: 'fee_structure.delete', entityType: 'FeeStructure', entityId: doc._id });
    },
  });

  // ── Default fee structure (template) for new classes ──
  const TemplateItems = z
    .array(
      z.object({
        feeHeadId: objectId(),
        amount: amountPkr(),
        billingMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
      }),
    )
    .min(1)
    .max(30);
  const FeeTemplateRes = z
    .object({
      ...docBase,
      sessionId: objectId(),
      name: z.string(),
      items: z.array(z.object({ feeHeadId: z.any(), amount: z.number(), billingMonths: z.array(z.number()) })),
    })
    .openapi('FeeTemplate');
  const SessionQuery = z.object({ sessionId: objectId() });

  api.route({
    method: 'get',
    path: '/fees/default-template',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: "The session's default fee structure for new classes (null when none is set)",
    query: SessionQuery,
    response: FeeTemplateRes.nullable(),
    handler: ({ ctx, query }) => feeTemplate.getFeeTemplate(ctx, query.sessionId),
  });

  api.route({
    method: 'put',
    path: '/fees/default-template',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Set the default fee structure that new classes start with',
    description:
      'Same rules as a class structure (class-wide heads only; a month for annual and term heads). A class created afterwards in this session ' +
      'starts with a copy that can be changed. Existing class structures are never changed by saving the template; use POST /fees/default-template/apply to give it to classes that have none.',
    body: z.object({ sessionId: objectId(), name: z.string().trim().min(2).max(80), items: TemplateItems }),
    response: FeeTemplateRes,
    handler: async ({ ctx, body }) => (await feeTemplate.saveFeeTemplate(ctx, body))!,
  });

  api.route({
    method: 'delete',
    path: '/fees/default-template/:sessionId',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Remove the default fee structure (new classes then start without one)',
    params: SessionQuery,
    status: 204,
    handler: ({ ctx, params }) => feeTemplate.deleteFeeTemplate(ctx, params.sessionId),
  });

  api.route({
    method: 'get',
    path: '/fees/default-template/preview',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'What applying the default would do for each class (nothing is changed)',
    description:
      '`create`: the class has no structure and would get the default. `keep`: it has its own, which stays. `none`: no default is set.',
    query: SessionQuery,
    response: z.object({
      hasTemplate: z.boolean(),
      classes: z.array(
        z.object({
          classId: objectId(),
          name: z.string(),
          action: z.enum(['create', 'keep', 'none']),
          existingStructure: z.string().nullable(),
        }),
      ),
    }),
    handler: ({ ctx, query }) => feeTemplate.previewFeeTemplate(ctx, query.sessionId),
  });

  api.route({
    method: 'post',
    path: '/fees/default-template/apply',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Give the default fee structure to classes that have none (never overwrites)',
    body: z.object({ sessionId: objectId(), classIds: z.array(objectId()).max(200).optional() }),
    response: z.object({ created: z.array(z.string()), kept: z.array(z.string()) }),
    handler: ({ ctx, body }) => feeTemplate.applyFeeTemplate(ctx, body.sessionId, body.classIds),
  });

  const FeeRolloverPreviewBody = z
    .object({
      fromSessionId: objectId(),
      toSessionId: objectId(),
      adjustments: z
        .object({
          defaultPercent: z.number().min(-100).max(1000).optional(),
          feeHeadAdjustments: z.record(z.string(), z.number().min(-100).max(1000)).optional(),
          classAdjustments: z.record(z.string(), z.number().min(-100).max(1000)).optional(),
        })
        .optional(),
    })
    .openapi('FeeRolloverPreviewBody');

  const FeeRolloverExecuteBody = FeeRolloverPreviewBody.extend({
    overwriteExisting: z.boolean().optional(),
    selectedClassIds: z.array(objectId()).optional(),
  }).openapi('FeeRolloverExecuteBody');

  api.route({
    method: 'post',
    path: '/fees/rollover-preview',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Preview fee structure carry-forward to a new academic session with optional adjustments',
    body: FeeRolloverPreviewBody,
    response: z.any(),
    handler: ({ ctx, body }) => feeRollover.previewFeeStructureRollover(ctx, body as any),
  });

  api.route({
    method: 'post',
    path: '/fees/rollover',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Carry forward fee structures from previous session with optional adjustments',
    body: FeeRolloverExecuteBody,
    response: z.any(),
    handler: ({ ctx, body }) => feeRollover.executeFeeStructureRollover(ctx, body as any),
  });

  const PreviewItem = z.object({
    feeHeadId: z.string(),
    name: z.string(),
    amount: z.number(),
    concessionApplies: z.boolean(),
  });
  api.route({
    method: 'get',
    path: '/fees/students/:id/invoice-preview',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'What an invoice for one student and month would contain, before creating it',
    description:
      'Uses the class fee structure and the same monthly/term/annual/one-time rules as class-wide generation, applies the standing concession, ' +
      'and reports an existing invoice for the month instead of allowing a duplicate.',
    params: idParams,
    query: z.object({ period: billingPeriod() }),
    response: z.object({
      student: z.object({
        _id: z.string(),
        name: z.string(),
        admissionNo: z.string(),
        status: z.string(),
        className: z.string().nullable(),
        sectionName: z.string().nullable(),
        sessionName: z.string().nullable(),
        concession: z.any().nullable(),
      }),
      period: z.string(),
      defaultDueDate: z.string(),
      existingInvoice: z
        .object({ _id: z.string(), invoiceNo: z.string(), status: z.string(), total: z.number(), balance: z.number() })
        .nullable(),
      structure: z.object({ _id: z.string(), name: z.string() }).nullable(),
      firstInvoice: z.boolean(),
      items: z.array(PreviewItem),
      totals: z.object({
        subtotal: z.number(),
        concession: z.number(),
        waiver: z.number(),
        lateFee: z.number(),
        total: z.number(),
      }),
      perStudentHeads: z.array(z.object({ _id: z.string(), name: z.string(), frequency: z.string() })),
      problems: z.array(z.string()),
    }),
    handler: ({ ctx, params, query }) => studentInvoicePreview(ctx, params.id, query.period),
  });

  api.route({
    method: 'post',
    path: '/fees/students/:id/invoices',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Create the monthly invoice for one student (with optional per-student charges)',
    description:
      'Refused with 409 DUPLICATE (details.invoiceId) when the student already has an invoice for the month. ' +
      'Extra charges must be active per-student fee heads (for example transport). Other discounts go through a waiver request.',
    params: idParams,
    body: z.object({
      period: billingPeriod(),
      dueDate: isoDate().optional(),
      extraItems: z
        .array(z.object({ feeHeadId: objectId(), amount: amountPkr().min(1) }))
        .max(20)
        .optional(),
    }),
    response: InvoiceRes,
    status: 201,
    handler: ({ ctx, params, body }) => createStudentInvoice(ctx, params.id, body),
  });

  const GenerateInvoicesBody = z.object({
    period: billingPeriod(),
    sessionId: objectId().optional(),
    classId: objectId().optional(),
    sectionId: objectId().optional(),
    studentIds: z.array(objectId()).max(500).optional(),
    dueDate: isoDate().optional(),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/preview-generate',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Preview monthly invoice generation without creating invoices',
    body: GenerateInvoicesBody,
    response: z.any(),
    handler: ({ ctx, body }) => svc.previewInvoiceGeneration(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/generate',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Generate monthly invoices (challans) from fee structures',
    description:
      'Idempotent per student and billing period: students who already have a regular invoice for the period are skipped. ' +
      'Monthly heads are billed every month, annual heads in their billingMonths, one-time heads on the first invoice. Standing concessions are applied. ' +
      'Only active students of the current session are billed; the response says why the others were not (other session, no fee structure, nothing due). ' +
      'Without a current session: `SETUP_REQUIRED` (422) with `details.setup = "current_session"`.',
    body: GenerateInvoicesBody,
    response: z.object({
      period: z.string(),
      created: z.number(),
      skippedExisting: z.number(),
      skippedNoStructure: z.number(),
      session: z
        .object({ _id: objectId(), name: z.string() })
        .openapi({ description: 'The current session: only its students are billed' }),
      skippedOtherSession: z
        .number()
        .openapi({ description: 'Active students selected but in another session (not billed)' }),
      skippedNothingDue: z.number().openapi({ description: 'Students whose fee structure bills nothing this month' }),
      classesWithoutStructure: z
        .array(z.object({ classId: objectId(), name: z.string(), students: z.number() }))
        .openapi({ description: 'Classes skipped because they have no active fee structure in the current session' }),
      invoiceIds: z.array(objectId()),
    }),
    handler: ({ ctx, body }) => svc.generateInvoices(ctx, body),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Create an ad-hoc invoice (e.g. exam fee, trip, uniform)',
    description:
      'The charges must total more than Rs 0. Supply `idempotencyKey` to make retries safe: the same key returns the invoice already created instead of a second one.',
    body: z.object({
      studentId: objectId(),
      period: billingPeriod(),
      dueDate: isoDate(),
      items: z
        .array(
          z.object({ name: z.string().trim().min(1).max(80), amount: amountPkr(), feeHeadId: objectId().optional() }),
        )
        .min(1)
        .max(30),
      notes: z.string().max(500).optional(),
      idempotencyKey: z.string().trim().min(8).max(100).optional(),
    }),
    response: InvoiceRes,
    status: 201,
    handler: ({ ctx, body }) => svc.createAdhocInvoice(ctx, body),
  });

  api.route({
    method: 'get',
    path: '/fees/invoices',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'List invoices',
    description: 'Parents and students only see invoices of their own linked students.',
    query: paginationQuery.extend({
      period: billingPeriod().optional(),
      status: z.enum(INVOICE_STATUSES).optional(),
      studentId: objectId().optional(),
      classId: objectId().optional(),
      sectionId: objectId().optional(),
      overdue: queryBool(),
      q: z
        .string()
        .trim()
        .max(100)
        .optional()
        .openapi({ description: 'Search: challan number, student name or admission no, parent name or phone' }),
    }),
    response: InvoiceRes.extend({
      isOverdue: z.boolean().openapi({ description: 'Open, with a balance, and past its due date in school time' }),
    }),
    paginated: true,
    handler: ({ ctx, query }) => svc.listInvoices(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/fees/invoices/:id',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Invoice detail with payments and installment status',
    description:
      '`previousDues`: the student’s other unpaid invoices of this month or earlier, as printed on the challan (total payable = balance + previousDues.amount).',
    params: idParams,
    response: InvoiceRes.extend({
      isOverdue: z.boolean(),
      payments: z.array(z.any()),
      previousDues: z.object({
        amount: z.number(),
        invoices: z.array(z.object({ invoiceNo: z.string(), period: z.string(), balance: z.number() })),
      }),
    }),
    handler: async ({ ctx, params }) => {
      const inv = await svc.getInvoice(ctx, params.id);
      return { ...inv, previousDues: await previousDues(ctx, inv) };
    },
  });

  api.route({
    method: 'get',
    path: '/fees/invoices/:id/challan.pdf',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Download the fee challan PDF (copies per the school’s document settings)',
    description:
      'For an invoice split into installments the challan is for one installment: `installment` (1-based) picks it; by default the first one with an amount still due. ' +
      'It then shows the installment amount and due date as the amount payable, next to the invoice total, discount, net payable and remaining balance.',
    params: idParams,
    query: z.object({ installment: z.coerce.number().int().min(1).optional() }),
    produces: 'application/pdf',
    handler: async ({ ctx, params, query, res }) => {
      const data = await challanData(ctx, params.id, query.installment, { withPreviousDues: true });
      const pdf = await renderChallan(data, await loadBrand(ctx.schoolId));
      const inv = data;
      const installment = data.installment;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="challan-${inv.invoiceNo}${installment ? `-installment-${installment.no}` : ''}.pdf"`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'get',
    path: '/fees/challans.pdf',
    tags,
    auth: 'school',
    permission: 'fees:collect',
    summary: 'Print the challans of a month for a whole class, a section or the school (one PDF)',
    description:
      'One page per student, in section and roll-number order, each exactly as its own challan (with previous dues). ' +
      '`include=open` (default) leaves out fully paid challans. More than 800 at once: `TOO_MANY_CHALLANS` (choose a class or section). ' +
      'No matching challan: `NO_CHALLANS` (404).',
    query: z.object({
      period: billingPeriod(),
      classId: objectId().optional(),
      sectionId: objectId().optional(),
      include: z.enum(['open', 'all']).default('open'),
    }),
    produces: 'application/pdf',
    handler: async ({ ctx, query, res }) => {
      const { challans, label } = await bulkChallans(ctx, query);
      if (!challans.length)
        throw new AppError(
          404,
          'NO_CHALLANS',
          query.include === 'open'
            ? 'No unpaid challans for this month and selection. Generate the invoices first, or include paid ones.'
            : 'No challans for this month and selection. Generate the invoices first.',
        );
      const pdf = await renderChallans(challans, await loadBrand(ctx.schoolId));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="challans-${label}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'get',
    path: '/fees/invoices/:id/challan',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'The fee challan as data, for showing it on screen',
    description:
      'Exactly what GET /fees/invoices/{id}/challan.pdf prints (same figures), plus the school details and challan settings used for it.',
    params: idParams,
    query: z.object({ installment: z.coerce.number().int().min(1).optional() }),
    response: z.object({
      challan: z.any(),
      figures: z.object({
        original: z.number(),
        discount: z.number(),
        net: z.number(),
        payableNow: z.number(),
        remainingAfter: z.number(),
        previous: z.number().openapi({ description: 'Unpaid previous dues printed on the challan' }),
        totalPayable: z.number(),
        stamp: z.enum(['PAID', 'PARTLY PAID', 'UNPAID']),
      }),
      school: z.object({
        name: z.string(),
        address: z.string().nullable(),
        phone: z.string().nullable(),
        email: z.string().nullable(),
        hasLogo: z.boolean(),
      }),
      settings: z.object({
        instructions: z.string(),
        showBankDetails: z.boolean(),
        showItemBreakdown: z.boolean(),
        copyLabels: z.array(z.string()),
        signatureLabel: z.string(),
        primaryColor: z.string(),
      }),
    }),
    handler: async ({ ctx, params, query }) => {
      const data = await challanData(ctx, params.id, query.installment, { withPreviousDues: true });
      const brand = await loadBrand(ctx.schoolId);
      const set = brand.settings!;
      return {
        challan: data,
        figures: challanFigures(data),
        school: {
          name: brand.schoolName,
          address: brand.address ?? null,
          phone: brand.phone ?? null,
          email: brand.email ?? null,
          hasLogo: Boolean(brand.logo),
        },
        settings: {
          instructions: set.challan.instructions,
          showBankDetails: set.challan.showBankDetails,
          showItemBreakdown: set.challan.showItemBreakdown,
          copyLabels: set.challan.copyLabels.slice(0, set.challan.copies),
          signatureLabel: set.challan.signatureLabel,
          primaryColor: set.theme.primaryColor,
        },
      };
    },
  });

  const FamilyInvoice = z.object({
    invoiceId: z.string(),
    invoiceNo: z.string(),
    period: z.string(),
    dueDate: z.string(),
    total: z.number(),
    paid: z.number(),
    balance: z.number(),
    payableNow: z.number(),
    installment: z.object({ no: z.number(), count: z.number() }).nullable(),
  });
  const FamilyAccountRes = z
    .object({
      parent: z.object({ _id: z.string(), name: z.string(), phone: z.string() }),
      children: z.array(
        z.object({
          studentId: z.string(),
          name: z.string(),
          admissionNo: z.string(),
          className: z.string().nullable(),
          sectionName: z.string().nullable(),
          relation: z.string(),
          invoices: z.array(FamilyInvoice),
          payable: z.number(),
        }),
      ),
      total: z.number(),
    })
    .openapi('FamilyFeeAccount');

  api.route({
    method: 'get',
    path: '/fees/family/:parentId',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'A parent’s children with their open invoices and the amount payable now (for a family voucher)',
    description:
      'Only children in this school that you can see. Each invoice keeps its own number and balance; the family total is the sum of what each invoice’s own challan asks for (installments included).',
    params: z.object({ parentId: objectId() }),
    response: FamilyAccountRes,
    handler: async ({ ctx, params }) => {
      const fam = await familyAccount(ctx, params.parentId);
      return {
        ...fam,
        children: fam.children.map((c) => ({
          ...c,
          invoices: c.invoices.map((i) => ({
            invoiceId: i.invoiceId,
            invoiceNo: i.invoiceNo,
            period: i.period,
            dueDate: new Date(i.dueDate).toISOString().slice(0, 10),
            total: i.total,
            paid: i.paid,
            balance: i.balance,
            payableNow: i.payableNow,
            installment: i.installment ? { no: i.installment.no, count: i.installment.count } : null,
          })),
        })),
      };
    },
  });

  api.route({
    method: 'get',
    path: '/fees/family/:parentId/voucher.pdf',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Download one fee voucher for all (or some) of a parent’s children',
    description:
      '`studentIds` (comma-separated) limits the voucher to those children; children with nothing due are left out. ' +
      'Payments are still recorded against each child’s invoice.',
    params: z.object({ parentId: objectId() }),
    query: z.object({ studentIds: z.string().max(2000).optional() }),
    produces: 'application/pdf',
    handler: async ({ ctx, params, query, res }) => {
      const fam = await familyAccount(ctx, params.parentId);
      const wanted = query.studentIds
        ? new Set(
            query.studentIds
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean),
          )
        : null;
      const children = fam.children.filter((c) => c.invoices.length && (!wanted || wanted.has(c.studentId)));
      if (!children.length)
        throw badRequest('None of the chosen children has anything due', { field: 'studentIds' }, 'NOTHING_DUE');
      const school = await School.findById(ctx.schoolId).select('settings.fees.bankDetails').lean();
      const now = new Date();
      const reference = familyReference(fam.parent._id, now);
      const pdf = await renderFamilyVoucher(
        {
          reference,
          issueDate: now,
          parentName: fam.parent.name,
          parentPhone: fam.parent.phone,
          bankDetails: school?.settings?.fees?.bankDetails ?? undefined,
          children: children.map((c) => ({
            name: c.name,
            admissionNo: c.admissionNo,
            className: c.className,
            sectionName: c.sectionName,
            invoices: c.invoices,
          })),
        },
        await loadBrand(ctx.schoolId),
      );
      await audit(ctx, {
        action: 'fees.family_voucher',
        entityType: 'Parent',
        entityId: fam.parent._id,
        metadata: { reference, invoices: children.flatMap((c) => c.invoices.map((i) => i.invoiceNo)) },
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="family-voucher-${reference}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/:id/payments',
    tags,
    auth: 'school',
    permission: 'fees:collect',
    summary: 'Record a payment against an invoice',
    description:
      'Atomic: rejects overpayments (`OVERPAYMENT`, 422) and concurrent double-recording. Supply `idempotencyKey` to make client retries safe — ' +
      'a repeated key returns the original payment with `replayed: true`.',
    params: idParams,
    body: z.object({
      amount: amountPkr().min(1),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().trim().max(100).optional(),
      receivedAt: isoDateTime().optional(),
      idempotencyKey: z.string().trim().min(8).max(100).optional(),
      headAllocations: z
        .array(z.object({ line: z.string().max(20), amount: amountPkr().min(0) }))
        .max(40)
        .optional()
        .openapi({
          description:
            'Optional: which invoice lines this payment settles (line from the invoice breakdown). Must add up to the amount and fit what is outstanding on each line.',
        }),
    }),
    response: z.object({ payment: PaymentRes, invoice: InvoiceRes, replayed: z.boolean() }),
    status: 201,
    handler: ({ ctx, params, body }) => svc.recordPayment(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/:id/installments',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Split an invoice into installments',
    description:
      'Either give `count` + `firstDueDate` (+ `intervalDays`, default 30) for equal splits, or an explicit `plan` summing to the invoice total.',
    params: idParams,
    body: z.object({
      count: z.number().int().min(2).max(12).optional(),
      firstDueDate: isoDate().optional(),
      intervalDays: z.number().int().min(1).max(120).optional(),
      plan: z
        .array(z.object({ amount: amountPkr().min(1), dueDate: isoDate() }))
        .min(2)
        .max(12)
        .optional(),
    }),
    response: InvoiceRes,
    handler: ({ ctx, params, body }) => svc.setInstallments(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/:id/waiver-requests',
    tags,
    auth: 'school',
    permission: 'fees:discount',
    summary: 'Request a waiver on an invoice (requires approval)',
    description: 'Creates an approval request. The invoice is only changed when an approver approves it.',
    params: idParams,
    body: z.object({ amount: amountPkr().min(1), reason: z.string().trim().min(5).max(500) }),
    response: ApprovalRes,
    status: 202,
    handler: ({ ctx, params, body }) => svc.requestWaiver(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/fees/invoices/:id/cancel-requests',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Request cancellation of an unpaid invoice (requires approval)',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    response: ApprovalRes,
    status: 202,
    handler: ({ ctx, params, body }) => svc.requestCancel(ctx, params.id, body.reason),
  });

  api.route({
    method: 'post',
    path: '/fees/late-fees/apply',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Apply the configured late fee to overdue invoices (once per invoice)',
    response: z.object({ applied: z.number(), lateFeeAmount: z.number(), note: z.string().optional() }),
    handler: ({ ctx }) => svc.applyLateFees(ctx),
  });

  api.route({
    method: 'get',
    path: '/fees/payments',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'List payments (receipts)',
    query: paginationQuery.extend({
      from: isoDate().optional(),
      to: isoDate().optional(),
      studentId: objectId().optional(),
      method: z.enum(PAYMENT_METHODS).optional(),
      q: z.string().trim().max(100).optional().openapi({
        description: 'Search: receipt number, reference, student name or admission no, parent name or phone',
      }),
    }),
    response: PaymentRes,
    paginated: true,
    handler: ({ ctx, query }) => svc.listPayments(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/fees/payments/:id',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Get a payment, with the fees it paid for',
    params: idParams,
    response: PaymentRes.extend({ breakdown: PaymentBreakdown }),
    handler: async ({ ctx, params }) => {
      const p = await svc.getPayment(ctx, params.id);
      return { ...p, breakdown: await svc.paymentBreakdown(ctx, p as never) };
    },
  });

  api.route({
    method: 'get',
    path: '/fees/payments/:id/receipt.pdf',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: 'Download a payment receipt PDF',
    params: idParams,
    produces: 'application/pdf',
    handler: async ({ ctx, params, res }) => {
      const p: any = await svc.getPayment(ctx, params.id);
      const pdf = await renderReceipt(
        {
          receiptNo: p.receiptNo,
          receivedAt: p.receivedAt,
          studentName: `${p.studentId.firstName} ${p.studentId.lastName ?? ''}`.trim(),
          admissionNo: p.studentId.admissionNo,
          invoiceNo: p.invoiceId.invoiceNo,
          period: p.invoiceId.period,
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          balanceAfter: p.balanceAfter,
          receivedBy: p.receivedByName,
          status: p.status,
          breakdown: await svc.paymentBreakdown(ctx, p),
        },
        await loadBrand(ctx.schoolId),
      );
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="receipt-${p.receiptNo}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    },
  });

  api.route({
    method: 'post',
    path: '/fees/payments/:id/reversal-requests',
    tags,
    auth: 'school',
    permission: 'fees:collect',
    summary: 'Request reversal of a payment (requires approval)',
    params: idParams,
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    response: ApprovalRes,
    status: 202,
    handler: ({ ctx, params, body }) => svc.requestReversal(ctx, params.id, body.reason),
  });

  api.route({
    method: 'get',
    path: '/fees/outstanding',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Outstanding balances per student',
    query: z.object({
      classId: objectId().optional(),
      sectionId: objectId().optional(),
      minBalance: z.coerce.number().int().min(1).optional(),
      overdueOnly: queryBool(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    response: z.object({
      totals: z.object({ students: z.number(), balance: z.number(), overdueBalance: z.number() }),
      students: z.array(
        z.object({
          studentId: objectId(),
          name: z.string(),
          admissionNo: z.string(),
          balance: z.number(),
          overdueBalance: z.number(),
          invoices: z.number(),
          oldestDueDate: z.string(),
        }),
      ),
    }),
    handler: ({ ctx, query }) => svc.outstanding(ctx, query),
  });

  api.route({
    method: 'get',
    path: '/fees/students/:id/ledger',
    tags,
    auth: 'school',
    permission: 'fees:read',
    summary: "A student's fee ledger (invoices, payments, running balance)",
    description: 'Parents may only request ledgers of their own children (others return 404).',
    params: idParams,
    response: z.object({
      student: z.any(),
      summary: z.object({
        totalBilled: z.number(),
        totalPaid: z.number(),
        outstanding: z.number(),
        overdue: z.number(),
      }),
      ownFees: z.array(
        z.object({ feeHeadId: z.string(), name: z.string(), amount: z.number(), source: z.enum(['import', 'manual']) }),
      ),
      invoices: z.array(z.any()),
      payments: z.array(z.any()),
      entries: z.array(
        z.object({
          date: z.string(),
          type: z.enum(['invoice', 'payment']),
          ref: z.string(),
          label: z.string(),
          debit: z.number(),
          credit: z.number(),
          balance: z.number(),
        }),
      ),
    }),
    handler: ({ ctx, params }) => svc.studentLedger(ctx, params.id),
  });

  api.route({
    method: 'post',
    path: '/fees/students/:id/concession-requests',
    tags,
    auth: 'school',
    permission: 'fees:discount',
    summary: 'Request a standing fee concession for a student (requires approval)',
    params: idParams,
    body: z.object({
      type: z.enum(['percent', 'fixed', 'none']),
      value: z.number().min(0).max(1_000_000),
      reason: z.string().trim().min(5).max(500),
    }),
    response: ApprovalRes,
    status: 202,
    handler: ({ ctx, params, body }) => svc.requestConcession(ctx, params.id, body),
  });

  api.route({
    method: 'put',
    path: '/fees/students/:id/own-fee',
    tags,
    auth: 'school',
    permission: 'fees:manage',
    summary: 'Set, change or remove a student’s own monthly fee (instead of the class fee)',
    description:
      'amount = the monthly fee for this student; null = remove it (the class fee structure applies again). Only invoices generated from now on use it. Recorded in the audit log with the reason.',
    params: idParams,
    body: z.object({
      feeHeadId: objectId(),
      amount: z.number().int().min(0).max(1_000_000).nullable(),
      reason: z.string().trim().min(3).max(300),
    }),
    response: z.object({
      studentId: z.string(),
      feeHeadId: z.string(),
      from: z.number().nullable(),
      to: z.number().nullable(),
      appliesTo: z.string(),
    }),
    handler: ({ ctx, params, body }) => svc.setOwnFee(ctx, params.id, body),
  });

  api.route({
    method: 'post',
    path: '/fees/students/:id/payments',
    tags,
    auth: 'school',
    permission: 'fees:collect',
    summary: 'Record one payment for a student, settled oldest dues first',
    description:
      'For a voucher with previous dues: the amount is applied to the student’s open invoices oldest first (previous dues, then each month), one payment and receipt per invoice reached, all recorded together. ' +
      'Rejects more than the student owes (`OVERPAYMENT`, 422). A repeated `idempotencyKey` returns the payments already recorded with `replayed: true`.',
    params: idParams,
    body: z.object({
      amount: amountPkr().min(1),
      method: z.enum(PAYMENT_METHODS),
      reference: z.string().trim().max(100).optional(),
      receivedAt: isoDateTime().optional(),
      idempotencyKey: z.string().trim().min(8).max(90).optional(),
    }),
    response: z.object({ payments: z.array(PaymentRes), remaining: z.number(), replayed: z.boolean() }),
    status: 201,
    handler: ({ ctx, params, body }) => svc.recordStudentPayment(ctx, params.id, body),
  });
}
