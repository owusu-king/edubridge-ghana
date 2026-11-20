import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { ActionButton, RequestRefundDialog } from "@/components/fees/finance-forms";
import type { RefundRow } from "@/server/fees/refunds";
import type { StudentFeeOption } from "@/server/fees/structure";
import { formatMoney } from "@/lib/money";
import { requestRefundAction, setFeeOptionAction } from "../../fees/finance-actions";

const REFUND_STATUS: Record<RefundRow["status"], string> = {
  requested: "Waiting for approval",
  approved: "Approved, to pay out",
  rejected: "Rejected",
  paid: "Paid",
  cancelled: "Cancelled",
};

/** On the student page: optional fee items the student takes, and refunds of their credit. */
export function FinanceExtras({
  currency,
  slug,
  studentId,
  balancePesewas,
  options,
  refunds,
  canManage,
  canRefund,
  pendingDiscounts,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  slug: string;
  studentId: string;
  balancePesewas: number;
  options: StudentFeeOption[];
  refunds: RefundRow[];
  canManage: boolean;
  canRefund: boolean;
  pendingDiscounts: number;
}) {
  if (!options.length && !refunds.length && !(canRefund && balancePesewas < 0) && !pendingDiscounts)
    return null;
  return (
    <Section title="Optional items and refunds">
      {pendingDiscounts > 0 && (
        <p className="text-sm text-ink-2">
          {pendingDiscounts} {pendingDiscounts === 1 ? "discount is" : "discounts are"} waiting for the
          Proprietor&apos;s approval (not billed until approved).
        </p>
      )}
      {options.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-ink">Optional items</h3>
          <ul className="divide-y divide-line border-y border-line">
            {options.map((o) => (
              <li key={o.feeItemId} className="flex items-center justify-between gap-3 py-2 text-base">
                <span className="text-ink">
                  {o.name}{" "}
                  <span className="text-sm text-ink-3">
                    {o.takes ? "Takes it: billed each term" : "Does not take it"}
                  </span>
                </span>
                {canManage && (
                  <ActionButton
                    action={setFeeOptionAction.bind(null, slug, studentId, o.feeItemId, !o.takes)}
                    label={o.takes ? "Stop" : "Add"}
                    variant={o.takes ? "danger-outline" : "secondary"}
                    ariaLabel={o.takes ? `Stop ${o.name}` : `Add ${o.name}`}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(refunds.length > 0 || (canRefund && balancePesewas < 0)) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-ink">Refunds</h3>
            {canRefund && balancePesewas < 0 && (
              <RequestRefundDialog
                action={requestRefundAction.bind(null, slug, studentId)}
                credit={formatMoney(-balancePesewas, currency)}
              />
            )}
          </div>
          {refunds.length > 0 && (
            <ul className="divide-y divide-line border-y border-line text-sm">
              {refunds.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 py-2">
                  <span className="text-ink">
                    {formatMoney(r.amountPesewas, currency)}: {r.reason}
                    {r.refundNumber ? ` (${r.refundNumber})` : ""}
                  </span>
                  <StatusText
                    tone={r.status === "paid" ? "positive" : r.status === "rejected" ? "critical" : "neutral"}
                  >
                    {REFUND_STATUS[r.status]}
                  </StatusText>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}
