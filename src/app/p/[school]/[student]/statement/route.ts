import { getDocumentLogo } from "@/server/tenancy/branding";
import { db } from "@/server/db/client";
import { getParentChild } from "@/server/parents/portal";
import { todayIn } from "@/lib/format";
import { getParentSession } from "@/web/parent-auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderStatementPdf, statementRange } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** The child's statement as a PDF (PRT-04): the same document the accountant downloads. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ school: string; student: string }> },
) {
  const { school, student } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const child = await getParentChild(db(), session.phone, school, student);
  if (!child) return new Response("Not found", { status: 404 });
  const asOf = todayIn(child.school.timezone);
  const range = statementRange(request, asOf);
  if (!range) return new Response("Choose a start date on or before the end date.", { status: 400 });
  const pdf = await renderStatementPdf({
    ...range,
    account: child.account,
    schoolName: child.school.name,
    currency: child.school.currencyCode,
    logo: await getDocumentLogo(db(), child.school.id),
    className: child.summary.className,
    asOf,
  });
  return pdfResponse(pdf, `statement-${child.admissionNumber}-${range.to ?? asOf}.pdf`);
}
