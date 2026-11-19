import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { ScopePicker } from "@/components/overview/scope-picker";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { draftingAvailability } from "@/server/drafting/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm } from "@/web/terms";
import { draftBoardReportAction } from "../drafting-actions";
import { ReportEditor } from "./report-editor";

export const metadata: Metadata = { title: "Board report" };

/** The Proprietor's report to the board around the Command Center figures (R5-5, DRF-03). */
export default async function BoardReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string; campus?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "drafting.board_report")) notFound();
  const slug = ctx.tenant.slug;
  const { terms, term } = await chooseTerm(ctx, search.term);
  const campuses = (await listCampuses(db(), ctx)).filter((c) => c.status === "active");
  const campus = campuses.length > 1 ? (campuses.find((c) => c.id === search.campus) ?? null) : null;
  const availability = await draftingAvailability(db(), ctx, "board_report");
  return (
    <div className="space-y-8">
      <PageHeader
        title="Board report"
        description={`A short report to the board for ${term?.label ?? "a term"}${campus ? `, ${campus.name} campus` : ""}, around the Command Center figures. Draft it with AI or write it yourself, then download it with the board summary as one PDF.`}
        actions={
          (terms.length > 1 && term) || campuses.length > 1 ? (
            <ScopePicker
              terms={terms}
              termId={term?.id ?? null}
              campuses={campuses}
              campusId={campus?.id ?? null}
            />
          ) : null
        }
      />
      {!term ? (
        <EmptyState
          icon={<CalendarDays />}
          title="No terms yet"
          description="Set up the academic year and its terms in Settings, Calendar."
        />
      ) : (
        <ReportEditor
          key={`${term.id}:${campus?.id ?? ""}`}
          draft={draftBoardReportAction.bind(null, slug)}
          downloadUrl={schoolPath(slug, "board-summary")}
          termId={term.id}
          campusId={campus?.id ?? null}
          available={availability?.available ?? false}
          unavailableMessage={availability?.message ?? null}
        />
      )}
    </div>
  );
}
