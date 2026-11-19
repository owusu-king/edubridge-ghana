import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { allowed } from "@/server/authz/permissions";
import {
  confirmInvoicePayment,
  invoicePaymentsFromEnv,
  parseInvoicePaymentReference,
} from "@/server/billing/online-payments";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Plan · Payment" };
export const dynamic = "force-dynamic";

/**
 * Where the payment page sends the payer back (SUB-04). The reference in the address is only a pointer:
 * the outcome is asked of the provider here, so a forged address cannot mark anything paid.
 */
export default async function InvoicePaidPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ reference?: string; trxref?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "plan.view")) notFound();
  const reference = search.reference ?? search.trxref ?? "";
  const parsed = parseInvoicePaymentReference(reference);
  if (!parsed || parsed.tenantId !== ctx.tenant.id) notFound();
  const result = await confirmInvoicePayment(db(), reference, {
    provider: invoicePaymentsFromEnv(),
    actorUserId: ctx.userId,
  });
  if (result.outcome === "not_found") notFound();
  return (
    <div className="max-w-2xl space-y-6">
      {result.outcome === "paid" ? (
        <Alert tone="positive">
          Thank you. Invoice {result.invoiceNumber} is paid, and your subscription is paid to the end of its
          period.
        </Alert>
      ) : result.outcome === "duplicate" ? (
        <Alert tone="info">
          This payment was received, but invoice {result.invoiceNumber} had already been settled. EduBridge
          will refund it or credit it to your next invoice.
        </Alert>
      ) : result.outcome === "pending" ? (
        <Alert tone="info">
          The payment is still being confirmed. It will show as paid here as soon as it is; there is no need
          to pay again.
        </Alert>
      ) : (
        <Alert tone="critical">{result.reason}</Alert>
      )}
      <Link
        href={schoolPath(ctx.tenant.slug, "settings/plan") as Route}
        className={buttonStyles("secondary")}
      >
        Back to your plan
      </Link>
    </div>
  );
}
