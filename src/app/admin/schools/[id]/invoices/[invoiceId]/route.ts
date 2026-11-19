import { getInvoiceDocumentForPlatform } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { requirePlatformAdmin } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderSubscriptionInvoicePdf } from "@/web/pdf/subscription-invoice";

export const dynamic = "force-dynamic";

/** The same invoice PDF the school downloads, for platform staff. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; invoiceId: string }> },
) {
  const { id, invoiceId } = await params;
  const user = await requirePlatformAdmin();
  const doc = await getInvoiceDocumentForPlatform(db(), user.id, id, invoiceId);
  if (!doc) return new Response("Not found", { status: 404 });
  return pdfResponse(await renderSubscriptionInvoicePdf(doc), `${doc.invoice.invoiceNumber}.pdf`);
}
