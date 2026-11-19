import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getStudentPhoto } from "@/server/students/profile";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** A student's photo, for staff who can see the student (campus and class scope apply). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  try {
    const file = await getStudentPhoto(db(), ctx, id);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(file.content), {
      headers: {
        "Content-Type": file.mime,
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response("Not found", { status: 404 });
    throw error;
  }
}
