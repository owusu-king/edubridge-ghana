import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { downloadCaseDocument } from "@/server/safeguarding/service";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** A safeguarding document, for the school's leads only; every download is recorded on the case (SFG-01d). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; caseId: string; documentId: string }> },
) {
  const { school, caseId, documentId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "safeguarding.manage")) return new Response("Not found", { status: 404 });
  try {
    const file = await downloadCaseDocument(db(), ctx, caseId, documentId);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response("Not found", { status: 404 });
    throw error;
  }
}
