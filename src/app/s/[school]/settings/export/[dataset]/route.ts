import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { DATASETS, exportDataset, isDataset } from "@/server/export/datasets";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** One dataset as a CSV download (audited). Same access as the Data export page. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; dataset: string }> },
) {
  const { school, dataset } = await params;
  const { ctx } = await requireTenant(school);
  if (!isDataset(dataset) || !allowed(ctx, DATASETS[dataset].permission))
    return new Response("Not found", { status: 404 });
  try {
    const file = await exportDataset(db(), ctx, dataset);
    return new Response(file.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof DomainError) return new Response(error.message, { status: 403 });
    throw error;
  }
}
