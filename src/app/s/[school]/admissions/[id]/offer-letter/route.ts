import { getApplication } from "@/server/admissions/service";
import { db } from "@/server/db/client";
import { getDocumentLogo } from "@/server/tenancy/branding";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { renderOfferLetterPdf } from "@/web/pdf/offer-letter";
import { pdfResponse } from "@/web/pdf/response";

export const dynamic = "force-dynamic";

/** The offer letter (ADM-05) for an application that has been offered a place. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; id: string }> },
) {
  const { school, id } = await params;
  const { ctx, user } = await requireTenant(school);
  const app = await getApplication(db(), ctx, id);
  if (!app || app.status !== "offered" || !app.entryTerm || !app.guardian.name)
    return new Response("Not found", { status: 404 });
  const pdf = await renderOfferLetterPdf(
    {
      schoolName: ctx.tenant.name,
      reference: app.reference,
      issuedOn: todayIn(ctx.tenant.timezone),
      guardianName: app.guardian.name,
      childName: app.child.name,
      levelName: app.level.name,
      className: app.offer.className,
      termName: app.entryTerm.name,
      termStartsOn: app.entryTerm.startsOn,
      respondBy: app.offer.respondBy,
      fees: app.offer.fees,
      currency: ctx.tenant.currencyCode,
      signedBy: user.name,
    },
    await getDocumentLogo(db(), ctx.tenant.id),
  );
  return pdfResponse(pdf, `offer-${app.reference}.pdf`);
}
