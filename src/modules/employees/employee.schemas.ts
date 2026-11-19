import { amountPkr, email, isoDate, objectId, phonePk, z } from '../../utils/zod';
import { SETTABLE_EMPLOYEE_STATUSES } from './employee.model';

/** Staff record fields, shared by the staff routes and the staff import. */
export const EmployeeBody = z.object({
  campusId: objectId(),
  employeeNo: z.string().trim().max(20).optional().openapi({ description: 'Auto-generated (EMP-0001) when omitted' }),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  cnic: z
    .string()
    .trim()
    .regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC must be 13 digits (xxxxx-xxxxxxx-x)')
    .optional(),
  phone: phonePk().optional(),
  email: email().optional(),
  address: z.string().trim().max(300).optional(),
  designation: z.string().trim().min(2).max(60),
  department: z.string().trim().max(60).optional(),
  staffType: z.enum(['teaching', 'non_teaching']),
  qualification: z.string().trim().max(120).optional(),
  joiningDate: isoDate().optional(),
  salary: z
    .object({ basic: amountPkr(), allowances: amountPkr().optional(), deductions: amountPkr().optional() })
    .optional(),
  bankAccount: z.string().trim().max(40).optional(),
  status: z.enum(SETTABLE_EMPLOYEE_STATUSES).optional(),
});

export const CreateEmployeeBody = EmployeeBody.extend({
  login: z
    .object({
      create: z.boolean(),
      role: z.enum(['teacher', 'principal', 'school_admin', 'accountant', 'staff']).optional(),
      customRoleId: objectId().optional(),
    })
    .optional()
    .openapi({ description: 'Defaults: create for teaching staff, skip for non-teaching staff' }),
});

export type CreateEmployeeInput = z.infer<typeof CreateEmployeeBody>;
