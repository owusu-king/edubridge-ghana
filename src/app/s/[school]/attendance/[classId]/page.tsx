import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { RegisterScreen } from "@/components/attendance/register-screen";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getClassAttendance, getRegister } from "@/server/attendance/registers";
import { db } from "@/server/db/client";
import { attendanceRate, isIsoDate, nearestWeekday } from "@/lib/attendance";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { syncRegisterAction } from "../actions";

export const metadata: Metadata = { title: "Register" };

const weekday = new Intl.DateTimeFormat("en-GH", { weekday: "long", timeZone: "UTC" });

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ school, classId }, search] = await Promise.all([params, searchParams]);
  const { ctx, user } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const date = isIsoDate(search.date) && search.date <= today ? search.date : today;
  const [register, summary] = await Promise.all([
    getRegister(db(), ctx, classId, date),
    getClassAttendance(db(), ctx, classId, date),
  ]);
  if (!register) notFound();
  const base = schoolPath(slug, "attendance");
  const link =
    "inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft";
  const previous = nearestWeekday(date, -1);
  const next = nearestWeekday(date, 1);

  return (
    <div className="space-y-8">
      <div>
        <a href={`${base}?date=${date}`} className={`-ml-2 ${link}`}>
          <ArrowLeft aria-hidden="true" className="size-4" />
          All classes
        </a>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-medium tracking-tight text-ink">{register.cls.name}</h2>
            <p className="mt-1 text-sm text-ink-3">
              {weekday.format(new Date(`${date}T00:00:00Z`))} {formatCalendarDate(date)}
              {date === today ? " (today)" : ""}
              {register.term ? ` · ${register.term.name}` : ""}
              {register.takenBy ? ` · Taken by ${register.takenBy}` : ""}
            </p>
          </div>
          <nav aria-label="Other days" className="flex gap-1">
            <a href={`${base}/${register.cls.id}?date=${previous}`} className={link}>
              <ChevronLeft aria-hidden="true" className="size-4" />
              Previous day
            </a>
            {next <= today && (
              <a href={`${base}/${register.cls.id}?date=${next}`} className={link}>
                Next day
                <ChevronRight aria-hidden="true" className="size-4" />
              </a>
            )}
          </nav>
        </div>
      </div>

      {register.students.length === 0 ? (
        <p className="text-base text-ink-3">
          {register.term ? "No students are in this class this term." : "This day is not in any term."}
        </p>
      ) : (
        <RegisterScreen
          slug={slug}
          userId={user.id}
          classId={register.cls.id}
          className={register.cls.name}
          date={date}
          lock={register.lock}
          students={register.students}
          send={syncRegisterAction.bind(null, slug)}
          timeZone={ctx.tenant.timezone}
        />
      )}

      {summary && summary.registers > 0 && (
        <section aria-labelledby="term-attendance" className="space-y-3">
          <div>
            <h3 id="term-attendance" className="text-md font-semibold text-ink">
              {register.term?.name} so far
            </h3>
            <p className="mt-0.5 text-sm text-ink-3">
              {summary.registers} {summary.registers === 1 ? "register" : "registers"} taken. Report cards use
              these figures unless different ones are typed in.
            </p>
          </div>
          <TableFrame>
            <Table>
              <caption className="sr-only">Attendance this term</caption>
              <THead>
                <tr>
                  <TH>Student</TH>
                  <TH numeric>Attended</TH>
                  <TH numeric className="hidden sm:table-cell">
                    Late
                  </TH>
                  <TH numeric className="hidden sm:table-cell">
                    Absent
                  </TH>
                  <TH numeric className="hidden sm:table-cell">
                    Excused
                  </TH>
                </tr>
              </THead>
              <TBody>
                {summary.students.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-medium text-ink">{s.name}</TD>
                    <TD numeric>
                      {s.totals.present + s.totals.late} of {s.totals.open}
                      {s.totals.open > 0 && (
                        <span className="text-sm text-ink-3"> ({attendanceRate(s.totals)}%)</span>
                      )}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {s.totals.late}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {s.totals.absent}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {s.totals.excused}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </section>
      )}
    </div>
  );
}
