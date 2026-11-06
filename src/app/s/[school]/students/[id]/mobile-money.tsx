import { MobileMoneyStatus } from "@/components/fees/mobile-money-status";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { formatDateTime } from "@/lib/format";
import { NETWORK_LABELS } from "@/lib/mobile-money";
import { formatCedis } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import type { MobileMoneyRequestRow } from "@/server/mobile-money/requests";
import { checkMobileMoneyAction } from "./account-actions";
import { CheckStatusButton } from "./mobile-money-controls";

/** A student's recent Mobile Money prompts and their outcomes. Refreshes while one is waiting. */
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
      {requests.some((r) => r.status === "pending") && <AutoRefresh />}
      <h3 id="mobile-money-requests" className="text-sm font-medium text-ink">
        Mobile Money requests
      </h3>
      <ul
        aria-labelledby="mobile-money-requests"
        className="divide-y divide-line rounded-lg border border-line bg-surface"
      >
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-base text-ink">
                <span className="font-medium tabular-nums">{formatCedis(r.amountPesewas)}</span>
                <span className="text-ink-3">
                  {" "}
                  · {NETWORK_LABELS[r.network]} {formatPhone(r.msisdn)}
                </span>
              </p>
              <p className="text-sm">
                <MobileMoneyStatus slug={slug} request={r} />
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
        ))}
      </ul>
    </div>
  );
}
