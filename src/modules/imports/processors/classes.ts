import { oid, scope } from '../../../utils/tenant';
import { SchoolClass, Section } from '../../academics/academics.models';
import { audit } from '../../audit/audit.service';
import { fieldLabel } from '../import-fields';
import { levelFromClassName, nameKey, parseInteger, parseText } from '../import-values';
import { SchoolRefs } from './school-refs';
import { RowReader, type Processor, type RowPlan, breathe } from './types';

interface Payload {
  campusId: string;
  sessionId: string;
  className: string;
  level: number;
  /** Set when the class already exists. */
  classId?: string;
  sectionName: string;
  capacity?: number;
  room?: string;
}

const label = (f: string) => fieldLabel('classes', f);

/**
 * Classes and sections: one row per section. A class is created the first time it appears (and
 * reused after that); a section that already exists for the class and session is skipped.
 * Existing classes and sections are never changed.
 */
export const classesProcessor: Processor<Payload> = {
  async plan(ctx, rows, options) {
    const refs = await SchoolRefs.load(ctx);
    const warnings = refs.defaultsProblems(
      options,
      rows.some((r) => r.cells.campusName),
    );
    if (options.mode === 'upsert')
      warnings.push('Existing classes and sections are skipped: imports never change them.');
    const seen = new Map<string, number>();
    const plannedLevels = new Map<string, number>();
    const out: RowPlan<Payload>[] = [];
    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      const className = r.req('className', (v) => parseText(v, 40));
      const sectionName = r.req('sectionName', (v) => parseText(v, 20));
      const capacity = r.opt('capacity', (v) => parseInteger(v, 1, 200, 'Capacity'));
      const room = r.opt('room', (v) => parseText(v, 40));
      const campus = refs.campus(r, 'campusName', options);
      if (!campus && !r.has('campusName')) r.error(undefined, 'Choose the campus for this import');
      const session = refs.session(r, 'sessionName', options);
      let level = r.opt('level', (v) => parseInteger(v, -3, 20, 'Level'));
      const plan: RowPlan<Payload> = {
        rowNo: row.rowNo,
        check: 'create',
        issues: r.issues,
        changes: [],
        key: `${className} ${sectionName}`,
      };
      if (r.failed || !className || !sectionName || !campus || !session) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const key = `${campus.id}|${session.id}|${nameKey(className)}|${nameKey(sectionName)}`;
      const first = seen.get(key);
      if (first) {
        plan.issues.push({ level: 'error', message: `${className} ${sectionName} also appears on row ${first}` });
        out.push({ ...plan, check: 'duplicate' });
        continue;
      }
      seen.set(key, row.rowNo);
      const cls = refs.findClass(campus.id, className);
      const classKey = `${campus.id}|${nameKey(className)}`;
      if (cls) {
        if (level !== undefined && level !== cls.level)
          plan.issues.push({
            level: 'info',
            field: 'level',
            message: `${label('level')}: the class already exists with level ${cls.level}; it is not changed`,
          });
        level = cls.level;
        const section = refs.sectionsOf(cls.id, session.id).find((s) => nameKey(s.name) === nameKey(sectionName));
        if (section) {
          plan.issues.push({
            level: 'info',
            message: `${cls.name} ${section.name} already exists in ${session.name}; skipped`,
          });
          out.push({ ...plan, check: 'exists', existingId: section.id });
          continue;
        }
      } else {
        level ??= plannedLevels.get(classKey) ?? levelFromClassName(className) ?? undefined;
        if (level === undefined) {
          plan.issues.push({
            level: 'error',
            field: 'level',
            message: `${label('level')}: needed for the new class "${className}" (e.g. 5 for Class 5, -2 Playgroup, -1 Nursery, 0 Prep)`,
          });
          out.push({ ...plan, check: 'invalid' });
          continue;
        }
        if (!plannedLevels.has(classKey)) {
          plannedLevels.set(classKey, level);
          plan.issues.push({ level: 'info', message: `New class "${className}" (level ${level}) will be created` });
        }
      }
      out.push({
        ...plan,
        payload: {
          campusId: campus.id,
          sessionId: session.id,
          className,
          level,
          classId: cls?.id,
          sectionName,
          capacity,
          room,
        },
      });
    }
    return { rows: out, warnings };
  },

  async apply(ctx, plan) {
    const p = plan.payload!;
    let classId = p.classId;
    let createdClass = false;
    if (!classId) {
      // Created by an earlier row of this import (or concurrently): reuse it.
      const all = await SchoolClass.find(scope(ctx, { campusId: oid(p.campusId) }))
        .select('name')
        .lean();
      const found = all.find((c) => nameKey(c.name) === nameKey(p.className));
      if (found) classId = String(found._id);
      else {
        const doc = await SchoolClass.create({
          schoolId: ctx.schoolId,
          campusId: p.campusId,
          name: p.className,
          level: p.level,
        });
        await audit(ctx, {
          action: 'schoolclass.create',
          entityType: 'SchoolClass',
          entityId: doc._id,
          metadata: { source: 'import' },
        });
        classId = String(doc._id);
        createdClass = true;
      }
    }
    const existing = await Section.find(scope(ctx, { classId: oid(classId), sessionId: oid(p.sessionId) }))
      .select('name')
      .lean();
    const dup = existing.find((s) => nameKey(s.name) === nameKey(p.sectionName));
    if (dup) return { result: 'skipped', entityId: String(dup._id), message: 'Section already exists' };
    const section = await Section.create({
      schoolId: ctx.schoolId,
      campusId: p.campusId,
      classId,
      sessionId: p.sessionId,
      name: p.sectionName,
      ...(p.capacity ? { capacity: p.capacity } : {}),
      ...(p.room ? { room: p.room } : {}),
    });
    await audit(ctx, {
      action: 'section.create',
      entityType: 'Section',
      entityId: section._id,
      metadata: { source: 'import' },
    });
    return {
      result: 'created',
      entityId: String(section._id),
      message: createdClass ? `Class ${p.className} and section ${p.sectionName}` : `Section ${p.sectionName}`,
    };
  },
};
