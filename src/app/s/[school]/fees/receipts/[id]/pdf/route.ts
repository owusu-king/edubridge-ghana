import { db } from "@/server/db/client";
import { getReceipt } from "@/server/fees/payments";
import { requireTenant } from "@/web/auth";
import { renderReceiptPdf } from "@/web/pdf/receipt";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** The receipt as a PDF, for printing or sending to the family. Same access as the receipt page. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  const receipt = await getReceipt(db(), ctx, id);
  if (!receipt) return new Response("Not found", { status: 404 });
  const pdf = await renderReceiptPdf({ receipt, schoolName: ctx.tenant.name, timeZone: ctx.tenant.timezone });
  return pdfResponse(pdf, `receipt-${receipt.receiptNumber}.pdf`);
}
