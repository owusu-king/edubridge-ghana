import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getStaffPay } from "@/server/payroll/service";
import { formatDateTime, todayIn } from "@/lib/format";
import { currencySymbol, minorToInput, moneyFormatter } from "@/lib/money";
import { formatBasisPoints } from "@/lib/payroll";
import { monthLabel } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { addAdjustmentAction, cancelAdjustmentAction, setSalaryAction } from "../../actions";
import { AdjustmentDialog, SetSalaryDialog } from "../../payroll-controls";

export const metadata: Metadata = { title: "Salary" };

const STATE = { waiting: "Waiting", paid: "Paid", cancelled: "Cancelled" } as const;

/** One person's salary history and adjustments (PRL-01b, PRL-02b). */
export default async function StaffPayPage({
  params,
}: {
  params: Promise<{ school: string; staffId: string }>;
}) {
  const { school, staffId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "payroll.view")) notFound();
  let pay;
  try {
    pay = await getStaffPay(db(), ctx, staffId);
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const money = moneyFormatter(currency);
  const tz = ctx.tenant.timezone;
  const thisMonth = todayIn(tz).slice(0, 7);
  const next = (() => {
    if (!pay.approvedThrough || pay.approvedThrough < thisMonth) return thisMonth;
    const [y, m] = pay.approvedThrough.split("-").map(Number) as [number, number];
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  })();
  const current = pay.salaries[0];
  const canManage = allowed(ctx, "payroll.manage");
  const fields = pay.components
    .filter((c) => !c.archived)
    .map((c) => {
      const value = current?.components.find((x) => x.componentId === c.id)?.value;
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        basis: c.basis,
        current:
          value === undefined
            ? ""
            : c.basis === "fixed"
              ? minorToInput(value, currency)
              : String(value / 100),
      };
    });

  return (
    <div className="space-y-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href={schoolPath(slug, "payroll/people")}
            className="text-sm font-medium text-accent hover:underline"
          >
            All salaries
          </Link>
          <h2 className="mt-2 text-xl font-semibold text-ink">{pay.name}</h2>
          <p className="text-base text-ink-3">{pay.staffNumber}</p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <SetSalaryDialog
              action={setSalaryAction.bind(
                null,
                slug,
                staffId,
                fields.map((f) => f.id),
              )}
              components={fields}
              month={next}
              basic={current ? minorToInput(current.basicMinor, currency) : ""}
              currencySymbol={currencySymbol(currency)}
            />
            <AdjustmentDialog
              action={addAdjustmentAction.bind(null, slug, staffId)}
              month={next}
              currencySymbol={currencySymbol(currency)}
            />
          </div>
        )}
      </div>

      <Section
        title="Salary"
        description={
          pay.approvedThrough
            ? `Payroll is approved up to ${monthLabel(pay.approvedThrough)}: a new salary starts after it.`
            : "A new salary applies from the month chosen."
        }
      >
        {pay.salaries.length === 0 ? (
          <p className="text-base text-ink-3">No salary yet, so this person is left off payroll.</p>
        ) : (
          <ol className="divide-y divide-line border-y border-line">
            {pay.salaries.map((s, i) => (
              <li key={s.id} className="py-3">
                <p className="text-base text-ink">
                  From {monthLabel(s.effectiveMonth)}: basic {money(s.basicMinor)} a month
                  {i === 0 && <span className="ml-2 text-sm text-ink-3">(latest)</span>}
                </p>
                {s.components.length > 0 && (
                  <p className="text-sm text-ink-2">
                    {s.components
                      .map(
                        (c) =>
                          `${c.name} ${c.basis === "fixed" ? money(c.value) : formatBasisPoints(c.value)}`,
                      )
                      .join(" · ")}
                  </p>
                )}
                {s.note && <p className="text-sm text-ink-2">{s.note}</p>}
                <p className="text-sm text-ink-3">
                  Set by {s.createdBy}, {formatDateTime(s.createdAt, tz)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section
        title="Adjustments"
        description="One-off amounts, paid once in the first approved month that includes them."
      >
        {pay.adjustments.length === 0 ? (
          <p className="text-base text-ink-3">None.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Adjustments for {pay.name}</caption>
              <THead>
                <tr>
                  <TH>What</TH>
                  <TH>Month</TH>
                  <TH numeric>Amount</TH>
                  <TH>Status</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {pay.adjustments.map((a) => (
                  <TR key={a.id}>
                    <TD>{a.description}</TD>
                    <TD>{monthLabel(a.month)}</TD>
                    <TD numeric>{(a.kind === "deduction" ? "−" : "") + money(a.amount)}</TD>
                    <TD>
                      <StatusText
                        tone={a.state === "paid" ? "positive" : a.state === "waiting" ? "caution" : "neutral"}
                      >
                        {STATE[a.state]}
                      </StatusText>
                      {a.paidIn && (
                        <span className="block text-sm text-ink-3">in {monthLabel(a.paidIn)}</span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {a.state === "waiting" && canManage && (
                        <ActionButton
                          action={cancelAdjustmentAction.bind(null, slug, a.id)}
                          label="Cancel"
                          ariaLabel={`Cancel ${a.description}`}
                        />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
    </div>
  );
}
