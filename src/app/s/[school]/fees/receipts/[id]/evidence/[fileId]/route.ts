import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { downloadPaymentEvidence } from "@/server/fees/evidence";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** A payment's evidence file as a download; each download is recorded in the audit log (FIN-07). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string; fileId: string }> },
) {
  const { school, id, fileId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "fees.view")) return new Response("Not found", { status: 404 });
  const file = await downloadPaymentEvidence(db(), ctx, id, fileId);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
