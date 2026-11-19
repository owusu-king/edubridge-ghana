import type { Metadata, Route } from "next";
import Link from "next/link";
import { CalendarDays, FileDown, Wallet } from "lucide-react";
import { Aging } from "@/components/overview/aging";
import {
  AttendanceSummary,
  EnrolmentSummary,
  FeesSummary,
  ReportCardSummary,
} from "@/components/overview/summary-panel";
import { WeeklyCollections } from "@/components/overview/weekly-collections";
import { ScopePicker } from "@/components/overview/scope-picker";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentTerm } from "@/server/academics/calendar";
import { pendingMove } from "@/server/academics/term-move";
import { seesAllClasses } from "@/server/assessment/access";
import { listAssessmentClasses } from "@/server/assessment/scores";
import { listLessonRegisters } from "@/server/attendance/lessons";
import { listRegisters } from "@/server/attendance/registers";
import { getTeacherTimetable } from "@/server/timetable/service";
import { isoWeekday } from "@/lib/timetable";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { getOperationsNow, printsBoardSummary } from "@/server/dashboard/board-summary";
import { getOwedToday, getTermFinance } from "@/server/dashboard/finance";
import { countWaitingIndicators } from "@/server/early-warning/indicators";
import { narrowToCampus } from "@/server/fees/access";
import { getAttendanceOverview, getEnrolment } from "@/server/dashboard/school";
import { db } from "@/server/db/client";
import { METHOD_LABELS } from "@/server/fees/payments";
import { getSetupProgress } from "@/server/setup/progress";
import type { TenantContext } from "@/server/tenancy/service";
import { percent } from "@/lib/dashboard";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { STEP_INFO } from "@/web/setup-steps";
import { chooseTerm, termQuery, type TermOption } from "@/web/terms";

export const metadata: Metadata = { title: "Command Center" };

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GH", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const span = (from: string, to: string) =>
  from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
const rate = (value: number | null) => (value === null ? "—" : `${value}%`);

function Figure({
  label,
  value,
  href,
  note,
}: {
  label: string;
  value: string;
  href?: string;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-ink-3">{label}</p>
      {href ? (
        <Link
          href={href as Route}
          className="mt-1 block font-display text-xl text-ink tabular-nums decoration-line-strong underline-offset-4 hover:text-accent hover:underline"
        >
          {value}
        </Link>
      ) : (
        <p className="mt-1 font-display text-xl text-ink tabular-nums">{value}</p>
      )}
      {note && <p className="mt-0.5 text-sm text-ink-3">{note}</p>}
    </div>
  );
}

/**
 * The Command Center (R5-1): the school's money, attendance, results, students and operations for a term and
 * campus, each figure linked to its report, with a one-page board summary to download.
 */
