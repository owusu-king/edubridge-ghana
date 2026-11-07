import type { Metadata } from "next";
import { CalendarCheck } from "lucide-react";
import { OfflineStatus } from "@/components/attendance/offline-status";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
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
  const { term, classes, lock } = await listRegisters(db(), ctx, date);
  const base = schoolPath(slug, "attendance");
  const registerUrl = (classId: string) => `${base}/${classId}?date=${date}`;

  return (
    <div className="space-y-6">
      <OfflineStatus
        slug={slug}
        userId={user.id}
        send={syncRegisterAction.bind(null, slug)}
        savePages={date === today ? classes.map((c) => registerUrl(c.cls.id)) : []}
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
      ) : classes.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="No classes"
          description="You take registers for the classes you are class teacher of. Ask the head teacher to assign you a class."
        />
      ) : (
        <>
          {lock && <p className="text-sm text-ink-3">{lock}</p>}
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
        </>
      )}
    </div>
  );
}
