import type { SchoolContext } from '../../../types/context';
import { timeToMinutes } from '../../../utils/dates';
import { conflict } from '../../../utils/errors';
import { oid, scope } from '../../../utils/tenant';
import { Subject } from '../../academics/academics.models';
import { audit } from '../../audit/audit.service';
import { Employee } from '../../employees/employee.model';
import { WEEKDAY_NAMES, workingDays } from '../../schools/school-days';
import { findConflicts, type Slot } from '../../timetable/conflicts';
import { dayLabel, parseDays, parseTime } from '../../timetable/import-parse';
import { TimetableEntry } from '../../timetable/timetable.model';
import { fieldLabel } from '../import-fields';
import { nameKey, parseText, personNameKey, type Parsed } from '../import-values';
import { SchoolRefs } from './school-refs';
import { RowReader, breathe, type Change, type Processor, type RowPlan } from './types';

type PeriodAction = 'create' | 'update' | 'same' | 'skip';
interface PeriodPlan {
  dayOfWeek: number;
  action: PeriodAction;
  /** The period already saved for this class, day and time. */
  existingId?: string;
}
interface Payload {
  sessionId: string;
  campusId: string;
  sectionId: string;
  subjectId: string;
  /** Only when the Teacher cell named a teacher who was found. */
  teacherId?: string;
  room?: string;
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
  periods: PeriodPlan[];
}

const label = (f: string) => fieldLabel('timetable', f);
const dayName = (d: number) => WEEKDAY_NAMES[d - 1];
const timeRange = (a: string, b: string) => `${a}–${b}`;

/** Adapts the shared time reader to the importer's cell parser; "1:30" without AM/PM becomes a note. */
const timeCell = (v: string): Parsed<string> => {
  const t = parseTime(v);
  if (!t.ok) return { ok: false, error: t.error };
  return { ok: true, value: t.value, ...(t.assumedPm ? { note: `"${v}" is read as ${t.value} (afternoon)` } : {}) };
};

interface ExistingEntry {
  id: string;
  sectionId: string;
  subjectId: string;
  teacherId?: string;
  room?: string;
  startTime: string;
  endTime: string;
  slot: Slot;
}

const sample = (values: string[], n = 10) =>
  [...new Set(values)].slice(0, n).join(', ') + (new Set(values).size > n ? ', …' : '');

/**
 * Timetable periods: one row = one class + one period. The Day cell may name several days
 * (Mon-Fri, Mon,Wed, All), so a week of the same period is a single row and saves one period
 * per day. A period already saved for the same class, day and time is skipped (or, when the
 * import is set to update, its subject / teacher / room are changed). Periods are never deleted
 * by an import. The clash rules are the ones of the Add period form: a class, a teacher or a
 * room cannot be in two places at the same time.
 */
