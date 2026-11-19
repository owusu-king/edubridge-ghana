import { getDocumentLogo } from "@/server/tenancy/branding";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStudentAccount } from "@/server/fees/ledger";
import { getStudent } from "@/server/students/service";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderStatementPdf, statementRange } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** The student's fee statement as a PDF. Finance access and campus scope as for the statement on screen. */
export async function GET(request: Request, { params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "fees.view")) return new Response("Not found", { status: 404 });
  const account = await getStudentAccount(db(), ctx, id);
  if (!account) return new Response("Not found", { status: 404 });
  const student = await getStudent(db(), ctx, id);
  const asOf = todayIn(ctx.tenant.timezone);
  const range = statementRange(request, asOf);
  if (!range) return new Response("Choose a start date on or before the end date.", { status: 400 });
  const pdf = await renderStatementPdf({
    ...range,
    account,
    schoolName: ctx.tenant.name,
    currency: ctx.tenant.currencyCode,
    logo: await getDocumentLogo(db(), ctx.tenant.id),
    className: student?.currentClass?.name ?? null,
    asOf,
  });
  return pdfResponse(pdf, `statement-${account.student.admissionNumber}-${range.to ?? asOf}.pdf`);
}
