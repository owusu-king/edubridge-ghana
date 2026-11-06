import { db } from "@/server/db/client";
import { getParentReceipt } from "@/server/parents/portal";
import { getParentSession } from "@/web/parent-auth";
import { renderReceiptPdf } from "@/web/pdf/receipt";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** A receipt for one of the signed-in parent's children (PRT-03). The same PDF the school prints. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const found = await getParentReceipt(db(), session.phone, school, id);
  if (!found) return new Response("Not found", { status: 404 });
  const pdf = await renderReceiptPdf({
    receipt: found.receipt,
    schoolName: found.school.name,
    timeZone: found.school.timezone,
  });
  return pdfResponse(pdf, `receipt-${found.receipt.receiptNumber}.pdf`);
}