export const timetableProcessor: Processor<Payload> = {
  async plan(ctx, rows, options) {
    const [refs, working, subjectDocs, employeeDocs] = await Promise.all([
      SchoolRefs.load(ctx),
      workingDays(ctx.schoolId),
      Subject.find(scope(ctx)).select('name code').lean(),
      Employee.find(scope(ctx)).select('firstName lastName').lean(),
    ]);
    const warnings = refs.defaultsProblems(
      options,
      rows.some((r) => r.cells.campusName),
    );

    // ── Lookups ───────────────────────────────────────────────────────────────
    const subjects = new Map<string, { id: string; name: string }>();
    for (const s of subjectDocs as any[]) {
      const ref = { id: String(s._id), name: String(s.name) };
      subjects.set(nameKey(String(s.name)), ref);
      if (s.code) subjects.set(nameKey(String(s.code)), ref);
    }
    const subjectName = new Map([...subjects.values()].map((s) => [s.id, s.name]));
    const teacherExact = new Map<string, string[]>();
    const teacherLoose = new Map<string, string[]>();
    const teacherName = new Map<string, string>();
    for (const e of employeeDocs as any[]) {
      const full = `${e.firstName ?? ''} ${e.lastName ?? ''}`.trim();
      const id = String(e._id);
      teacherName.set(id, full);
      teacherExact.set(nameKey(full), [...(teacherExact.get(nameKey(full)) ?? []), id]);
      teacherLoose.set(personNameKey(full), [...(teacherLoose.get(personNameKey(full)) ?? []), id]);
    }

    // ── What is already saved (sessions this file touches) ────────────────────
    const sessionIds = new Set<string>();
    if (options.sessionId ?? refs.currentSessionId) sessionIds.add((options.sessionId ?? refs.currentSessionId)!);
    for (const row of rows) {
      const n = (row.cells.sessionName ?? '').trim();
      const s = n ? refs.sessions.find((x) => nameKey(x.name) === nameKey(n)) : undefined;
      if (s) sessionIds.add(s.id);
    }
    const saved = sessionIds.size
      ? await TimetableEntry.find(scope(ctx, { sessionId: { $in: [...sessionIds].map(oid) } })).lean()
      : [];
    const existingByDay = new Map<number, ExistingEntry[]>();
    const existingBySlot = new Map<string, ExistingEntry>();
    const existingById = new Map<string, ExistingEntry>();
    for (const e of saved as any[]) {
      const entry: ExistingEntry = {
        id: String(e._id),
        sectionId: String(e.sectionId),
        subjectId: String(e.subjectId),
        teacherId: e.teacherId ? String(e.teacherId) : undefined,
        room: e.room ?? undefined,
        startTime: e.startTime,
        endTime: e.endTime,
        slot: {
          id: String(e._id),
          sectionId: String(e.sectionId),
          teacherId: e.teacherId ? String(e.teacherId) : null,
          campusId: String(e.campusId),
          room: e.room ?? null,
          dayOfWeek: e.dayOfWeek,
          startMinutes: e.startMinutes,
          endMinutes: e.endMinutes,
        },
      };
      existingById.set(entry.id, entry);
      existingBySlot.set(`${entry.sectionId}|${e.dayOfWeek}|${e.startTime}|${e.endTime}`, entry);
      existingByDay.set(e.dayOfWeek, [...(existingByDay.get(e.dayOfWeek) ?? []), entry]);
    }
    /** Periods an earlier row of this file will save (checked so two rows cannot clash). */
    const plannedByDay = new Map<number, Array<{ slot: Slot; row: number }>>();
    const plannedKey = new Map<string, number>();
    const replaced = new Set<string>();
    let periodsTotal = 0;

    const describe = (id: string | undefined, planned?: { row: number }) => {
      if (planned) return `row ${planned.row} of this file`;
      const e = id ? existingById.get(id) : undefined;
      if (!e) return 'a saved period';
      return `saved: ${subjectName.get(e.subjectId) ?? 'period'} ${timeRange(e.startTime, e.endTime)}`;
    };

    const out: RowPlan<Payload>[] = [];
    for (const [i, row] of rows.entries()) {
      await breathe(i);
      const r = new RowReader(row, label);
      const className = r.req('className', (v) => parseText(v, 40));
      const sectionText = r.opt('sectionName', (v) => parseText(v, 20));
      const campus = refs.campus(r, 'campusName', options);
      if (!campus && !r.has('campusName')) r.error(undefined, 'Choose the campus for this import');
      const session = refs.session(r, 'sessionName', options);

      // Class + section
      let section: ReturnType<SchoolRefs['sectionsOf']>[number] | undefined;
      let classLabel = className ?? '';
      if (className && campus && session) {
        const cls = refs.findClass(campus.id, className);
        if (!cls) r.error('className', `"${className}" is not a class of ${campus.name} (classes: ${sample(refs.classNamesIn(campus.id))})`);
        else {
          classLabel = cls.name;
          const secs = refs.sectionsOf(cls.id, session.id);
          if (sectionText) {
            section = secs.find((s) => nameKey(s.name) === nameKey(sectionText));
            if (!section)
              r.error('sectionName', `${cls.name} has no section "${sectionText}" in ${session.name}${secs.length ? ` (sections: ${secs.map((s) => s.name).join(', ')})` : ''}`);
          } else if (secs.length === 1) section = secs[0];
          else if (!secs.length) r.error('sectionName', `${cls.name} has no sections in ${session.name}. Import classes and sections first`);
          else r.error('sectionName', `${cls.name} has several sections (${secs.map((s) => s.name).join(', ')}): write which one`);
        }
      }

      // Days
      let days: number[] = [];
      if (!r.has('day')) r.error('day', 'Day is required');
      else {
        const dp = parseDays(r.raw('day'), working);
        if (dp.error) r.error('day', dp.error);
        else {
          const off = dp.days.filter((d) => !working.includes(d));
          days = dp.days.filter((d) => working.includes(d));
          const names = off.map(dayName).join(', ');
          if (off.length && days.length) r.warn('day', `${names} ${off.length > 1 ? 'are off days' : 'is an off day'} for your school and ${off.length > 1 ? 'are' : 'is'} skipped`);
          if (!days.length) r.error('day', `${names} ${off.length > 1 ? 'are off days' : 'is an off day'} for your school (Settings → School days)`);
        }
      }

      // Times
      const startTime = r.req('startTime', timeCell);
      const endTime = r.req('endTime', timeCell);
      if (startTime && endTime && timeToMinutes(startTime) >= timeToMinutes(endTime))
        r.error('endTime', 'must be after Starts');

      // Subject
      let subject: { id: string; name: string } | undefined;
      const subjectText = r.req('subjectName', (v) => parseText(v, 120));
      if (subjectText) {
        subject = subjects.get(nameKey(subjectText));
        if (!subject)
          r.error('subjectName', `"${subjectText}" is not a subject of this school. Create it under Subjects first (subjects: ${sample([...subjects.values()].map((s) => s.name))})`);
      }

      // Teacher: optional, and a teacher who cannot be found only gives a warning
      let teacherId: string | undefined;
      const teacherText = r.opt('teacherName', (v) => parseText(v, 120));
      if (teacherText) {
        const found = teacherExact.get(nameKey(teacherText)) ?? teacherLoose.get(personNameKey(teacherText)) ?? [];
        if (found.length === 1) teacherId = found[0];
        else
          r.warn(
            'teacherName',
            found.length > 1
              ? `"${teacherText}" matches ${found.length} employees; the period is saved without a teacher`
              : `"${teacherText}" is not in Employees; the period is saved without a teacher`,
          );
      }
      const room = r.opt('room', (v) => parseText(v, 30));

      const plan: RowPlan<Payload> = {
        rowNo: row.rowNo,
        check: 'create',
        issues: r.issues,
        changes: [],
        key: `${classLabel} ${section?.name ?? ''} ${days.length ? dayLabel(days) : ''} ${startTime ?? ''}`.replace(/\s+/g, ' ').trim(),
      };
      if (r.failed || !section || !session || !campus || !subject || !startTime || !endTime || !days.length) {
        out.push({ ...plan, check: 'invalid' });
        continue;
      }
      const start = timeToMinutes(startTime);
      const end = timeToMinutes(endTime);
      const where = `${classLabel} ${section.name}`.trim();

      // ── Each day of the row ─────────────────────────────────────────────────
      const periods: PeriodPlan[] = [];
      const changes: Change[] = [];
      const clashes = new Map<string, number[]>();
      const notes: string[] = [];
      let duplicateOf: number | undefined;
      for (const d of days) {
        const ex = existingBySlot.get(`${section.id}|${d}|${startTime}|${endTime}`);
        if (ex) {
          const same =
            ex.subjectId === subject.id && (!teacherId || ex.teacherId === teacherId) && (!room || ex.room === room);
          if (same) periods.push({ dayOfWeek: d, action: 'same', existingId: ex.id });
          else if (options.mode === 'upsert') {
            periods.push({ dayOfWeek: d, action: 'update', existingId: ex.id });
            if (ex.subjectId !== subject.id)
              changes.push({ field: `${dayName(d)} subject`, from: subjectName.get(ex.subjectId) ?? '—', to: subject.name });
            if (teacherId && ex.teacherId !== teacherId)
              changes.push({ field: `${dayName(d)} teacher`, from: teacherName.get(ex.teacherId ?? '') ?? '—', to: teacherName.get(teacherId) ?? '—' });
            if (room && ex.room !== room) changes.push({ field: `${dayName(d)} room`, from: ex.room ?? '—', to: room });
          } else {
            periods.push({ dayOfWeek: d, action: 'skip', existingId: ex.id });
            notes.push(`${dayName(d)}: ${where} already has ${subjectName.get(ex.subjectId) ?? 'a period'} at ${timeRange(startTime, endTime)}; skipped (choose “update existing ones” to change it)`);
          }
          if (periods[periods.length - 1].action !== 'update') continue;
        } else {
          const dupRow = plannedKey.get(`${section.id}|${d}|${startTime}|${endTime}`);
          if (dupRow) {
            duplicateOf = dupRow;
            continue;
          }
          periods.push({ dayOfWeek: d, action: 'create' });
        }
        // New or changed period: the class, teacher and room must be free then.
        const candidate: Slot = {
          id: 'candidate',
          sectionId: section.id,
          teacherId: teacherId ?? (ex ? (ex.teacherId ?? null) : null),
          campusId: section.campusId,
          room: room ?? (ex ? (ex.room ?? null) : null),
          dayOfWeek: d,
          startMinutes: start,
          endMinutes: end,
        };
        const others: Slot[] = [
          ...(existingByDay.get(d) ?? []).filter((e) => !replaced.has(e.id) && e.id !== ex?.id).map((e) => e.slot),
          ...(plannedByDay.get(d) ?? []).map((p) => p.slot),
        ];
        for (const c of findConflicts(candidate, others)) {
          const planned = (plannedByDay.get(d) ?? []).find((p) => p.slot.id === c.withEntryId);
          const msg = `${c.message} (${describe(c.withEntryId, planned)})`;
          clashes.set(msg, [...(clashes.get(msg) ?? []), d]);
        }
      }

      if (duplicateOf && !periods.length) {
        plan.issues.push({ level: 'error', message: `${where} ${timeRange(startTime, endTime)} on these days also appears on row ${duplicateOf}` });
        out.push({ ...plan, check: 'duplicate' });
        continue;
      }
      if (duplicateOf)
        plan.issues.push({ level: 'warning', message: `Some days of this row also appear on row ${duplicateOf} and are not added twice` });
      if (clashes.size) {
        for (const [msg, ds] of clashes) plan.issues.push({ level: 'error', message: `${dayLabel(ds)}: ${msg}` });
        out.push({ ...plan, check: 'invalid' });
        continue;
      }

      const toWrite = periods.filter((p) => p.action === 'create' || p.action === 'update');
      for (const note of notes) plan.issues.push({ level: 'info', message: note });
      const created = periods.filter((p) => p.action === 'create').map((p) => p.dayOfWeek);
      const updated = periods.filter((p) => p.action === 'update').map((p) => p.dayOfWeek);
      if (created.length)
        plan.issues.push({ level: 'info', message: `${created.length} period${created.length === 1 ? '' : 's'} will be added: ${where}, ${dayLabel(created)} ${timeRange(startTime, endTime)} ${subject.name}` });
      if (updated.length)
        plan.issues.push({ level: 'info', message: `${updated.length} existing period${updated.length === 1 ? '' : 's'} will be updated (${dayLabel(updated)})` });
      if (!toWrite.length) {
        const sameOnly = periods.every((p) => p.action === 'same');
        if (!notes.length) plan.issues.push({ level: 'info', message: `${where} already has this period${periods.length === 1 ? '' : 's'}; nothing to do` });
        out.push({ ...plan, check: options.mode === 'upsert' && sameOnly ? 'unchanged' : 'exists' });
        continue;
      }

      // Reserve the slots for later rows of the file.
      for (const p of toWrite) {
        const slot: Slot = {
          id: `row${row.rowNo}-${p.dayOfWeek}`,
          sectionId: section.id,
          teacherId: teacherId ?? (p.existingId ? (existingById.get(p.existingId)?.teacherId ?? null) : null),
          campusId: section.campusId,
          room: room ?? (p.existingId ? (existingById.get(p.existingId)?.room ?? null) : null),
          dayOfWeek: p.dayOfWeek,
          startMinutes: start,
          endMinutes: end,
        };
        plannedByDay.set(p.dayOfWeek, [...(plannedByDay.get(p.dayOfWeek) ?? []), { slot, row: row.rowNo }]);
        plannedKey.set(`${section.id}|${p.dayOfWeek}|${startTime}|${endTime}`, row.rowNo);
        if (p.existingId) replaced.add(p.existingId);
      }
      periodsTotal += toWrite.length;
      out.push({
        ...plan,
        check: updated.length ? 'update' : 'create',
        changes,
        payload: {
          sessionId: session.id,
          campusId: section.campusId,
          sectionId: section.id,
          subjectId: subject.id,
          ...(teacherId ? { teacherId } : {}),
          ...(room ? { room } : {}),
          startTime,
          endTime,
          startMinutes: start,
          endMinutes: end,
          periods,
        },
      });
    }
    return { rows: out, warnings, summary: { periods: periodsTotal } };
  },

  async apply(ctx, plan) {
    const p = plan.payload!;
    const ids: string[] = [];
    let added = 0;
    let changed = 0;
    for (const per of p.periods) {
      if (per.action !== 'create' && per.action !== 'update') continue;
      await assertFree(ctx, p, per);
      if (per.action === 'create') {
        const doc = await TimetableEntry.create({
          schoolId: oid(ctx.schoolId),
          sessionId: oid(p.sessionId),
          campusId: oid(p.campusId),
          sectionId: oid(p.sectionId),
          subjectId: oid(p.subjectId),
          ...(p.teacherId ? { teacherId: oid(p.teacherId) } : {}),
          dayOfWeek: per.dayOfWeek,
          startTime: p.startTime,
          endTime: p.endTime,
          startMinutes: p.startMinutes,
          endMinutes: p.endMinutes,
          ...(p.room ? { room: p.room } : {}),
        });
        await audit(ctx, { action: 'timetable.create', entityType: 'TimetableEntry', entityId: doc._id, metadata: { source: 'import' } });
        ids.push(String(doc._id));
        added++;
      } else {
        await TimetableEntry.updateOne(scope(ctx, { _id: oid(per.existingId!) }), {
          $set: { subjectId: oid(p.subjectId), ...(p.teacherId ? { teacherId: oid(p.teacherId) } : {}), ...(p.room ? { room: p.room } : {}) },
        });
        await audit(ctx, { action: 'timetable.update', entityType: 'TimetableEntry', entityId: oid(per.existingId!), metadata: { source: 'import' } });
        ids.push(per.existingId!);
        changed++;
      }
    }
    const text = [added ? `${added} period${added === 1 ? '' : 's'} added` : '', changed ? `${changed} updated` : ''].filter(Boolean).join(', ');
    return { result: added ? 'created' : 'updated', entityId: ids[0], message: text || 'Nothing to change' };
  },
};

