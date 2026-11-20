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
import { formatCalendarDate, formatDateTime, formatTime, todayIn } from "@/lib/format";
import { RIDE_DIRECTION_LABELS, TRIP_DIRECTION_LABELS } from "@/lib/transport";
import { moneyFormatter } from "@/lib/money";
import { attendanceRate, attended, STATUS_LABELS } from "@/lib/attendance";
import { cn } from "@/lib/cn";
import { requireParent } from "@/web/parent-auth";
import { StatementRangeForm } from "@/components/fees/statement-range";
import { CheckPaymentButton, PayOnlineForm } from "@/components/parents/pay-forms";
import { checkPaymentAction, payOnlineAction } from "../../payment-actions";
import {
  listParentPaymentAttempts,
  parentPaymentSetup,
  type MobileMoneyRequestStatus,
} from "@/server/mobile-money/requests";
import { formatPhone, maskPhone } from "@/lib/phone";

export const metadata: Metadata = { title: "Fees and reports" };

const ATTEMPT: Record<
  MobileMoneyRequestStatus,
  { label: string; tone: "positive" | "caution" | "critical" | "neutral" }
> = {
  pending: { label: "Waiting for approval", tone: "caution" },
  expired: { label: "Not approved in time", tone: "neutral" },
  successful: { label: "Paid", tone: "positive" },
  failed: { label: "Did not go through", tone: "critical" },
  needs_review: { label: "Being checked by the school", tone: "caution" },
};

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
  const showMoney = moneyFormatter(child.school.currencyCode);
  const [setup, attempts] = await Promise.all([
    parentPaymentSetup(db(), child.school),
    listParentPaymentAttempts(db(), phone, slug, studentId),
  ]);
  const canPay = setup.enabled && child.summary.balancePesewas > 0 && child.summary.status !== "transferred";
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
        <h1 className="mt-2 flex items-center gap-3 font-display text-2xl font-medium tracking-tight">
          {child.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- the school's own logo
            <img src={child.logoUrl} alt="" className="size-10 shrink-0 rounded-md object-contain" />
          )}
          {summary.name}
        </h1>
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
            <ChildFacts currency={child.school.currencyCode} child={summary} />
          </div>
          <BalanceFigure currency={child.school.currencyCode} pesewas={summary.balancePesewas} size="lg" />
        </div>
        <a
          href={`${base}/statement`}
          className="mt-5 inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-base font-medium text-ink hover:bg-subtle"
        >
          <FileDown aria-hidden="true" className="size-4" />
          Download statement (PDF)
        </a>
        <div className="mt-2 -ml-3.5">
          <StatementRangeForm href={`${base}/statement`} today={todayIn(child.school.timezone)} />
        </div>
      </section>

      {(canPay || (attempts?.length ?? 0) > 0) && (
        <section aria-labelledby="pay" className="space-y-3">
          <div>
            <h2 id="pay" className="text-md font-semibold text-ink">
              Pay by Mobile Money
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">
              Pay all or part of the balance. You approve it on your phone; the receipt appears below.
            </p>
          </div>
          {canPay && (
            <div className="rounded-lg border border-line bg-surface px-4 py-4">
              <PayOnlineForm
                currency={child.school.currencyCode}
                action={payOnlineAction.bind(null, slug, studentId)}
                defaultAmount={(child.summary.balancePesewas / 100).toFixed(2)}
                phone={formatPhone(phone)}
                testMode={setup.testMode}
                testHint={setup.testHint}
                networks={setup.networks}
              />
            </div>
          )}
          {attempts && attempts.length > 0 && (
            <ul
              aria-label="Recent online payments"
              className="divide-y divide-line rounded-lg border border-line bg-surface"
            >
              {attempts.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-base text-ink">
                      <span className="tabular-nums">{showMoney(a.amountPesewas)}</span>
                      <StatusText tone={ATTEMPT[a.status].tone}>{ATTEMPT[a.status].label}</StatusText>
                    </p>
                    <p className="text-sm text-ink-3">
                      {formatDateTime(a.createdAt, child.school.timezone)} · {maskPhone(a.msisdn)}
                      {a.receiptNumber ? ` · ${a.receiptNumber}` : ""}
                      {a.family ? ` · part of a family payment of ${showMoney(a.totalPesewas)}` : ""}
                    </p>
                    {a.status === "failed" && a.statusReason && (
                      <p className="text-sm text-ink-3">{a.statusReason}</p>
                    )}
                  </div>
                  {(a.status === "pending" || a.status === "expired") && (
                    <CheckPaymentButton action={checkPaymentAction.bind(null, slug, studentId, a.id)} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {plan && (
        <section aria-labelledby="plan" className="space-y-3">
          <div>
            <h2 id="plan" className="text-md font-semibold text-ink">
              Payment plan
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">
              {showMoney(plan.totalPesewas)} in {plan.progress.instalments.length} instalments ·{" "}
              {showMoney(plan.progress.remainingPesewas)} left to pay
            </p>
          </div>
          <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
            {plan.progress.instalments.map((inst) => (
              <li key={inst.sequence} className="flex items-center justify-between gap-4 px-4 py-3">
                <div>
                  <p className="text-base text-ink tabular-nums">{showMoney(inst.amountPesewas)}</p>
                  <p className="text-sm text-ink-3">By {formatCalendarDate(inst.dueOn)}</p>
                </div>
                <StatusText tone={INSTALMENT[inst.status].tone}>{INSTALMENT[inst.status].label}</StatusText>
              </li>
            ))}
          </ol>
        </section>
      )}

      {child.transport && (
        <section aria-labelledby="school-bus" className="space-y-3">
          <div>
            <h2 id="school-bus" className="text-md font-semibold text-ink">
              School bus
            </h2>
            <p className="mt-0.5 text-sm text-ink-3">
              {child.transport.route} · {RIDE_DIRECTION_LABELS[child.transport.ride].toLowerCase()}
            </p>
          </div>
          <div className="rounded-lg border border-line bg-surface px-4 py-4">
            <p className="text-base text-ink">{child.transport.stop}</p>
            <p className="mt-1 text-sm text-ink-3">
              {[
                child.transport.ride !== "from_school" &&
                  child.transport.morningTime &&
                  `Morning about ${child.transport.morningTime}`,
                child.transport.ride !== "to_school" &&
                  child.transport.afternoonTime &&
                  `afternoon about ${child.transport.afternoonTime}`,
              ]
                .filter(Boolean)
                .join(", ") || "Ask the school for the times."}
            </p>
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {child.transport.today.length === 0 ? (
                <li className="py-2 text-sm text-ink-3">Not on the bus yet today.</li>
              ) : (
                child.transport.today.map((t) => (
                  <li key={t.direction} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="text-ink">{TRIP_DIRECTION_LABELS[t.direction]}</span>
                    <span className="text-right text-ink-2">
                      On the bus {formatTime(t.boardedAt, child.school.timezone)}
                      {t.leftAt
                        ? `, ${t.direction === "to_school" ? "at school" : "got off"} ${formatTime(t.leftAt, child.school.timezone)}`
                        : ""}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>
      )}

      {child.boarding && (
        <section aria-labelledby="boarding" className="space-y-3">
          <h2 id="boarding" className="text-md font-semibold text-ink">
            Boarding
          </h2>
          <div className="rounded-lg border border-line bg-surface px-4 py-4">
            <p className="text-base text-ink">{child.boarding.house}</p>
            <p className="mt-1 text-sm text-ink-3">
              {child.boarding.room}, {child.boarding.bed}
            </p>
            {child.boarding.exeat && (
              <p className="mt-3 border-t border-line pt-3 text-sm text-ink-2">
                Out on exeat since {formatDateTime(child.boarding.exeat.outAt, child.school.timezone)}, due
                back {formatCalendarDate(child.boarding.exeat.expectedBackOn)}.
              </p>
            )}
          </div>
        </section>
      )}

      {child.libraryBooks && child.libraryBooks.length > 0 && (
        <section aria-labelledby="library-books" className="space-y-3">
          <h2 id="library-books" className="text-md font-semibold text-ink">
            Library books
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {child.libraryBooks.map((b) => (
              <li key={`${b.title}-${b.dueOn}`} className="flex justify-between gap-3 px-4 py-3 text-sm">
                <span className="text-ink">{b.title}</span>
                <span className={b.daysLate > 0 ? "text-critical" : "text-ink-2"}>
                  {b.daysLate > 0
                    ? `${b.daysLate} ${b.daysLate === 1 ? "day" : "days"} late`
                    : `Due ${formatCalendarDate(b.dueOn)}`}
                </span>
              </li>
            ))}
          </ul>
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
                      {showMoney(p.amountPesewas)}
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
                    {showMoney(Math.abs(e.amountPesewas))}
                  </p>
                  <p className="text-sm text-ink-3">
                    {e.balancePesewas < 0
                      ? `${showMoney(-e.balancePesewas)} in credit`
                      : `Balance ${showMoney(e.balancePesewas)}`}
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
