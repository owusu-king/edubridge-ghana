import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { PaymentPlan } from "@/server/fees/payment-plans";
import type { InstalmentStatus } from "@/server/fees/plan-schedule";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { cancelPaymentPlanAction } from "./account-actions";
import { CancelPlanButton } from "./account-controls";

const STATUS: Record<InstalmentStatus, { label: string; className: string }> = {
  paid: { label: "Paid", className: "text-positive" },
  partly_paid: { label: "Part paid", className: "text-ink" },
  overdue: { label: "Overdue", className: "text-critical font-medium" },
  upcoming: { label: "Upcoming", className: "text-ink-3" },
};

/** The family's instalment plan and how payments recorded since it was agreed cover it. */
export function PaymentPlanView({
  slug,
  studentId,
  plan,
  canManage,
}: {
  slug: string;
  studentId: string;
  plan: PaymentPlan;
  canManage: boolean;
}) {
  const p = plan.progress;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">
          Payment plan: {formatCedis(plan.totalPesewas)} from {formatCalendarDate(plan.startsOn)}
        </h3>
        {canManage && (
          <CancelPlanButton action={cancelPaymentPlanAction.bind(null, slug, studentId, plan.id)} />
        )}
      </div>
      <p className="text-sm text-ink-2">
        {formatCedis(p.paidPesewas)} paid towards it, {formatCedis(p.remainingPesewas)} to go
        {p.overduePesewas > 0 && (
          <span className="font-medium text-critical">, {formatCedis(p.overduePesewas)} overdue</span>
        )}
        .
      </p>
      <TableFrame>
        <Table>
          <caption className="sr-only">Payment plan instalments</caption>
          <THead>
            <tr>
              <TH>Due</TH>
              <TH className="text-right">Amount</TH>
              <TH className="hidden text-right sm:table-cell">Paid</TH>
              <TH>Status</TH>
            </tr>
          </THead>
          <TBody>
            {p.instalments.map((i) => (
              <TR key={i.sequence}>
                <TD className="whitespace-nowrap">{formatCalendarDate(i.dueOn)}</TD>
                <TD className="text-right tabular-nums">{formatCedis(i.amountPesewas)}</TD>
                <TD className="hidden text-right tabular-nums sm:table-cell">{formatCedis(i.paidPesewas)}</TD>
                <TD className={STATUS[i.status].className}>{STATUS[i.status].label}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
    </div>
  );
}