/** Last check just before saving: the schedule may have changed since the rows were checked. */
async function assertFree(ctx: SchoolContext, p: Payload, per: PeriodPlan) {
  const others = await TimetableEntry.find(
    scope(ctx, {
      sessionId: oid(p.sessionId),
      dayOfWeek: per.dayOfWeek,
      startMinutes: { $lt: p.endMinutes },
      endMinutes: { $gt: p.startMinutes },
      ...(per.existingId ? { _id: { $ne: oid(per.existingId) } } : {}),
    }),
  ).lean();
  const candidate: Slot = {
    sectionId: p.sectionId,
    teacherId: p.teacherId ?? null,
    campusId: p.campusId,
    room: p.room ?? null,
    dayOfWeek: per.dayOfWeek,
    startMinutes: p.startMinutes,
    endMinutes: p.endMinutes,
  };
  const clashes = findConflicts(
    candidate,
    (others as any[]).map((e) => ({
      id: String(e._id),
      sectionId: String(e.sectionId),
      teacherId: e.teacherId ? String(e.teacherId) : null,
      campusId: String(e.campusId),
      room: e.room ?? null,
      dayOfWeek: e.dayOfWeek,
      startMinutes: e.startMinutes,
      endMinutes: e.endMinutes,
    })),
  );
  if (clashes.length)
    throw conflict(`${dayName(per.dayOfWeek)}: ${clashes[0].message}. The timetable changed while the import was running`);
}
