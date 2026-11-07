import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight, FileDown } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { BalanceFigure, ChildFacts } from "@/components/parents/balance";
import { SchoolContacts } from "@/components/parents/school-contacts";
import { MoveSchoolForm } from "@/components/parents/transfer-forms";
import { startTransferAction } from "../../transfer-actions";
import { db } from "@/server/db/client";
import { METHOD_LABELS } from "@/server/fees/payments";
import type { InstalmentStatus } from "@/server/fees/plan-schedule";
import { getParentChild } from "@/server/parents/portal";
import { listTransferSchools } from "@/server/passport/transfers";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { attendanceRate, attended, STATUS_LABELS } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { requireParent } from "@/web/parent-auth";

export const metadata: Metadata = { title: "Fees and reports" };

const INSTALMENT: Record<
  InstalmentStatus,
  { label: string; tone: "positive" | "caution" | "critical" | "neutral" }
> = {
  paid: { label: "Paid", tone: "positive" },
  partly_paid: { label: "Part paid", tone: "caution" },
  overdue: { label: "Overdue", tone: "critical" },
  upcoming: { label: "Upcoming", tone: "neutral" },
};

/**
 * One child's fees (PRT-02 to PRT-04): balance, plan, receipts and the same statement the accountant sees;
 * and the child's published report cards.
 */
