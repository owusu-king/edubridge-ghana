import { getReportCardFile } from "@/server/assessment/batches";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { requireTenant } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** A class's printed report cards from a print run. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; fileId: string }> },
) {
  const { school, fileId } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "assessment.enter")) return new Response("Not found", { status: 404 });
  const file = await getReportCardFile(db(), ctx, fileId);
  if (!file) return new Response("Not found", { status: 404 });
  return pdfResponse(file.pdf, file.filename);
}
