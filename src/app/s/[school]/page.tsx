import type { Metadata, Route } from "next";
import Link from "next/link";
import { CalendarDays, Wallet } from "lucide-react";
import { Aging } from "@/components/overview/aging";
import { Figures } from "@/components/overview/figures";
import { WeeklyCollections } from "@/components/overview/weekly-collections";
import { TermPicker } from "@/components/term-picker";
import { Badge, StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { DescriptionList, EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getCurrentTerm } from "@/server/academics/calendar";
import { pendingMove } from "@/server/academics/term-move";
import { seesAllClasses } from "@/server/assessment/access";
import { listAssessmentClasses } from "@/server/assessment/scores";
import { listRegisters } from "@/server/attendance/registers";
import { allowed, ROLE_LABELS, ROLES } from "@/server/authz/permissions";
import { getOwedToday, getTermFinance } from "@/server/dashboard/finance";
import { getAttendanceOverview, getEnrolment } from "@/server/dashboard/school";
import { db } from "@/server/db/client";
import { METHOD_LABELS } from "@/server/fees/payments";
import { getSetupProgress } from "@/server/setup/progress";
import { countMembersByRole, type TenantContext } from "@/server/tenancy/service";
import { percent } from "@/lib/dashboard";
import { countryName, formatCalendarDate, todayIn } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { STEP_INFO } from "@/web/setup-steps";
import { chooseTerm, termQuery, type TermOption } from "@/web/terms";

export const metadata: Metadata = { title: "Overview" };

const shortDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GH", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
const span = (from: string, to: string) =>
  from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
const rate = (value: number | null) => (value === null ? "—" : `${value}%`);

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { user, ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const { terms, term } = await chooseTerm(ctx, search.term);
  const lead = seesAllClasses(ctx);
  const teacherOnly = allowed(ctx, "attendance.take") && !lead;
  const firstName = user.name.split(" ")[0] ?? user.name;

  const [setup, finance, owed, enrolment, attendance, assessment, counts, currentTerm] = await Promise.all([
    getSetupProgress(db(), ctx),
    allowed(ctx, "fees.view") && term ? getTermFinance(db(), ctx, term.id) : null,
    allowed(ctx, "fees.view") ? getOwedToday(db(), ctx) : null,
    allowed(ctx, "students.view_all") && term ? getEnrolment(db(), ctx, term.id) : null,
    term ? getAttendanceOverview(db(), ctx, term.id, today) : null,
    lead && allowed(ctx, "assessment.enter") && term ? listAssessmentClasses(db(), ctx, term.id) : null,
    allowed(ctx, "members.view") ? countMembersByRole(db(), ctx) : null,
    getCurrentTerm(db(), ctx),
  ]);
  const move =
    allowed(ctx, "academics.manage") && ctx.campusIds === null ? await pendingMove(db(), ctx) : null;

  return (
    <div className="space-y-12">
      <PageHeader
        eyebrow={`Welcome, ${firstName}`}
        title={ctx.tenant.name}
        description={term ? `School overview for ${term.label}.` : "School overview"}
        actions={
          terms.length > 1 && term && !teacherOnly ? (
            <TermPicker terms={terms} termId={term.id} id="overview-term" />
          ) : null
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
              <Figures
                items={[
                  {
                    label: "Billed for the term",
                    value: formatCedis(finance.billedPesewas),
                    href: `${schoolPath(slug, "fees")}${termQuery(finance.term.id)}`,
                    note: "Charges less discounts",
                  },
                  {
                    label: "Collected",
                    value: formatCedis(finance.collected?.totalPesewas ?? 0),
                    href: `${schoolPath(slug, "fees/payments")}?from=${finance.period.from}&to=${finance.period.to}`,
                    note: `${finance.collected?.count ?? 0} payments, ${span(finance.period.from, finance.period.to)}`,
                  },
                  {
                    label: "Collection rate",
                    value: rate(finance.collectionRate),
                    note:
                      finance.collectionRateBasis === "billed"
                        ? "Of this term's fees"
                        : `Of ${formatCedis(finance.owedAtStartPesewas)} owed at the start plus the term's fees`,
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
                        : `Paid ${formatCedis(finance.reminders.paidPesewas)} within a week`,
                  },
                ]}
              />
              <div className="grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <div className="space-y-3">
                  <h3 className="text-base font-semibold text-ink">Collected each week</h3>
                  <WeeklyCollections
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
                              {formatCedis(m.totalPesewas)}
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
                  {formatCedis(owed.totalPesewas)}
                </Link>
                <p className="mt-1 text-sm text-ink-3">
                  Owed by {owed.students} {owed.students === 1 ? "student" : "students"}
                </p>
              </div>
              <Aging buckets={owed.buckets} totalPesewas={owed.totalPesewas} />
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
              <Figures
                items={[
                  {
                    label: "Attendance this term",
                    value: rate(attendance.rate),
                    note: `${attendance.totals.absent + attendance.totals.excused} days absent in all`,
                  },
                  attendance.today
                    ? {
                        label: "Today's registers",
                        value: `${attendance.today.taken} of ${attendance.today.classes}`,
                        href: schoolPath(slug, "attendance"),
                        note:
                          attendance.today.taken === attendance.today.classes
                            ? "All taken"
                            : "Classes taken so far",
                      }
                    : { label: "Today's registers", value: "—", note: "Today is not in this term" },
                  {
                    label: `Below ${attendance.concernPercent}% attendance`,
                    value: String(attendance.concernCount),
                    note: `Students on ${attendance.concernMinDays} or more registers`,
                  },
                  { label: "Classes", value: String(attendance.classes.length) },
                ]}
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
              <Figures
                items={[
                  { label: "In classes", value: String(enrolment.total), href: schoolPath(slug, "students") },
                  { label: "Girls", value: String(enrolment.female) },
                  { label: "Boys", value: String(enrolment.male) },
                  {
                    label: "Levels",
                    value: String(enrolment.levels.length),
                    href: schoolPath(slug, "classes"),
                  },
                ]}
              />
              <TableFrame>
                <Table>
                  <caption className="sr-only">
                    Students in classes by level{enrolment.campuses.length > 1 ? " and campus" : ""}
                  </caption>
                  <THead>
                    <tr>
                      <TH>Level</TH>
                      {enrolment.campuses.length > 1 &&
                        enrolment.campuses.map((c) => (
                          <TH key={c.id} className="text-right">
                            {c.name}
                          </TH>
                        ))}
                      <TH className="text-right">Students</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {enrolment.levels.map((l) => (
                      <TR key={l.id}>
                        <TD className="font-medium text-ink">{l.name}</TD>
                        {enrolment.campuses.length > 1 &&
                          enrolment.campuses.map((c) => (
                            <TD key={c.id} className="text-right tabular-nums">
                              {l.byCampus[c.id] ?? 0}
                            </TD>
                          ))}
                        <TD className="text-right tabular-nums">{l.total}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            </div>
          )}
        </Section>
      )}

      {counts && (
        <Section
          title="People"
          description="Active members of this school by role."
          aside={
            <Link
              href={schoolPath(slug, "members")}
              className="text-sm font-medium text-accent hover:underline"
            >
              View members
            </Link>
          }
        >
          <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-7">
            {ROLES.map((role) => (
              <div
                key={role}
                className="border-line py-4 pr-4 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:pl-4"
              >
                <dt className="text-sm text-ink-3">{ROLE_LABELS[role]}s</dt>
                <dd className="tabular mt-1 font-display text-xl text-ink">{counts[role]}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="School details">
        <DescriptionList
          items={[
            {
              term: "Current term",
              detail: currentTerm ? (
                `${currentTerm.name}, ${currentTerm.yearName} · ${formatCalendarDate(currentTerm.startsOn)} – ${formatCalendarDate(currentTerm.endsOn)}`
              ) : (
                <span className="text-ink-3">Not set</span>
              ),
            },
            { term: "Country", detail: countryName(ctx.tenant.countryCode) },
            { term: "Time zone", detail: ctx.tenant.timezone.replace("_", " ") },
            { term: "Currency", detail: ctx.tenant.currencyCode },
            {
              term: "Your roles",
              detail: (
                <span className="flex flex-wrap gap-1.5">
                  {ctx.roles.map((role) => (
                    <Badge key={role}>{ROLE_LABELS[role]}</Badge>
                  ))}
                </span>
              ),
            },
          ]}
        />
      </Section>
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
      <Figures
        items={[
          { label: "Classes with every mark", value: `${complete} of ${classes.length}` },
          { label: "Report cards published", value: `${published} of ${students}` },
        ]}
        className="lg:grid-cols-2"
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
          description="Registers and marks are for the classes you are class teacher of. Ask the head teacher to assign you a class."
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
