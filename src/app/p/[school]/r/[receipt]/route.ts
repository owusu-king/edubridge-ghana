import { db } from "@/server/db/client";
import { findParentReceiptId } from "@/server/parents/portal";
import { getParentSession } from "@/web/parent-auth";

export const dynamic = "force-dynamic";

/**
 * The short receipt address sent in the payment SMS (FIN-11). Signing in first is handled by the proxy;
 * the receipt opens only for a number linked to the child, as on the child's page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ school: string; receipt: string }> },
) {
  const { school, receipt } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const id = await findParentReceiptId(db(), session.phone, school, receipt.toUpperCase());
  if (!id) return new Response("Not found", { status: 404 });
  return Response.redirect(new URL(`/p/${school}/receipts/${id}/pdf`, request.url), 303);
}
