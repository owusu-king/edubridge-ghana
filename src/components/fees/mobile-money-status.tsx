import Link from "next/link";
import { schoolPath } from "@/lib/routes";
import type { MobileMoneyRequestRow, MobileMoneyRequestStatus } from "@/server/mobile-money/requests";

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

/** The outcome of a Mobile Money request in one line: status, receipt link, reason or review. */
export function MobileMoneyStatus({ slug, request: r }: { slug: string; request: MobileMoneyRequestRow }) {
  if (r.status === "needs_review" && r.reviewedAt) {
    return (
      <span className="text-ink-2">
        Reviewed{r.reviewedBy && ` by ${r.reviewedBy}`}: {r.reviewNote}
        <span className="block text-ink-3">Held because {lowerFirst(r.statusReason ?? "")}</span>
      </span>
    );
  }
  const status = STATUS[r.status];
  return (
    <span className={status.className}>
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
      {r.statusReason && <span className="font-normal text-ink-2">: {r.statusReason}</span>}
    </span>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
