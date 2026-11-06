import type { NextRequest } from "next/server";
import { getReportCard } from "@/server/assessment/report-cards";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { requireTenant } from "@/web/auth";
import { renderReportCardsPdf } from "@/web/pdf/report-card";
import { pdfResponse } from "@/web/pdf/response";
import { chooseTerm } from "../../../../terms";

export const dynamic = "force-dynamic";

/** One student's report card: the published one, or the draft as it stands (marked as not approved). */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ school: string; classId: string; studentId: string }> },
) {
  const { school, classId, studentId } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "assessment.enter")) return new Response("Not found", { status: 404 });
  const { term } = await chooseTerm(ctx, request.nextUrl.searchParams.get("term") ?? undefined);
  if (!term) return new Response("Not found", { status: 404 });
  const report = await getReportCard(db(), ctx, term.id, classId, studentId);
  if (!report) return new Response("Not found", { status: 404 });
  const draft = report.status !== "published";
  const pdf = await renderReportCardsPdf([report.snapshot], draft);
  const { student, term: t } = report.snapshot;
  return pdfResponse(pdf, `report-card-${student.admissionNumber}-${t.name}${draft ? "-draft" : ""}.pdf`);
}
