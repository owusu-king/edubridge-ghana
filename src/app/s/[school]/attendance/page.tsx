import type { Metadata } from "next";
import { CalendarCheck } from "lucide-react";
import { OfflineStatus } from "@/components/attendance/offline-status";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listLessonRegisters, type LessonSummary, type MissedLesson } from "@/server/attendance/lessons";
import { listRegisters } from "@/server/attendance/registers";
import { db } from "@/server/db/client";
import { isIsoDate, isWeekend } from "@/lib/attendance";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { syncRegisterAction } from "./actions";

export const metadata: Metadata = { title: "Attendance" };

export default async function AttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx, user } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const date = isIsoDate(search.date) && search.date <= today ? search.date : today;
  const [{ term, classes, lock }, lessonDay] = await Promise.all([
    listRegisters(db(), ctx, date),
    listLessonRegisters(db(), ctx, date),
  ]);
  const base = schoolPath(slug, "attendance");
  const registerUrl = (classId: string) => `${base}/${classId}?date=${date}`;
  const lessonUrl = (classId: string, periodId: string) =>
    `${base}/${classId}/lessons/${periodId}?date=${date}`;
  const lessons = lessonDay.lessons;

  return (
    <div className="space-y-6">
      <OfflineStatus
        slug={slug}
        userId={user.id}
        send={syncRegisterAction.bind(null, slug)}
        savePages={
          date === today
            ? [
                ...classes.map((c) => registerUrl(c.cls.id)),
                ...lessons.map((l) => lessonUrl(l.lesson.classId, l.lesson.periodId)),
              ]
            : []
        }
        basePath={base}
      />
      <form method="get" className="flex items-end gap-2" aria-label="Choose day">
        <div className="space-y-1.5">
          <label htmlFor="attendance-date" className="block text-sm font-medium text-ink">
            Day
          </label>
          <Input
            id="attendance-date"
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            className="w-44"
          />
        </div>
        <button type="submit" className={buttonStyles("secondary")}>
          Show
        </button>
      </form>
      <p className="text-sm text-ink-3">
        {formatCalendarDate(date)}
        {date === today ? " (today)" : ""}
        {term ? ` · ${term.name}` : ""}
        {isWeekend(date) ? " · a weekend" : ""}
      </p>

      {!term ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="Not a school day"
          description="This day is not in any term. Registers are taken during terms set in Settings, Calendar."
        />
      ) : classes.length === 0 && lessons.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="No classes"
          description={
            lessonDay.enabled
              ? "You take class registers for the classes you are class teacher of, and lesson registers for the lessons you teach on the timetable."
              : "You take registers for the classes you are class teacher of. Ask the head teacher to assign you a class."
          }
        />
      ) : (
        <>
          {lock && <p className="text-sm text-ink-3">{lock}</p>}
          {classes.length > 0 && (
            <TableFrame>
              <Table>
                <caption className="sr-only">Registers for {formatCalendarDate(date)}</caption>
                <THead>
                  <tr>
                    <TH>Class</TH>
                    <TH>Register</TH>
                    <TH className="hidden sm:table-cell">Absent</TH>
                    <TH className="hidden md:table-cell">Taken by</TH>
                  </tr>
                </THead>
                <TBody>
                  {classes.map(({ cls, students, register }) => (
                    <TR key={cls.id}>
                      <TD>
                        {/* A plain link: a full page load can be answered offline by the saved page. */}
                        <a
                          href={registerUrl(cls.id)}
                          className="font-medium text-ink hover:text-accent hover:underline"
                        >
                          {cls.name}
                        </a>
                        <span className="block text-sm text-ink-3">{students} students</span>
                      </TD>
                      <TD>
                        {!register ? (
                          <StatusText tone="neutral">Not taken</StatusText>
                        ) : register.marked < students ? (
                          <StatusText tone="caution">
                            {register.marked} of {students} marked
                          </StatusText>
                        ) : (
                          <StatusText tone="positive">Taken</StatusText>
                        )}
                      </TD>
                      <TD className="hidden tabular-nums sm:table-cell">
                        {register ? register.counts.absent + register.counts.excused : "—"}
                        {register && register.counts.late ? (
                          <span className="text-sm text-ink-3"> · {register.counts.late} late</span>
                        ) : null}
                      </TD>
                      <TD className="hidden md:table-cell">
                        {register ? (
                          <>
                            {register.takenBy ?? "—"}
                            <span className="block text-sm text-ink-3">
                              {formatDateTime(register.updatedAt, ctx.tenant.timezone)}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
          {lessonDay.enabled && (
            <LessonRegisters
              lessons={lessons}
              lessonUrl={lessonUrl}
              missed={lessonDay.missed}
              timetableHref={schoolPath(slug, "timetable")}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Today's timetabled lessons this member takes a register for, and (academic staff) who missed lessons. */
function LessonRegisters({
  lessons,
  lessonUrl,
  missed,
  timetableHref,
}: {
  lessons: LessonSummary[];
  lessonUrl: (classId: string, periodId: string) => string;
  missed: MissedLesson[] | null;
  timetableHref: string;
}) {
  return (
    <section aria-labelledby="lesson-registers" className="space-y-3">
      <div>
        <h2 id="lesson-registers" className="text-md font-semibold text-ink">
          Lessons
        </h2>
        <p className="mt-0.5 text-sm text-ink-3">A register in each lesson on the timetable for this day.</p>
      </div>
      {lessons.length === 0 ? (
        <p className="text-base text-ink-3">
          No lessons for you on the{" "}
          <a href={timetableHref} className="text-accent hover:underline">
            timetable
          </a>{" "}
          this day.
        </p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Lesson registers</caption>
            <THead>
              <tr>
                <TH>Lesson</TH>
                <TH>Register</TH>
                <TH className="hidden sm:table-cell">Absent</TH>
                <TH className="hidden md:table-cell">Teacher</TH>
              </tr>
            </THead>
            <TBody>
              {lessons.map(({ lesson, students, register }) => (
                <TR key={`${lesson.classId}:${lesson.periodId}`}>
                  <TD>
                    <a
                      href={lessonUrl(lesson.classId, lesson.periodId)}
                      className="font-medium text-ink hover:text-accent hover:underline"
                    >
                      {lesson.subjectName}, {lesson.className}
                    </a>
                    <span className="block text-sm text-ink-3 tabular-nums">
                      {lesson.periodName}, {lesson.startsAt}–{lesson.endsAt}
                    </span>
                  </TD>
                  <TD>
                    {!register ? (
                      <StatusText tone="neutral">Not taken</StatusText>
                    ) : register.marked < students ? (
                      <StatusText tone="caution">
                        {register.marked} of {students} marked
                      </StatusText>
                    ) : (
                      <StatusText tone="positive">Taken</StatusText>
                    )}
                  </TD>
                  <TD className="hidden tabular-nums sm:table-cell">{register ? register.absent : "—"}</TD>
                  <TD className="hidden md:table-cell">
                    {lesson.teacherName ?? <span className="text-ink-3">—</span>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
      {missed && missed.length > 0 && (
        <div className="space-y-2 rounded-lg border border-caution/30 bg-caution-soft p-4">
          <h3 className="text-base font-semibold text-ink">At school but absent from a lesson</h3>
          <p className="text-sm text-ink-2">
            Marked present or late on the class register, and absent in these lessons.
          </p>
          <ul className="space-y-1 text-base">
            {missed.map((m) => (
              <li key={m.studentId}>
                <span className="font-medium text-ink">{m.name}</span>{" "}
                <span className="text-ink-3">({m.className})</span>: {m.lessons.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
