import type { Api } from '../../utils/api';
import { z } from '../../utils/zod';
import { canExport, DATASET_KEYS, DATASETS, exportData } from './exports.service';

export function registerExportRoutes(api: Api) {
  const tags = ['Data export'];

  api.route({
    method: 'get',
    path: '/exports',
    tags,
    auth: 'school',
    permission: 'school:read',
    summary: 'What school data the signed-in user may download',
    response: z.array(
      z.object({ dataset: z.enum(DATASET_KEYS as [string, ...string[]]), label: z.string(), allowed: z.boolean() }),
    ),
    handler: ({ ctx }) =>
      DATASET_KEYS.map((d) => ({ dataset: d, label: DATASETS[d].label, allowed: canExport(ctx, d) })),
  });

  api.route({
    method: 'get',
    path: '/exports/:dataset',
    tags,
    auth: 'school',
    permission: 'school:read',
    summary: 'Download school data as Excel (or CSV for one table)',
    description:
      'Students, parents and staff use the import template columns, so the file can be edited and imported again. ' +
      '`all` = every dataset the user may download, one sheet each (Excel only). Each dataset needs its own permission; downloads are audited.',
    params: z.object({ dataset: z.enum(['all', ...DATASET_KEYS] as [string, ...string[]]) }),
    query: z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }),
    produces: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    handler: async ({ ctx, params, query, res }) => {
      const file = await exportData(ctx, params.dataset as never, query.format);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(file.body);
    },
  });
}
