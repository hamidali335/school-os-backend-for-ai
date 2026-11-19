# Homework teacher attribution

How the teacher shown on a homework is decided. Implemented in `src/modules/homework/homework-teacher.ts`.

## The bug this replaces

`POST /homework` used to store `teacherId = the signed-in user's employee record`. An Admin usually has no employee record, so homework set by an Admin was saved with no teacher. Nothing ever filled it in later, so the details page showed **Teacher: —** permanently, even after a teacher was assigned to that class and subject.

## Rules

| Situation | Teacher stored (`teacherSource`) |
|---|---|
| A teacher sets the homework | That teacher (`creator`). A substitute covering the class is also recorded in `createdViaSubstituteId`. |
| An administrator picks a teacher | The chosen teacher (`explicit`). They must teach that subject in that section, or be its class teacher; otherwise `422 TEACHER_NOT_ELIGIBLE`. |
| An administrator does not pick, and the class-subject has a teacher | The subject teacher (`assignment`). |
| An administrator does not pick, and nobody teaches the class-subject | Refused with `422 TEACHER_NOT_ASSIGNED`, unless the administrator explicitly saves it unassigned (`allowUnassigned: true`). |
| A teacher is assigned to the class-subject later | Homework of that class-subject **with no teacher** is attributed to them (`backfill`). |
| The class-subject's teacher changes later | Existing homework **keeps** its teacher (historical attribution is never rewritten). |

There is never more than one teacher per class-subject: `(section, subject)` is unique for teaching assignments, so a second one is refused with `409`. No teacher is ever chosen arbitrarily.

## What the API returns

`GET /homework` and `GET /homework/{id}` return, besides `teacherId`:

- `teacher` — the teacher to display: the attributed one, or the current subject teacher when the record has none (old records).
- `teacherStatus` — `attributed`, `from_current_assignment` or `unassigned`.
- `currentSubjectTeacher` — who teaches that subject in that section today. The UI shows it when it differs from `teacher`.

## Who may manage or grade

Access follows the **current** teaching assignment (or an active substitute cover with the `homework` capability), not the stored attribution. When the subject teacher changes, the new teacher can grade open homework; the previous teacher no longer can (unless they are still the section's class teacher).

## Existing data

`npm run migrate:2026-10 -- --apply` attributes existing homework without a teacher to the current subject teacher where one exists. Homework that still has no teacher shows "No teacher assigned" until one is assigned.
