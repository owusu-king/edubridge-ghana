import { db } from "@/server/db/client";
import { getParentReportCard } from "@/server/parents/portal";
import { getParentSession } from "@/web/parent-auth";
import { renderReportCardsPdf } from "@/web/pdf/report-card";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** A published report card of one of the signed-in parent's children. The same PDF the school prints. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; student: string; id: string }> },
) {
  const { school, student, id } = await params;
  const session = await getParentSession();
  if (!session) return new Response("Not found", { status: 404 });
  const card = await getParentReportCard(db(), session.phone, school, student, id);
  if (!card) return new Response("Not found", { status: 404 });
  const pdf = await renderReportCardsPdf([card]);
  return pdfResponse(
    pdf,
    `report-card-${card.student.admissionNumber}-${card.term.name}-${card.term.yearName}.pdf`,
  );
}
