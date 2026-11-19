import { allowed } from "@/server/authz/permissions";
import { getInvoiceDocument } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { requireTenant } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderSubscriptionInvoicePdf } from "@/web/pdf/subscription-invoice";

export const dynamic = "force-dynamic";

/** An EduBridge invoice to this school, as PDF (SUB-03), for its Proprietor and Administrator. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "plan.view")) return new Response("Not found", { status: 404 });
  const doc = await getInvoiceDocument(db(), ctx, id);
  if (!doc) return new Response("Not found", { status: 404 });
  return pdfResponse(await renderSubscriptionInvoicePdf(doc), `${doc.invoice.invoiceNumber}.pdf`);
}
