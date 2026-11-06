import { db } from "@/server/db/client";
import { getParentChild } from "@/server/parents/portal";
import { todayIn } from "@/lib/format";
import { getParentSession } from "@/web/parent-auth";
import { pdfResponse } from "@/web/pdf/response";
import { renderStatementPdf } from "@/web/pdf/statement";

export const dynamic = "force-dynamic";

/** The child's statement as a PDF (PRT-04): the same document the accountant downloads. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; student: string }> },
) {
  const { school, student } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const child = await getParentChild(db(), session.phone, school, student);
  if (!child) return new Response("Not found", { status: 404 });
  const asOf = todayIn(child.school.timezone);
  const pdf = await renderStatementPdf({
    account: child.account,
    schoolName: child.school.name,
    className: child.summary.className,
    asOf,
  });
  return pdfResponse(pdf, `statement-${child.admissionNumber}-${asOf}.pdf`);
}
