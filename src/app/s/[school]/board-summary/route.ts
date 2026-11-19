import { allowed, ForbiddenError } from "@/server/authz/permissions";
import { getBoardSummary, recordSummaryDownload } from "@/server/dashboard/board-summary";
import { resolveDraft } from "@/server/drafting/service";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getDocumentLogo } from "@/server/tenancy/branding";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { renderBoardSummaryPdf } from "@/web/pdf/board-summary";
import { pdfResponse } from "@/web/pdf/response";
import { chooseTerm } from "@/web/terms";

export const dynamic = "force-dynamic";

async function respond(
  school: string,
  input: { term: string | null; campus: string | null; report?: string | null; draftId?: string | null },
) {
  const { ctx } = await requireTenant(school);
  try {
    const { term } = await chooseTerm(ctx, input.term ?? undefined);
    if (!term) return new Response("Not found", { status: 404 });
    const summary = await getBoardSummary(db(), ctx, { termId: term.id, campusId: input.campus });
    if (!summary) return new Response("Not found", { status: 404 });
    // The Proprietor's edited report (R5-5, DRF-03); only they write one.
    const report = input.report && allowed(ctx, "drafting.board_report") ? input.report.slice(0, 6000) : null;
    const pdf = await renderBoardSummaryPdf({
      cc: summary,
      schoolName: ctx.tenant.name,
      logo: await getDocumentLogo(db(), ctx.tenant.id),
      currency: ctx.tenant.currencyCode,
      generatedOn: todayIn(ctx.tenant.timezone),
      report,
    });
    await recordSummaryDownload(db(), ctx, summary);
    if (report) await resolveDraft(db(), ctx, input.draftId, report);
    return pdfResponse(
      pdf,
      `${ctx.tenant.slug}-board-${report ? "report" : "summary"}-${summary.term.label}.pdf`,
    );
  } catch (error) {
    if (error instanceof DomainError || error instanceof ForbiddenError)
      return new Response("Not found", { status: 404 });
    throw error;
  }
}

/** The Command Center's board summary of a term (and campus) as a one-page PDF (CMD-06); every download audited. */
export async function GET(request: Request, { params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const url = new URL(request.url);
  return respond(school, { term: url.searchParams.get("term"), campus: url.searchParams.get("campus") });
}

/** The same summary with the Proprietor's edited board report above the figures (R5-5, DRF-03). */
export async function POST(request: Request, { params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const form = await request.formData();
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : null;
  };
  return respond(school, {
    term: text("term"),
    campus: text("campus") || null,
    report: text("report"),
    draftId: text("draftId"),
  });
}
