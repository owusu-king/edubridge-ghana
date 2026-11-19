import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { ActionButton } from "@/components/ui/action-forms";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LessonText, TimetableGrid } from "@/components/timetable/timetable-grid";
import { TermPicker } from "@/components/term-picker";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getTeacherTimetable, getTimetableOverview } from "@/server/timetable/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm, termQuery } from "@/web/terms";
import { copyTimetableAction, removePeriodAction, savePeriodAction } from "./actions";
import { CopyTimetableForm, PeriodDialog } from "./timetable-controls";

export const metadata: Metadata = { title: "Timetable" };

/**
 * Timetables: the member's own lessons (or, for academic staff, any teacher's), the classes whose timetables
 * they can open, and for those who plan them, the school day's periods and copying from another term.
 */
export default async function TimetablePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string; teacher?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "timetable.view")) notFound();
  const slug = ctx.tenant.slug;
  const { terms, term } = await chooseTerm(ctx, search.term);
  const header = (
    <PageHeader
      title="Timetable"
      description="The school day's periods, and each class's lessons for the term: subject and teacher."
    />
  );
  if (!term)
    return (
      <div className="space-y-8">
        {header}
        <EmptyState
          icon={<CalendarClock />}
          title="No terms yet"
          description="Timetables are kept per term. Add your academic year and its terms first."
        />
      </div>
    );
  const [overview, teacher] = await Promise.all([
    getTimetableOverview(db(), ctx, term.id),
    getTeacherTimetable(db(), ctx, term.id, search.teacher),
  ]);
  if (!overview) notFound();
  const lessonPeriods = overview.periods.filter((p) => p.kind === "lesson");
  const otherTerms = terms.filter((t) => t.id !== term.id);

  return (
    <div className="space-y-10">
      {header}
      <TermPicker terms={terms} termId={term.id} />

      {overview.periods.length === 0 ? (
        <EmptyState
          icon={<CalendarClock />}
          title="The school day is not set up"
          description={
            overview.canManage
              ? "Add the day's periods and breaks below, then plan each class's lessons."
              : "Academic staff set up the school day's periods first."
          }
        />
      ) : (
        teacher &&
        (teacher.lessons.length > 0 || teacher.teachers.length > 0) && (
          <Section
            title={teacher.own ? "Your lessons" : `${teacher.teacher.name}'s lessons`}
            description={`${term.label}. ${teacher.lessons.length} ${teacher.lessons.length === 1 ? "lesson" : "lessons"} a week.`}
            aside={
              teacher.teachers.length > 0 && (
                <form method="get" className="flex items-end gap-2" aria-label="Choose teacher">
                  <input type="hidden" name="term" value={term.id} />
                  <label htmlFor="teacher-picker" className="sr-only">
                    Teacher
                  </label>
                  <Select
                    id="teacher-picker"
                    name="teacher"
                    defaultValue={teacher.teacher.membershipId}
                    className="min-w-48"
                  >
                    {teacher.teachers.map((t) => (
                      <option key={t.membershipId} value={t.membershipId}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                  <button type="submit" className={buttonStyles("secondary")}>
                    Show
                  </button>
                </form>
              )
            }
          >
            {teacher.lessons.length === 0 ? (
              <p className="text-base text-ink-3">No lessons on the timetable this term.</p>
            ) : (
              <TimetableGrid
                periods={overview.periods}
                caption={`${teacher.teacher.name}'s lessons, ${term.label}`}
                cell={(weekday, period) => {
                  const lesson = teacher.lessons.find(
                    (l) => l.weekday === weekday && l.periodId === period.id,
                  );
                  return lesson ? <LessonText title={lesson.subjectName} detail={lesson.className} /> : null;
                }}
              />
            )}
          </Section>
        )
      )}

      <Section
        title="Classes"
        description={
          overview.canManage
            ? "Open a class to plan its lessons."
            : "Timetables of the classes you are class teacher of."
        }
      >
        {overview.classes.length === 0 ? (
          <EmptyState
            icon={<CalendarClock />}
            title="No classes"
            description="Class timetables appear here for the classes you can see."
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Class timetables, {term.label}</caption>
              <THead>
                <tr>
                  <TH>Class</TH>
                  <TH className="hidden sm:table-cell">Campus</TH>
                  <TH numeric>Lessons a week</TH>
                </tr>
              </THead>
              <TBody>
                {overview.classes.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link
                        href={`${schoolPath(slug, `timetable/${c.id}`)}${termQuery(term.id)}` as Route}
                        className="font-medium text-ink hover:text-accent hover:underline"
                      >
                        {c.name}
                      </Link>
                      <span className="block text-sm text-ink-3">{c.levelName}</span>
                    </TD>
                    <TD className="hidden sm:table-cell">{c.campusName}</TD>
                    <TD numeric>
                      {c.lessons}
                      {lessonPeriods.length > 0 && (
                        <span className="text-sm text-ink-3"> of {lessonPeriods.length * 5}</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      {overview.canManage && (
        <Section
          title="School day"
          description="Periods and breaks, shared by every class. Changing times does not change lessons or registers."
          aside={<PeriodDialog action={savePeriodAction.bind(null, slug, null)} />}
        >
          {overview.periods.length === 0 ? (
            <p className="text-base text-ink-3">No periods yet.</p>
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">The school day</caption>
                <THead>
                  <tr>
                    <TH>Period</TH>
                    <TH>Time</TH>
                    <TH className="hidden sm:table-cell">Kind</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {overview.periods.map((p) => (
                    <TR key={p.id}>
                      <TD className="font-medium text-ink">{p.name}</TD>
                      <TD className="tabular-nums">
                        {p.startsAt}–{p.endsAt}
                      </TD>
                      <TD className="hidden sm:table-cell">{p.kind === "break" ? "Break" : "Lesson"}</TD>
                      <TD className="text-right">
                        <span className="inline-flex flex-wrap items-start justify-end gap-1">
                          <PeriodDialog action={savePeriodAction.bind(null, slug, p.id)} period={p} />
                          <ActionButton
                            action={removePeriodAction.bind(null, slug, p.id)}
                            label="Remove"
                            ariaLabel={`Remove ${p.name}`}
                          />
                        </span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}

      {overview.canManage && otherTerms.length > 0 && overview.periods.length > 0 && (
        <Section
          title="Copy from another term"
          description="Copies every class's lessons into this term. Classes that already have lessons this term are left as they are."
        >
          <CopyTimetableForm
            action={copyTimetableAction.bind(null, slug, term.id)}
            terms={otherTerms.map((t) => ({ id: t.id, label: t.label }))}
          />
        </Section>
      )}
    </div>
  );
}
