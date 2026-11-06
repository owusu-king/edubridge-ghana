import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStudentAccount } from "@/server/fees/ledger";
import { getStudent } from "@/server/students/service";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderStatementPdf } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** The student's fee statement as a PDF. Finance access and campus scope as for the statement on screen. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "fees.view")) return new Response("Not found", { status: 404 });
  const account = await getStudentAccount(db(), ctx, id);
  if (!account) return new Response("Not found", { status: 404 });
  const student = await getStudent(db(), ctx, id);
  const asOf = todayIn(ctx.tenant.timezone);
  const pdf = await renderStatementPdf({
    account,
    schoolName: ctx.tenant.name,
    className: student?.currentClass?.name ?? null,
    asOf,
  });
  return pdfResponse(pdf, `statement-${account.student.admissionNumber}-${asOf}.pdf`);
}
