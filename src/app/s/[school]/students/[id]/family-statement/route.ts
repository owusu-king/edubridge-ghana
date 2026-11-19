import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getFamilyStatement } from "@/server/fees/family-statement";
import { getDocumentLogo } from "@/server/tenancy/branding";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderFamilyStatementPdf, statementRange } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** The family statement (FIN-12): this student and the siblings who share a guardian, optionally for a period. */
export async function GET(request: Request, { params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "fees.view")) return new Response("Not found", { status: 404 });
  const family = await getFamilyStatement(db(), ctx, id);
  if (!family) return new Response("Not found", { status: 404 });
  const asOf = todayIn(ctx.tenant.timezone);
  const range = statementRange(request, asOf);
  if (!range) return new Response("Choose a start date on or before the end date.", { status: 400 });
  const pdf = await renderFamilyStatementPdf({
    ...range,
    ...family,
    schoolName: ctx.tenant.name,
    currency: ctx.tenant.currencyCode,
    logo: await getDocumentLogo(db(), ctx.tenant.id),
    asOf,
  });
  return pdfResponse(
    pdf,
    `family-statement-${family.children[0]!.account.student.admissionNumber}-${range.to ?? asOf}.pdf`,
  );
}
