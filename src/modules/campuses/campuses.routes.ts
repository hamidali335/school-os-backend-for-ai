import type { Api } from '../../utils/api';
import { crudRoutes, refuseIfReferenced } from '../../utils/crud';
import { conflict } from '../../utils/errors';
import { scope } from '../../utils/tenant';
import { docBase, phonePk, z } from '../../utils/zod';
import { SchoolClass } from '../academics/academics.models';
import { Employee } from '../employees/employee.model';
import { Student } from '../students/student.models';
import { getSchoolLimits, planLimitError } from '../subscriptions/limits.service';
import { Campus } from './campus.model';

const CampusRes = z
  .object({
    ...docBase,
    name: z.string(),
    code: z.string(),
    address: z.string().optional(),
    city: z.string().optional(),
    phone: z.string().optional(),
    isMain: z.boolean(),
    status: z.enum(['active', 'inactive']),
  })
  .openapi('Campus');

export function registerCampusRoutes(api: Api) {
  crudRoutes(api, {
    path: '/campuses',
    tag: 'Campuses',
    label: 'campus',
    model: Campus,
    read: 'campuses:read',
    write: 'campuses:manage',
    createSchema: z.object({
      name: z.string().trim().min(2).max(100),
      code: z.string().trim().min(1).max(12).openapi({ example: 'MAIN' }),
      address: z.string().trim().max(300).optional(),
      city: z.string().trim().max(60).optional(),
      phone: phonePk().optional(),
      status: z.enum(['active', 'inactive']).optional(),
    }),
    response: CampusRes,
    sort: { isMain: -1, name: 1 },
    searchFields: ['name', 'code', 'city'],
    prepare: async (ctx, body, existing) => {
      if (!existing) {
        const [limits, count] = await Promise.all([getSchoolLimits(ctx.schoolId), Campus.countDocuments(scope(ctx))]);
        if (count >= limits.maxCampuses) throw planLimitError('campuses', limits.maxCampuses);
      }
      return body;
    },
    beforeDelete: async (ctx, doc) => {
      if (doc.isMain) throw conflict('The main campus cannot be deleted');
      await refuseIfReferenced([
        [SchoolClass, 'campusId', 'classes'],
        [Student, 'campusId', 'students'],
        [Employee, 'campusId', 'employees'],
      ])(ctx, doc);
    },
  });
}
