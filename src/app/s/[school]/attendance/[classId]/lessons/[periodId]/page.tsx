import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RegisterScreen } from "@/components/attendance/register-screen";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getLessonRegister } from "@/server/attendance/lessons";
import { db } from "@/server/db/client";
import { isIsoDate } from "@/lib/attendance";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { syncRegisterAction } from "../../../actions";

export const metadata: Metadata = { title: "Lesson register" };

const weekday = new Intl.DateTimeFormat("en-GH", { weekday: "long", timeZone: "UTC" });

/** Who was in one timetabled lesson on one day. Works offline like the class register. */
export default async function LessonRegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string; periodId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ school, classId, periodId }, search] = await Promise.all([params, searchParams]);
  const { ctx, user } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const date = isIsoDate(search.date) && search.date <= today ? search.date : today;
  const register = await getLessonRegister(db(), ctx, classId, date, periodId);
  if (!register) notFound();
  const { lesson } = register;
  const back = `${schoolPath(slug, "attendance")}?date=${date}`;
  const summary = register.termSummary;

  return (
    <div className="space-y-8">
      <div>
        <a
          href={back}
          className="-ml-2 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All registers
        </a>
        <h2 className="mt-1 font-display text-xl font-medium tracking-tight text-ink">
          {lesson.subjectName}, {lesson.className}
        </h2>
        <p className="mt-1 text-sm text-ink-3">
          {weekday.format(new Date(`${date}T00:00:00Z`))} {formatCalendarDate(date)}
          {date === today ? " (today)" : ""} · {lesson.periodName}, {lesson.startsAt}–{lesson.endsAt}
          {lesson.teacherName ? ` · ${lesson.teacherName}` : ""}
          {register.takenBy ? ` · Taken by ${register.takenBy}` : ""}
        </p>
      </div>

      {register.students.length === 0 ? (
        <p className="text-base text-ink-3">
          {register.term ? "No students are in this class this term." : "This day is not in any term."}
        </p>
      ) : (
        <RegisterScreen
          slug={slug}
          userId={user.id}
          classId={lesson.classId}
          className={`${lesson.className}, ${lesson.subjectName} (${lesson.periodName})`}
          date={date}
          periodId={lesson.periodId}
          lock={register.lock}
          students={register.students}
          send={syncRegisterAction.bind(null, slug)}
          timeZone={ctx.tenant.timezone}
        />
      )}

      {summary && summary.held > 0 && (
        <section aria-labelledby="subject-attendance" className="space-y-3">
          <div>
            <h3 id="subject-attendance" className="text-md font-semibold text-ink">
              {lesson.subjectName} this term
            </h3>
            <p className="mt-0.5 text-sm text-ink-3">
              {summary.held} {summary.held === 1 ? "lesson register" : "lesson registers"} taken in{" "}
              {lesson.className}.
            </p>
          </div>
          <TableFrame>
            <Table>
              <caption className="sr-only">
                {lesson.subjectName} attendance this term, {lesson.className}
              </caption>
              <THead>
                <tr>
                  <TH>Student</TH>
                  <TH numeric>Lessons attended</TH>
                </tr>
              </THead>
              <TBody>
                {register.students.map((s) => {
                  const attended = summary.attended.get(s.id) ?? 0;
                  return (
                    <TR key={s.id}>
                      <TD className="font-medium text-ink">{s.name}</TD>
                      <TD numeric>
                        {attended} of {summary.held}
                        <span className="text-sm text-ink-3">
                          {" "}
                          ({Math.round((attended * 100) / summary.held)}%)
                        </span>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableFrame>
        </section>
      )}
    </div>
  );
}
