import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getReceipt, METHOD_LABELS } from "@/server/fees/payments";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { voidPaymentAction } from "./actions";
import { PrintButton, VoidReceiptDialog } from "./receipt-controls";

export const metadata: Metadata = { title: "Receipt" };

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-6 py-2.5">
      <dt className="text-ink-2">{term}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  const receipt = await getReceipt(db(), ctx, id);
  if (!receipt) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const balance = receipt.balanceAfterPesewas;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={schoolPath(slug, `students/${receipt.student.id}`)}
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {receipt.student.name}
        </Link>
        <div className="flex gap-2">
          {!receipt.voided && can(ctx.roles, "payments.void") && (
            <VoidReceiptDialog
              action={voidPaymentAction.bind(null, slug, receipt.id)}
              receiptNumber={receipt.receiptNumber}
            />
          )}
          <PrintButton />
        </div>
      </div>

      {receipt.voided && (
        <Alert tone="critical">
          Voided {formatDateTime(receipt.voided.at, tz)}
          {receipt.voided.by && ` by ${receipt.voided.by}`}: {receipt.voided.reason}
        </Alert>
      )}

      <article
        aria-labelledby="receipt-title"
        className="rounded-lg border border-line bg-surface p-6 shadow-raised sm:p-8 print:border-0 print:p-0 print:shadow-none"
      >
        <header className="space-y-1 border-b border-line pb-5">
          <p className="text-md font-semibold text-ink">{ctx.tenant.name}</p>
          <h1 id="receipt-title" className="text-sm tracking-wide text-ink-2 uppercase">
            Payment receipt <span className="font-mono normal-case">{receipt.receiptNumber}</span>
            {receipt.voided && <span className="ml-2 font-semibold text-critical">Void</span>}
          </h1>
        </header>
        <p className="py-6 text-center">
          <span className="block text-sm text-ink-2">Amount received</span>
          <span
            className={`text-2xl font-semibold text-ink tabular-nums ${receipt.voided ? "line-through" : ""}`}
          >
            {formatCedis(receipt.amountPesewas)}
          </span>
        </p>
        <dl className="divide-y divide-line border-y border-line text-base">
          <Row term="Date">{formatCalendarDate(receipt.paidOn)}</Row>
          <Row term="Student">
            {receipt.student.name}
            <span className="block font-mono text-sm text-ink-3">
              {receipt.student.admissionNumber}
              {receipt.student.className && ` · ${receipt.student.className}`}
            </span>
          </Row>
          {receipt.payerName && <Row term="Received from">{receipt.payerName}</Row>}
          <Row term="Paid by">
            {METHOD_LABELS[receipt.method]}
            {receipt.reference && (
              <span className="block font-mono text-sm text-ink-3">{receipt.reference}</span>
            )}
          </Row>
          <Row term="Balance after this payment">
            {balance > 0
              ? `${formatCedis(balance)} owed`
              : balance < 0
                ? `${formatCedis(-balance)} in credit`
                : "Nothing owed"}
          </Row>
          <Row term="Received by">{receipt.recordedBy ?? "—"}</Row>
        </dl>
        <p className="pt-4 text-sm text-ink-3">Recorded {formatDateTime(receipt.recordedAt, tz)}.</p>
      </article>
    </div>
  );
}