export default async function CommandCenterPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string; campus?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { user, ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const { terms, term } = await chooseTerm(ctx, search.term);
  const lead = seesAllClasses(ctx);
  const teacherOnly = allowed(ctx, "attendance.take") && !lead;
  const firstName = user.name.split(" ")[0] ?? user.name;
  // OVR-01: the figures for one campus, with exactly the scope a member of that campus has.
  const campuses =
    !teacherOnly && (allowed(ctx, "fees.view") || allowed(ctx, "students.view_all"))
      ? (await listCampuses(db(), ctx)).filter((c) => c.status === "active")
      : [];
  const scoped = narrowToCampus(ctx, campuses.length > 1 ? search.campus : null);
  const campus = scoped === ctx ? null : (campuses.find((c) => c.id === search.campus) ?? null);
  const reportQuery = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ ...(campus ? { campus: campus.id } : {}), ...extra }).toString()}`;

  const [setup, finance, owed, enrolment, attendance, assessment, operations, currentTerm, toReview] =
    await Promise.all([
      getSetupProgress(db(), ctx),
      allowed(ctx, "fees.view") && term ? getTermFinance(db(), scoped, term.id) : null,
      allowed(ctx, "fees.view") ? getOwedToday(db(), scoped) : null,
      allowed(ctx, "students.view_all") && term ? getEnrolment(db(), scoped, term.id) : null,
      term ? getAttendanceOverview(db(), scoped, term.id, today) : null,
      lead && allowed(ctx, "assessment.enter") && term ? listAssessmentClasses(db(), ctx, term.id) : null,
      teacherOnly ? null : getOperationsNow(db(), ctx),
      getCurrentTerm(db(), ctx),
      teacherOnly ? null : countWaitingIndicators(db(), ctx),
    ]);
  const move =
    allowed(ctx, "academics.manage") && ctx.campusIds === null ? await pendingMove(db(), ctx) : null;
  const opTiles = operations
    ? (
        [
          ["Leave waiting", operations.leaveWaiting, "leave"],
          ["Repairs open", operations.maintenanceOpen, "inventory/maintenance"],
          ["Urgent repairs", operations.maintenanceUrgent, "inventory/maintenance"],
          ["Purchases waiting", operations.purchasesWaiting, "inventory/purchases"],
          ["Boarders overdue back", operations.exeatsOverdue, "boarding/exeats"],
          ["Library books overdue", operations.libraryOverdue, "library/loans"],
          ["Pickups refused today", operations.pickupsRefusedToday, "pickup"],
          ["Visitors on site", operations.visitorsOnSite, "visitors"],
          ["Early-warning reviews waiting", toReview, "early-warning"],
        ] as const
      ).filter(([, n]) => n !== null)
    : [];

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow={`Welcome, ${firstName}`}
        title={ctx.tenant.name}
        description={
          term
            ? `Command Center for ${campus ? `${campus.name} campus, ` : ""}${
                currentTerm && currentTerm.id === term.id
                  ? `${currentTerm.name}, ${currentTerm.yearName} · ${formatCalendarDate(currentTerm.startsOn)} – ${formatCalendarDate(currentTerm.endsOn)}`
                  : term.label
              }.`
            : "Command Center"
        }
        actions={
          teacherOnly ? null : (
            <div className="flex flex-wrap items-end gap-2">
              {((terms.length > 1 && term) || campuses.length > 1) && (
                <ScopePicker
                  terms={terms}
                  termId={term?.id ?? null}
                  campuses={campuses}
                  campusId={campus?.id ?? null}
                />
              )}
              {term && printsBoardSummary(ctx) && (
                <a
                  href={`${schoolPath(slug, "board-summary")}?${new URLSearchParams({ term: term.id, ...(campus ? { campus: campus.id } : {}) }).toString()}`}
                  className={buttonStyles("secondary")}
                >
                  <FileDown aria-hidden="true" className="size-4" />
                  Board summary
                </a>
              )}
              {term && allowed(ctx, "drafting.board_report") && (
                <Link
                  href={
                    `${schoolPath(slug, "board-report")}?${new URLSearchParams({ term: term.id, ...(campus ? { campus: campus.id } : {}) }).toString()}` as Route
                  }
                  className={buttonStyles("secondary")}
                >
                  Board report
                </Link>
              )}
            </div>
          )
        }
      />

      {move && (
        <section
          aria-labelledby="move-heading"
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-raised sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0 space-y-1">
            <h2 id="move-heading" className="text-md font-semibold text-ink">
              Nobody is in a class for {move.to.name}, {move.to.yearName} yet
            </h2>
            <p className="text-base text-ink-2">
              Move students across from {move.from.name}, {move.from.yearName}, so fees, registers and report
              cards can follow.
            </p>
          </div>
          <Link
            href={`${schoolPath(slug, "classes/move")}?from=${move.from.id}&to=${move.to.id}` as Route}
            className={buttonStyles("primary")}
          >
            Move students
          </Link>
        </section>
      )}

      {setup && !setup.complete && <SetupPanel slug={slug} progress={setup} />}

      {allowed(ctx, "timetable.view") && <TeacherLessons ctx={ctx} today={today} term={term} />}

      {teacherOnly && <TeacherClasses ctx={ctx} today={today} term={term} />}

      {finance && (
        <Section
          title="Fees"
          description={`${finance.term.name}, ${finance.term.yearName}: ${formatCalendarDate(finance.term.startsOn)} to ${formatCalendarDate(finance.term.endsOn)}.`}
        >
          {!finance.period ? (
            <EmptyState
              icon={<CalendarDays />}
              title="This term has not started"
              description="Collections are counted from the first day of term."
            />
          ) : finance.billedPesewas === 0 && finance.owedAtStartPesewas === 0 && !finance.collected?.count ? (
            <EmptyState
              icon={<Wallet />}
              title="No fees billed for this term yet"
              description="Once the term is billed and payments come in, collections and arrears appear here."
              action={
                allowed(ctx, "fees.manage") && (
                  <Link
                    href={`${schoolPath(slug, "fees")}${termQuery(finance.term.id)}` as Route}
                    className={buttonStyles("primary")}
                  >
                    Open fees
                  </Link>
                )
              }
            />
          ) : (
            <div className="space-y-8">
              <FeesSummary
                rate={finance.collectionRate}
                rateNote={
                  finance.collectionRateBasis === "billed"
                    ? "Of this term's fees"
                    : `Of ${showMoney(finance.owedAtStartPesewas)} owed at the start plus the term's fees`
                }
                figures={[
                  {
                    label: "Billed for the term",
                    value: showMoney(finance.billedPesewas),
                    href: campus
                      ? `${schoolPath(slug, "fees/reports")}${reportQuery({ term: finance.term.id })}`
                      : `${schoolPath(slug, "fees")}${termQuery(finance.term.id)}`,
                    note: "Charges less discounts",
                  },
                  {
                    label: "Collected",
                    value: showMoney(finance.collected?.totalPesewas ?? 0),
                    href: campus
                      ? `${schoolPath(slug, "fees/reports")}${reportQuery({ from: finance.period.from, to: finance.period.to })}`
                      : `${schoolPath(slug, "fees/payments")}?from=${finance.period.from}&to=${finance.period.to}`,
                    note: `${finance.collected?.count ?? 0} payments, ${span(finance.period.from, finance.period.to)}`,
                  },
                  {
                    label: "Paid after a reminder",
                    value:
                      finance.reminders.reminded === 0
                        ? "—"
                        : `${finance.reminders.paid} of ${finance.reminders.reminded}`,
                    href: schoolPath(slug, "fees/owing"),
                    note:
                      finance.reminders.reminded === 0
                        ? "No reminders sent this term"
                        : `Paid ${showMoney(finance.reminders.paidPesewas)} within a week`,
                  },
                ]}
              />
              <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink">Collected each week</h3>
                  <WeeklyCollections
                    currency={ctx.tenant.currencyCode}
                    caption={`Money collected each week, ${span(finance.period.from, finance.period.to)}`}
                    weeks={finance.weeks.map((w) => ({
                      ...w,
                      label: span(w.from, w.to),
                      href: `${schoolPath(slug, "fees/payments")}?from=${w.from}&to=${w.to}`,
                    }))}
                  />
                </div>
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink">How families paid</h3>
                  {finance.collected && finance.collected.count > 0 ? (
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Money collected by payment method</caption>
                      <thead>
                        <tr className="border-b border-line text-ink-3">
                          <th scope="col" className="py-2 font-medium">
                            Method
                          </th>
                          <th scope="col" className="py-2 text-right font-medium">
                            Collected
                          </th>
                          <th scope="col" className="py-2 text-right font-medium">
                            Share
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {finance.collected.byMethod.map((m) => (
                          <tr key={m.method} className="border-b border-line last:border-0">
                            <td className="py-2 text-ink-2">{METHOD_LABELS[m.method]}</td>
                            <td className="py-2 text-right text-ink tabular-nums">
                              {showMoney(m.totalPesewas)}
                            </td>
                            <td className="py-2 text-right text-ink-3 tabular-nums">
                              {rate(percent(m.totalPesewas, finance.collected!.totalPesewas))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-sm text-ink-3">No payments yet this term.</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {owed && (
        <Section
          title="Owed today"
          description="What families owe now, across every term, by how long it has been owed (payments settle the oldest charges first)."
          aside={
            <Link
              href={schoolPath(slug, "fees/owing")}
              className="text-sm font-medium text-accent hover:underline"
            >
              Who owes what
            </Link>
          }
        >
          {owed.students === 0 ? (
            <p className="text-base text-ink-2">No family owes anything today.</p>
          ) : (
            <div className="grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
              <div>
                <Link
                  href={schoolPath(slug, "fees/owing")}
                  className="font-display text-2xl text-ink decoration-line-strong underline-offset-4 hover:text-accent hover:underline"
                >
                  {showMoney(owed.totalPesewas)}
                </Link>
                <p className="mt-1 text-sm text-ink-3">
                  Owed by {owed.students} {owed.students === 1 ? "student" : "students"}
                </p>
              </div>
              <Aging
                currency={ctx.tenant.currencyCode}
                buckets={owed.buckets}
                totalPesewas={owed.totalPesewas}
              />
            </div>
          )}
        </Section>
      )}

      {attendance && (
        <Section
          title="Attendance"
          description={`${attendance.term.name}: registers taken so far. Late counts as attending.`}
          aside={
            <Link
              href={schoolPath(slug, "attendance")}
              className="text-sm font-medium text-accent hover:underline"
            >
              Registers
            </Link>
          }
        >
          {attendance.totals.open === 0 && !attendance.today ? (
            <p className="text-base text-ink-2">No registers taken this term.</p>
          ) : (
            <div className="space-y-8">
              <AttendanceSummary
                rate={attendance.rate}
                absentDays={attendance.totals.absent + attendance.totals.excused}
                today={attendance.today}
                concernPercent={attendance.concernPercent}
                concernMinDays={attendance.concernMinDays}
                concernCount={attendance.concernCount}
                classes={attendance.classes.length}
                registersHref={schoolPath(slug, "attendance")}
              />
              <div className="grid gap-10 lg:grid-cols-2">
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink">By class</h3>
                  <TableFrame>
                    <Table>
                      <caption className="sr-only">Attendance by class this term</caption>
                      <THead>
                        <tr>
                          <TH>Class</TH>
                          <TH className="text-right">Registers</TH>
                          <TH className="text-right">Attendance</TH>
                        </tr>
                      </THead>
                      <TBody>
                        {attendance.classes.map((c) => (
                          <TR key={c.id}>
                            <TD>
                              <span className="font-medium text-ink">{c.name}</span>
                              <span className="block text-sm text-ink-3">{c.students} students</span>
                            </TD>
                            <TD className="text-right tabular-nums">{c.registers}</TD>
                            <TD className="text-right tabular-nums">{rate(c.rate)}</TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </TableFrame>
                </div>
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink">Students to follow up</h3>
                  {attendance.concerns.length === 0 ? (
                    <p className="text-sm text-ink-3">
                      No student is below {attendance.concernPercent}% attendance this term.
                    </p>
                  ) : (
                    <>
                      <TableFrame>
                        <Table>
                          <caption className="sr-only">
                            Students below {attendance.concernPercent}% attendance
                          </caption>
                          <THead>
                            <tr>
                              <TH>Student</TH>
                              <TH className="text-right">Days away</TH>
                              <TH className="text-right">Attendance</TH>
                            </tr>
                          </THead>
                          <TBody>
                            {attendance.concerns.map((s) => (
                              <TR key={s.id}>
                                <TD>
                                  <Link
                                    href={schoolPath(slug, `students/${s.id}`)}
                                    className="font-medium text-ink hover:text-accent hover:underline"
                                  >
                                    {s.name}
                                  </Link>
                                  <span className="block text-sm text-ink-3">{s.className}</span>
                                </TD>
                                <TD className="text-right tabular-nums">
                                  {s.totals.absent + s.totals.excused} of {s.totals.open}
                                </TD>
                                <TD className="text-right tabular-nums">{s.rate}%</TD>
                              </TR>
                            ))}
                          </TBody>
                        </Table>
                      </TableFrame>
                      {attendance.concernCount > attendance.concerns.length && (
                        <p className="text-sm text-ink-3">
                          Showing the {attendance.concerns.length} lowest of {attendance.concernCount}.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {assessment && assessment.classes.length > 0 && (
        <Section
          title="Report cards"
          description={`${assessment.term.name}: marks entered and report cards published, by class.`}
          aside={
            <Link
              href={`${schoolPath(slug, "assessment")}${termQuery(assessment.term.id)}` as Route}
              className="text-sm font-medium text-accent hover:underline"
            >
              Assessment
            </Link>
          }
        >
          <ReportCardProgress classes={assessment.classes} />
        </Section>
      )}

      {enrolment && (
        <Section
          title="Students"
          description="Students in classes this term, by level."
          aside={
            <Link
              href={schoolPath(slug, "students")}
              className="text-sm font-medium text-accent hover:underline"
            >
              All students
            </Link>
          }
        >
          {enrolment.total === 0 ? (
            <p className="text-base text-ink-2">No students are in classes for this term.</p>
          ) : (
            <div className="space-y-6">
              <EnrolmentSummary
                total={enrolment.total}
                female={enrolment.female}
                male={enrolment.male}
                levels={enrolment.levels}
                studentsHref={schoolPath(slug, "students")}
                classesHref={schoolPath(slug, "classes")}
              />
              <ul
                className="divide-y divide-line border-y border-line"
                aria-label="Students in classes by level"
              >
                {enrolment.levels.map((l) => (
                  <li key={l.id} className="flex justify-between gap-3 py-2 text-base">
                    <span className="text-ink">{l.name}</span>
                    <span className="text-ink-2 tabular-nums">{l.total}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {opTiles.length > 0 && (
        <Section title="Operations now" description="Across the whole school, today.">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {opTiles.map(([label, n, segment]) => (
              <Figure key={label} label={label} value={String(n)} href={schoolPath(slug, segment)} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function SetupPanel({
  slug,
  progress,
}: {
  slug: string;
  progress: NonNullable<Awaited<ReturnType<typeof getSetupProgress>>>;
}) {
  const next = progress.applicable.find((s) => progress.steps[s].status !== "done")!;
  return (
    <section
      aria-labelledby="setup-heading"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-raised sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <h2 id="setup-heading" className="text-md font-semibold text-ink">
          Finish setting up: {progress.done} of {progress.applicable.length} steps done
        </h2>
        <p className="text-base text-ink-2">
          Next: {STEP_INFO[next].title.charAt(0).toLowerCase() + STEP_INFO[next].title.slice(1)}.{" "}
          <span className="text-ink-3">{progress.steps[next].detail}</span>
        </p>
      </div>
      <Link href={schoolPath(slug, "setup")} className={buttonStyles("primary")}>
        Continue setup
      </Link>
    </section>
  );
}

type AssessmentClasses = NonNullable<Awaited<ReturnType<typeof listAssessmentClasses>>>["classes"];

function ReportCardProgress({ classes }: { classes: AssessmentClasses }) {
  const students = classes.reduce((n, c) => n + c.students, 0);
  const published = classes.reduce((n, c) => n + c.published, 0);
  const complete = classes.filter((c) => c.subjects > 0 && c.completeSheets === c.subjects).length;
  return (
    <div className="space-y-6">
      <ReportCardSummary
        complete={complete}
        classes={classes.length}
        published={published}
        students={students}
      />
      <TableFrame>
        <Table>
          <caption className="sr-only">Marks and report cards by class</caption>
          <THead>
            <tr>
              <TH>Class</TH>
              <TH>Marks</TH>
              <TH className="text-right">Published</TH>
            </tr>
          </THead>
          <TBody>
            {classes.map((c) => (
              <TR key={c.cls.id}>
                <TD className="font-medium text-ink">{c.cls.name}</TD>
                <TD>
                  {c.subjects === 0 ? (
                    <StatusText tone="neutral">No subjects</StatusText>
                  ) : c.completeSheets === c.subjects ? (
                    <StatusText tone="positive">All {c.subjects} subjects</StatusText>
                  ) : (
                    <StatusText tone="caution">
                      {c.completeSheets} of {c.subjects} subjects
                    </StatusText>
                  )}
                </TD>
                <TD className="text-right tabular-nums">
                  {c.published} of {c.students}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
    </div>
  );
}

/**
 * A teacher's lessons today from the timetable, in order, with each lesson register's state when the school
 * takes lesson registers. Nothing shows on a day without lessons.
 */
async function TeacherLessons({
  ctx,
  today,
  term,
}: {
  ctx: TenantContext;
  today: string;
  term: TermOption | null;
}) {
  if (!term?.isCurrent) return null;
  const timetable = await getTeacherTimetable(db(), ctx, term.id);
  const weekday = isoWeekday(today);
  const order = new Map(timetable?.periods.map((p, i) => [p.id, i]) ?? []);
  const lessons = (timetable?.lessons ?? [])
    .filter((l) => l.weekday === weekday)
    .sort((a, b) => (order.get(a.periodId) ?? 0) - (order.get(b.periodId) ?? 0));
  if (!timetable || lessons.length === 0) return null;
  const day = allowed(ctx, "attendance.take") ? await listLessonRegisters(db(), ctx, today) : null;
  if (day && (!day.term || day.term.holiday)) return null;
  const slug = ctx.tenant.slug;
  return (
    <Section
      title="Your lessons today"
      description={`${formatCalendarDate(today)}. ${lessons.length} ${lessons.length === 1 ? "lesson" : "lessons"}.`}
      aside={
        <Link href={schoolPath(slug, "timetable") as Route} className="text-sm text-accent hover:underline">
          Timetable
        </Link>
      }
    >
      <TableFrame>
        <Table>
          <caption className="sr-only">Your lessons today</caption>
          <THead>
            <tr>
              <TH>Time</TH>
              <TH>Lesson</TH>
              {day?.enabled && <TH>Register</TH>}
            </tr>
          </THead>
          <TBody>
            {lessons.map((l) => {
              const period = timetable.periods.find((p) => p.id === l.periodId);
              const register = day?.lessons.find(
                (x) => x.lesson.classId === l.classId && x.lesson.periodId === l.periodId,
              );
              return (
                <TR key={l.id}>
                  <TD className="tabular-nums">
                    {period?.startsAt}–{period?.endsAt}
                    <span className="block text-sm text-ink-3">{period?.name}</span>
                  </TD>
                  <TD>
                    <span className="font-medium text-ink">{l.subjectName}</span>
                    <span className="block text-sm text-ink-3">{l.className}</span>
                  </TD>
                  {day?.enabled && (
                    <TD>
                      <a
                        href={`${schoolPath(slug, `attendance/${l.classId}/lessons/${l.periodId}`)}?date=${today}`}
                        className="text-accent hover:underline"
                      >
                        {!register?.register
                          ? "Take the register"
                          : register.register.marked < register.students
                            ? `${register.register.marked} of ${register.students} marked`
                            : "Taken"}
                      </a>
                    </TD>
                  )}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableFrame>
    </Section>
  );
}

/** A class teacher's day: their classes' registers today and how far marks have got this term. */
async function TeacherClasses({
  ctx,
  today,
  term,
}: {
  ctx: TenantContext;
  today: string;
  term: TermOption | null;
}) {
  const slug = ctx.tenant.slug;
  const current = term?.isCurrent ? term : null;
  const [registers, marks] = await Promise.all([
    listRegisters(db(), ctx, today),
    current && allowed(ctx, "assessment.enter") ? listAssessmentClasses(db(), ctx, current.id) : null,
  ]);
  const ids = [
    ...new Set([...registers.classes.map((c) => c.cls.id), ...(marks?.classes.map((c) => c.cls.id) ?? [])]),
  ];
  return (
    <Section
      title="Your classes"
      description={`${formatCalendarDate(today)}${registers.term ? ` · ${registers.term.name}` : ""}`}
    >
      {ids.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title="No classes yet"
          description="Registers are for the classes you are class teacher of, and marks also for the subjects you teach. Ask the head teacher to assign you a class or subject."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Your classes today</caption>
            <THead>
              <tr>
                <TH>Class</TH>
                <TH>Today&apos;s register</TH>
                <TH className="hidden sm:table-cell">Marks this term</TH>
              </tr>
            </THead>
            <TBody>
              {ids.map((id) => {
                const reg = registers.classes.find((c) => c.cls.id === id);
                const mark = marks?.classes.find((c) => c.cls.id === id);
                const name = reg?.cls.name ?? mark?.cls.name ?? "";
                return (
                  <TR key={id}>
                    <TD>
                      <span className="font-medium text-ink">{name}</span>
                      {reg && <span className="block text-sm text-ink-3">{reg.students} students</span>}
                    </TD>
                    <TD>
                      {!registers.term ? (
                        <span className="text-ink-3">Not a school day</span>
                      ) : !reg ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        <a
                          href={`${schoolPath(slug, `attendance/${id}`)}?date=${today}`}
                          className="text-accent hover:underline"
                        >
                          {!reg.register
                            ? "Take the register"
                            : reg.register.marked < reg.students
                              ? `${reg.register.marked} of ${reg.students} marked`
                              : "Taken"}
                        </a>
                      )}
                    </TD>
                    <TD className="hidden sm:table-cell">
                      {!mark || mark.subjects === 0 ? (
                        <span className="text-ink-3">—</span>
                      ) : (
                        <Link
                          href={
                            `${schoolPath(slug, `assessment/${id}`)}${termQuery(marks!.term.id)}` as Route
                          }
                          className="text-accent hover:underline"
                        >
                          {mark.completeSheets} of {mark.subjects} subjects complete
                        </Link>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
