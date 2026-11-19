import { ForbiddenError } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getCollectorPhoto } from "@/server/visitors/pickup";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** A named collector's photo, for staff who handle the child's pickup (campus scope applies). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; studentId: string; collectorId: string }> },
) {
  const { school, studentId, collectorId } = await params;
  const { ctx } = await requireTenant(school);
  try {
    const file = await getCollectorPhoto(db(), ctx, studentId, collectorId);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": file.mime,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DomainError || error instanceof ForbiddenError)
      return new Response("Not found", { status: 404 });
    throw error;
  }
}
