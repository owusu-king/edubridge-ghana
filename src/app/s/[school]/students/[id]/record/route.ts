import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { exportLearnerRecord } from "@/server/passport/records";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/**
 * Issues a signed learner record and downloads it (Transfer Passport). POST from the student page: issuing
 * is recorded, so it is not a GET, and requests from other sites are refused.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host)
    return new Response("Forbidden", { status: 403 });
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transfers.manage")) return new Response("Not found", { status: 404 });
  try {
    const pkg = await exportLearnerRecord(db(), ctx, id);
    const student = pkg.record.student as { admissionNumber?: string };
    return new Response(JSON.stringify(pkg, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="learner-record-${student.admissionNumber ?? id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response(error.message, { status: 409 });
    throw error;
  }
}
