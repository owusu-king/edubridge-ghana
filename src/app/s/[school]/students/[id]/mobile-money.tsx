import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { NETWORK_LABELS } from "@/lib/mobile-money";
import { formatCedis } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import type { MobileMoneyRequestRow, MobileMoneyRequestStatus } from "@/server/mobile-money/requests";
import { checkMobileMoneyAction } from "./account-actions";
import { CheckStatusButton } from "./mobile-money-controls";

const STATUS: Record<MobileMoneyRequestStatus, { label: string; className: string }> = {
  pending: { label: "Waiting for the payer to approve", className: "text-ink" },
  expired: { label: "No answer yet", className: "text-ink-3" },
  successful: { label: "Paid", className: "text-positive" },
  failed: { label: "Not paid", className: "text-ink-3" },
  needs_review: {
    label: "Check the school's Mobile Money statement",
    className: "font-medium text-critical",
  },
};

/** A student's recent Mobile Money prompts and their outcomes. */
export function MobileMoneyRequests({
  slug,
  studentId,
  requests,
  timeZone,
  canCheck,
}: {
  slug: string;
  studentId: string;
  requests: MobileMoneyRequestRow[];
  timeZone: string;
  canCheck: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-sm font-medium text-ink">Mobile Money requests</h3>
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
        {requests.map((r) => {
          const status = STATUS[r.status];
          return (
            <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <p className="text-base text-ink">
                  <span className="font-medium tabular-nums">{formatCedis(r.amountPesewas)}</span>
                  <span className="text-ink-3">
                    {" "}
                    · {NETWORK_LABELS[r.network]} {formatPhone(r.msisdn)}
                  </span>
                </p>
                <p className={`text-sm ${status.className}`}>
                  {status.label}
                  {r.status === "successful" && r.paymentId && r.receiptNumber && (
                    <>
                      {", receipt "}
                      <Link
                        href={schoolPath(slug, `fees/receipts/${r.paymentId}`)}
                        className="text-accent hover:underline"
                      >
                        {r.receiptNumber}
                      </Link>
                    </>
                  )}
                  {r.statusReason && <span className="text-ink-2">: {r.statusReason}</span>}
                </p>
                <p className="text-sm text-ink-3">
                  {formatDateTime(r.createdAt, timeZone)}
                  {r.requestedBy && ` by ${r.requestedBy}`}
                  {r.testMode && " · Test mode"}
                </p>
              </div>
              {canCheck && (r.status === "pending" || r.status === "expired") && (
                <CheckStatusButton
                  action={checkMobileMoneyAction.bind(null, slug, studentId, r.id)}
                  label={`Check status of the ${formatCedis(r.amountPesewas)} request`}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
