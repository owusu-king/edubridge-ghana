import { db } from "@/server/db/client";
import { getParentFamilyStatement } from "@/server/parents/portal";
import { getDocumentLogo } from "@/server/tenancy/branding";
import { todayIn } from "@/lib/format";
import { getParentSession } from "@/web/parent-auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderFamilyStatementPdf, statementRange } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** Every child of the signed-in parent at this school on one statement (PRT-04), optionally for a period. */
export async function GET(request: Request, { params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const family = await getParentFamilyStatement(db(), session.phone, school);
  if (!family) return new Response("Not found", { status: 404 });
  const asOf = todayIn(family.school.timezone);
  const range = statementRange(request, asOf);
  if (!range) return new Response("Choose a start date on or before the end date.", { status: 400 });
  const pdf = await renderFamilyStatementPdf({
    ...range,
    familyName: "Your family",
    children: family.children,
    schoolName: family.school.name,
    currency: family.school.currencyCode,
    logo: await getDocumentLogo(db(), family.school.id),
    asOf,
  });
  return pdfResponse(pdf, `family-statement-${asOf}.pdf`);
}
