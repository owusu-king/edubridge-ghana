import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Figures } from "@/components/overview/figures";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import {
  getAttendanceInsights,
  getFinanceInsights,
  getLevelPerformance,
  getOperationsInsights,
  getStudentTrends,
  getTermTrends,
  seesAcademics,
  seesFinance,
} from "@/server/insights/service";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Insights" };

const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const num = (v: number | null) => (v === null ? "—" : String(v));

/** A value with a thin bar out of 100, for comparing rows at a glance (the number is always shown). */
function Bar({ value, tone = "accent" }: { value: number | null; tone?: "accent" | "critical" }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{value}</span>
      <span aria-hidden="true" className="hidden h-1.5 w-20 rounded-full bg-subtle sm:block">
        <span
          className={
            tone === "critical"
              ? "block h-1.5 rounded-full bg-critical"
              : "block h-1.5 rounded-full bg-accent"
          }
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Insights: how the school is doing across terms (results, attendance, money, enrolment), the students to
 * follow up, and the work still outstanding. Descriptive only: counts and averages of the school's records.
 */
export default async function InsightsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "insights.view")) notFound();
  const slug = ctx.tenant.slug;
  const academics = seesAcademics(ctx);
  const finance = seesFinance(ctx);
  const [trends, students, levels, attendance, money, ops] = await Promise.all([
    getTermTrends(db(), ctx),
    getStudentTrends(db(), ctx),
    getLevelPerformance(db(), ctx),
    getAttendanceInsights(db(), ctx),
    getFinanceInsights(db(), ctx),
    getOperationsInsights(db(), ctx),
  ]);
  const studentLink = (id: string, name: string) => (
    <Link href={schoolPath(slug, `students/${id}`) as Route} className="text-accent hover:underline">
      {name}
    </Link>
  );

  return (
    <div className="space-y-12">
      <PageHeader
        title="Insights"
        description="The school term by term, the students to follow up and the work still outstanding. Every figure is counted from the school's records: published report cards, registers, fees and receipts."
      />

      <Section title="Term by term" description="The last six terms that have started.">
        {trends.length === 0 ? (
          <p className="text-base text-ink-2">No terms have started yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Term</TH>
                  <TH numeric>Students (new)</TH>
                  {academics && <TH numeric>Attendance</TH>}
                  {academics && <TH numeric>Late</TH>}
                  {academics && <TH numeric>Average result</TH>}
                  {finance && <TH numeric>Billed</TH>}
                  {finance && <TH numeric>Collected</TH>}
                  {finance && <TH numeric>Collected of billed</TH>}
                </tr>
              </THead>
              <TBody>
                {trends.map((t) => (
                  <TR key={t.termId}>
                    <TD className="whitespace-nowrap text-ink">
                      {t.label}
                      {t.current && <span className="block text-sm text-ink-3">Current term</span>}
                    </TD>
                    <TD numeric>
                      {t.enrolled} ({t.newStudents})
                    </TD>
                    {academics && <TD numeric>{pct(t.attendanceRate)}</TD>}
                    {academics && <TD numeric>{pct(t.latenessRate)}</TD>}
                    {academics && (
                      <TD numeric>
                        <Bar value={t.averageScore} />
                        <span className="block text-xs text-ink-3">{t.publishedCards} report cards</span>
                      </TD>
                    )}
                    {finance && <TD numeric>{formatCedis(t.billedPesewas ?? 0)}</TD>}
                    {finance && <TD numeric>{formatCedis(t.collectedPesewas ?? 0)}</TD>}
                    {finance && <TD numeric>{pct(t.collectionRate)}</TD>}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      {academics && (
        <Section
          title="Students to follow up"
          description="From published report cards: averages that fell by 10 points or more between a student's last two report cards, and latest averages below 50."
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">
                Falling results ({students.declining.length})
              </h3>
              {students.declining.length === 0 ? (
                <p className="text-sm text-ink-3">None.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line">
                  {students.declining.map((s) => (
                    <li key={s.studentId} className="flex justify-between gap-3 py-2 text-sm">
                      <span>
                        {studentLink(s.studentId, s.name)}
                        <span className="block text-ink-3">{s.className ?? "No class this term"}</span>
                      </span>
                      <span className="text-right tabular-nums">
                        {s.previous?.average} → {s.latest.average}
                        <span className="block text-critical">{s.change}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">
                May need support ({students.support.length})
              </h3>
              {students.support.length === 0 ? (
                <p className="text-sm text-ink-3">None.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line">
                  {students.support.map((s) => (
                    <li key={s.studentId} className="flex justify-between gap-3 py-2 text-sm">
                      <span>
                        {studentLink(s.studentId, s.name)}
                        <span className="block text-ink-3">{s.latest.term}</span>
                      </span>
                      <span className="tabular-nums">{s.latest.average}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      )}

      {academics && levels.length > 0 && (
        <Section
          title="Results by level"
          description="Average of report-card averages, and each subject's average total, over the last three terms."
        >
          <div className="space-y-8">
            {levels.map((level) => (
              <TableFrame key={level.levelId}>
                <Table>
                  <caption className="px-5 pt-3 text-left text-base font-semibold text-ink">
                    {level.levelName}
                  </caption>
                  <THead>
                    <tr>
                      <TH>Subject</TH>
                      {level.terms.map((t) => (
                        <TH key={t.termId} numeric>
                          {t.label}
                        </TH>
                      ))}
                    </tr>
                  </THead>
                  <TBody>
                    <TR>
                      <TD className="font-medium text-ink">Overall</TD>
                      {level.terms.map((t) => (
                        <TD key={t.termId} numeric>
                          <Bar value={t.average} />
                        </TD>
                      ))}
                    </TR>
                    {level.subjects.map((s) => (
                      <TR key={s.name}>
                        <TD>{s.name}</TD>
                        {s.averages.map((a, i) => (
                          <TD key={i} numeric>
                            {num(a)}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            ))}
          </div>
        </Section>
      )}

      {academics && attendance.term && (
        <Section title="Attendance" description={`${attendance.term.label}. Late counts as attending.`}>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <TableFrame>
              <Table>
                <THead>
                  <tr>
                    <TH>Class</TH>
                    <TH numeric>Absent</TH>
                    <TH numeric>Late</TH>
                    <TH numeric>Absence rate</TH>
                  </tr>
                </THead>
                <TBody>
                  {attendance.byClass.map((c) => (
                    <TR key={c.classId}>
                      <TD className="text-ink">{c.className}</TD>
                      <TD numeric>{c.absent}</TD>
                      <TD numeric>{c.late}</TD>
                      <TD numeric>
                        <Bar value={c.absenceRate} tone="critical" />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
            <div className="space-y-6">
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-ink">
                  Often absent ({attendance.chronic.length})
                </h3>
                <p className="text-sm text-ink-3">Absent on 10% or more of their registers this term.</p>
                <ul className="space-y-1 text-sm">
                  {attendance.chronic.map((s) => (
                    <li key={s.studentId} className="flex justify-between gap-3">
                      <span>
                        {studentLink(s.studentId, s.name)} <span className="text-ink-3">{s.className}</span>
                      </span>
                      <span className="tabular-nums">
                        {s.absent} of {s.marked}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-ink">
                  Often late ({attendance.lateness.length})
                </h3>
                <p className="text-sm text-ink-3">Late three or more times in the last 30 days.</p>
                <ul className="space-y-1 text-sm">
                  {attendance.lateness.map((s) => (
                    <li key={s.studentId} className="flex justify-between gap-3">
                      <span>
                        {studentLink(s.studentId, s.name)} <span className="text-ink-3">{s.className}</span>
                      </span>
                      <span className="tabular-nums">{s.late} times</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Section>
      )}

      {finance && (
        <Section
          title="Money"
          description={
            money.term
              ? `${money.term.label}, by level: billed this term, collected from those families in the term, and what they owe today.`
              : undefined
          }
        >
          <Figures
            items={[
              {
                label: "Overdue on payment plans",
                value: formatCedis(money.planDue.overduePesewas),
                href: schoolPath(slug, "fees/owing"),
              },
              { label: "Plan instalments due in 30 days", value: formatCedis(money.planDue.next30Pesewas) },
              { label: "Due in 31 to 60 days", value: formatCedis(money.planDue.next60Pesewas) },
              {
                label: "Due in 61 to 90 days",
                value: formatCedis(money.planDue.next90Pesewas),
                note: `${money.planDue.plans} active plans`,
              },
            ]}
          />
          {money.byLevel.length > 0 && (
            <TableFrame>
              <Table>
                <THead>
                  <tr>
                    <TH>Level</TH>
                    <TH numeric>Students</TH>
                    <TH numeric>Billed</TH>
                    <TH numeric>Collected</TH>
                    <TH numeric>Owed today</TH>
                  </tr>
                </THead>
                <TBody>
                  {money.byLevel.map((l) => (
                    <TR key={l.levelName}>
                      <TD className="text-ink">{l.levelName}</TD>
                      <TD numeric>{l.students}</TD>
                      <TD numeric>{formatCedis(l.billedPesewas)}</TD>
                      <TD numeric>{formatCedis(l.collectedPesewas)}</TD>
                      <TD numeric>{formatCedis(l.owedPesewas)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}

      {academics && (
        <Section
          title="Outstanding work"
          description="Registers not taken in the last two weeks of school days, and score sheets not complete this term."
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">
                Registers not taken ({ops.missingRegisters.length} classes)
              </h3>
              {ops.missingRegisters.length === 0 ? (
                <p className="text-sm text-ink-3">Every register has been taken.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line text-sm">
                  {ops.missingRegisters.map((c) => (
                    <li key={c.classId} className="py-2">
                      <span className="font-medium text-ink">{c.className}</span>{" "}
                      <span className="text-ink-3">{c.teacher ?? "No class teacher"}</span>
                      <span className="block text-ink-2">
                        {c.days.length} {c.days.length === 1 ? "day" : "days"}:{" "}
                        {c.days
                          .slice(-5)
                          .map((d) => formatCalendarDate(d))
                          .join(", ")}
                        {c.days.length > 5 ? "…" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-ink">
                Marks not complete ({ops.marksOutstanding.length} classes)
              </h3>
              {ops.marksOutstanding.length === 0 ? (
                <p className="text-sm text-ink-3">Every score sheet is complete.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line text-sm">
                  {ops.marksOutstanding.map((c) => (
                    <li key={c.classId} className="flex justify-between gap-3 py-2">
                      <span>
                        <span className="font-medium text-ink">{c.className}</span>{" "}
                        <span className="text-ink-3">{c.teacher ?? "No class teacher"}</span>
                      </span>
                      <span className="tabular-nums">
                        {c.completeSheets} of {c.subjects} subjects
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
