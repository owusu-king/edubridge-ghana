import { ForbiddenError } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getPayslip } from "@/server/payroll/service";
import { getDocumentLogo } from "@/server/tenancy/branding";
import { requireTenant } from "@/web/auth";
import { renderPayslipPdf } from "@/web/pdf/payslip";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** A payslip as a PDF (PRL-03): payroll staff any line; everyone else their own approved ones. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; lineId: string }> },
) {
  const { school, lineId } = await params;
  const { ctx } = await requireTenant(school);
  try {
    const slip = await getPayslip(db(), ctx, lineId);
    if (!slip) return new Response("Not found", { status: 404 });
    const pdf = await renderPayslipPdf({
      slip,
      schoolName: ctx.tenant.name,
      logo: await getDocumentLogo(db(), ctx.tenant.id),
    });
    return pdfResponse(pdf, `payslip-${slip.staffNumber}-${slip.month}.pdf`);
  } catch (error) {
    if (error instanceof DomainError || error instanceof ForbiddenError)
      return new Response("Not found", { status: 404 });
    throw error;
  }
}
