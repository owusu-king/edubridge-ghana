import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { downloadStudentDocument } from "@/server/students/profile";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** A student document as a download; each download is recorded in the audit log (SIS-08). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string; fileId: string }> },
) {
  const { school, id, fileId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "students.view_all")) return new Response("Not found", { status: 404 });
  try {
    const file = await downloadStudentDocument(db(), ctx, id, fileId);
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