export default async function ParentChildPage({
  params,
}: {
  params: Promise<{ school: string; student: string }>;
}) {
  const { school: slug, student: studentId } = await params;
  const { phone } = await requireParent();
  const child = await getParentChild(db(), phone, slug, studentId);
  if (!child) notFound();
  const { summary, account, plan } = child;
  const base = `/p/${slug}/${studentId}`;
  const entries = [...account.entries].reverse();

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={"/p" as Route}
          className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Your children
        </Link>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">{summary.name}</h1>
        <p className="mt-1 text-sm text-ink-3">
          {[child.school.name, summary.className, `Admission no. ${child.admissionNumber}`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <section
        aria-label="Balance"
        className="rounded-lg border border-line bg-surface px-5 py-5 shadow-raised"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3">
            <p className="text-sm text-ink-3">
              School fees as of {formatCalendarDate(todayIn(child.school.timezone))}
            </p>
            <ChildFacts child={summary} />
          </div>
          <BalanceFigure pesewas={summary.balancePesewas} size="lg" />
        </div>
        <a
          href={`${base}/statement`}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-base font-medium text-ink hover:bg-subtle"
        >
          <FileDown aria-hidden="true" className="size-4" />
          Download statement (PDF)
        </a>
      </section>

      {plan && (
        <section aria-labelledby="plan" className="space-y-3">
          <div>
            <h2 id="plan" className="text-md font-semibold text-ink">
              Payment plan
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">
              {formatCedis(plan.totalPesewas)} in {plan.progress.instalments.length} instalments ·{" "}
              {formatCedis(plan.progress.remainingPesewas)} left to pay
            </p>
          </div>
          <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
            {plan.progress.instalments.map((inst) => (
              <li key={inst.sequence} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-base text-ink tabular-nums">{formatCedis(inst.amountPesewas)}</p>
                  <p className="text-sm text-ink-3">By {formatCalendarDate(inst.dueOn)}</p>
                </div>
                <StatusText tone={INSTALMENT[inst.status].tone}>{INSTALMENT[inst.status].label}</StatusText>
              </li>
            ))}
          </ol>
        </section>
      )}

      {child.attendance && (
        <section aria-labelledby="attendance" className="space-y-3">
          <div>
            <h2 id="attendance" className="text-md font-semibold text-ink">
              Attendance
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">{child.attendance.termName}, from the class register</p>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-4">
            <p className="text-base text-ink">
              <span className="font-medium tabular-nums">
                {attended(child.attendance.totals)} of {child.attendance.totals.open}
              </span>{" "}
              days at school ({attendanceRate(child.attendance.totals)}%)
            </p>
            <p className="mt-1 text-sm text-ink-3">
              {[
                child.attendance.totals.late && `${child.attendance.totals.late} late`,
                child.attendance.totals.absent && `${child.attendance.totals.absent} absent`,
                child.attendance.totals.excused && `${child.attendance.totals.excused} excused`,
              ]
                .filter(Boolean)
                .join(" · ") || "Not late or absent this term."}
            </p>
            {child.attendance.recent.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line">
                {child.attendance.recent.map((day) => (
                  <li key={day.date} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="text-ink">{formatCalendarDate(day.date)}</span>
                    <span className="text-ink-2">{STATUS_LABELS[day.status]}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {child.reportCards.length > 0 && (
        <section aria-labelledby="report-cards" className="space-y-3">
          <h2 id="report-cards" className="text-md font-semibold text-ink">
            Report cards
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {child.reportCards.map((r) => (
              <li key={r.id}>
                <Link
                  href={`${base}/report-cards/${r.id}` as Route}
                  className="flex min-h-11 items-center justify-between gap-3 px-4 py-3 hover:bg-subtle focus-visible:bg-subtle"
                >
                  <span className="text-base text-ink">
                    {r.termName}, {r.yearName}
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="payments" className="space-y-3">
        <h2 id="payments" className="text-md font-semibold text-ink">
          Payments and receipts
        </h2>
        {child.payments.length === 0 ? (
          <p className="text-base text-ink-3">No payments recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {child.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-base text-ink">
                    <span className={cn("tabular-nums", p.voided && "text-ink-3 line-through")}>
                      {formatCedis(p.amountPesewas)}
                    </span>
                    {p.voided && <Badge tone="critical">Voided</Badge>}
                  </p>
                  <p className="text-sm text-ink-3">
                    {formatCalendarDate(p.paidOn)} · {METHOD_LABELS[p.method]} · {p.receiptNumber}
                  </p>
                </div>
                <a
                  href={`/p/${slug}/receipts/${p.id}/pdf`}
                  aria-label={`Download receipt ${p.receiptNumber} (PDF)`}
                  className="-mr-2 inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent hover:bg-accent-soft"
                >
                  <FileDown aria-hidden="true" className="size-4" />
                  Receipt
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="statement" className="space-y-3">
        <div>
          <h2 id="statement" className="text-md font-semibold text-ink">
            Statement
          </h2>
          <p className="mt-0.5 text-sm text-ink-3">Newest first, with the balance after each entry.</p>
        </div>
        {entries.length === 0 ? (
          <p className="text-base text-ink-3">Nothing has been charged or paid yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className={cn("text-base text-ink", e.reversed && "text-ink-3 line-through")}>
                    {e.description}
                  </p>
                  <p className="text-sm text-ink-3">{formatCalendarDate(e.effectiveOn)}</p>
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <p className={cn("text-base", e.amountPesewas < 0 ? "text-positive" : "text-ink")}>
                    {e.amountPesewas < 0 ? "−" : ""}
                    {formatCedis(Math.abs(e.amountPesewas))}
                  </p>
                  <p className="text-sm text-ink-3">
                    {e.balancePesewas < 0
                      ? `${formatCedis(-e.balancePesewas)} in credit`
                      : `Balance ${formatCedis(e.balancePesewas)}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {child.contacts && <SchoolContacts contacts={child.contacts} schoolName={child.school.name} />}

      {summary.status === "active" && (
        <section aria-labelledby="move" className="space-y-3">
          <div>
            <h2 id="move" className="text-md font-semibold text-ink">
              Moving to another school
            </h2>
            <p className="text-sm text-ink-3">
              If {summary.firstName} is joining another school on EduBridge, their records can go with them.
            </p>
          </div>
          <MoveSchoolForm
            action={startTransferAction.bind(null, slug, studentId)}
            schools={await listTransferSchools(db(), child.school.id)}
            child={summary.firstName}
          />
        </section>
      )}
    </div>
  );
}
