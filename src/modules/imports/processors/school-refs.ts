import type { SchoolContext } from '../../../types/context';
import { scope } from '../../../utils/tenant';
import { AcademicSession, SchoolClass, Section } from '../../academics/academics.models';
import { Campus } from '../../campuses/campus.model';
import { School } from '../../schools/school.model';
import { nameKey } from '../import-values';
import type { ImportOptions, RowReader } from './types';

type Ref = { id: string; name: string };
type ClassRef = Ref & { campusId: string; level: number };
type SectionRef = Ref & { classId: string; sessionId: string; campusId: string; capacity?: number | null };

/**
 * The school's campuses, sessions, classes and sections, loaded once per import and matched by
 * name (case, spaces and punctuation ignored). Only campuses the user may work in are visible.
 */
export class SchoolRefs {
  constructor(
    public campuses: Ref[],
    public sessions: Ref[],
    public classes: ClassRef[],
    public sections: SectionRef[],
    public currentSessionId: string | null,
  ) {}

  static async load(ctx: SchoolContext) {
    const [campuses, sessions, classes, sections, school] = await Promise.all([
      Campus.find(scope(ctx)).select('name').lean(),
      AcademicSession.find(scope(ctx)).select('name').lean(),
      SchoolClass.find(scope(ctx)).select('name campusId level').lean(),
      Section.find(scope(ctx)).select('name classId sessionId campusId capacity').lean(),
      School.findById(ctx.schoolId).select('settings.currentSessionId').lean(),
    ]);
    const allowed = (campusId: string) => !ctx.campusIds.length || ctx.campusIds.includes(campusId);
    return new SchoolRefs(
      campuses.filter((c) => allowed(String(c._id))).map((c) => ({ id: String(c._id), name: c.name })),
      sessions.map((s) => ({ id: String(s._id), name: s.name })),
      classes
        .filter((c) => allowed(String(c.campusId)))
        .map((c) => ({ id: String(c._id), name: c.name, campusId: String(c.campusId), level: c.level })),
      sections
        .filter((s) => allowed(String(s.campusId)))
        .map((s) => ({
          id: String(s._id),
          name: s.name,
          classId: String(s.classId),
          sessionId: String(s.sessionId),
          campusId: String(s.campusId),
          capacity: s.capacity,
        })),
      school?.settings?.currentSessionId ? String(school.settings.currentSessionId) : null,
    );
  }

  /** Job-level problems with the chosen defaults (shown before any row is checked). */
  defaultsProblems(options: ImportOptions, hasCampusColumn: boolean): string[] {
    const out: string[] = [];
    if (!this.campuses.length)
      out.push('You have no campus to import into. Create a campus first (Settings → Campuses).');
    if (options.campusId && !this.campuses.some((c) => c.id === options.campusId))
      out.push('The chosen campus is not one you can import into.');
    if (!options.campusId && !hasCampusColumn && this.campuses.length > 1)
      out.push('Your school has several campuses: choose the campus for these rows, or map a Campus column.');
    if (options.sessionId && !this.sessions.some((s) => s.id === options.sessionId))
      out.push('The chosen session does not exist.');
    return out;
  }

  campus(r: RowReader, field: string, options: ImportOptions): Ref | undefined {
    const raw = r.raw(field);
    if (raw) {
      const c = this.campuses.find((x) => nameKey(x.name) === nameKey(raw));
      if (!c)
        r.error(field, `"${raw}" is not a campus you can import into (${this.campuses.map((x) => x.name).join(', ')})`);
      return c;
    }
    if (options.campusId) return this.campuses.find((c) => c.id === options.campusId);
    return this.campuses.length === 1 ? this.campuses[0] : undefined;
  }

  session(r: RowReader, field: string, options: ImportOptions): Ref | undefined {
    const raw = r.raw(field);
    if (raw) {
      const s = this.sessions.find((x) => nameKey(x.name) === nameKey(raw));
      if (!s)
        r.error(
          field,
          `"${raw}" is not an academic session in this school (${this.sessions.map((x) => x.name).join(', ') || 'none yet'}). Create it in Academics → Sessions`,
        );
      return s;
    }
    const id = options.sessionId ?? this.currentSessionId;
    const s = id ? this.sessions.find((x) => x.id === id) : undefined;
    if (!s)
      r.error(undefined, 'No academic session: choose one for the import, or set the current session in Academics');
    return s;
  }

  findClass(campusId: string, name: string) {
    return this.classes.find((c) => c.campusId === campusId && nameKey(c.name) === nameKey(name));
  }

  sectionsOf(classId: string, sessionId: string) {
    return this.sections.filter((s) => s.classId === classId && s.sessionId === sessionId);
  }

  classNamesIn(campusId: string) {
    return this.classes.filter((c) => c.campusId === campusId).map((c) => c.name);
  }
}
