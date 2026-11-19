import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { narrowToCampus } from "@/server/fees/access";
import { METHOD_LABELS } from "@/server/fees/payments";
import { getBalanceReport, getCollectionReport, GROUPINGS, type Grouping } from "@/server/fees/reports";
import { toCsv } from "@/lib/csv";
import { AGE_BUCKETS } from "@/lib/dashboard";
import { todayIn } from "@/lib/format";
import { pesewasToDecimal } from "@/lib/money";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/** `toCsv` already starts the file with the byte-order mark Excel needs; adding another left a stray character. */
const csvResponse = (csv: string, filename: string) =>
  new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** A finance report as CSV (amounts as plain decimals), with the same access and scope as on screen. */
export async function GET(request: Request, { params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx: full } = await requireTenant(school);
  if (!allowed(full, "fees.view")) return new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const ctx = narrowToCampus(full, url.searchParams.get("campus"));
  const by = (GROUPINGS as readonly string[]).includes(url.searchParams.get("by") ?? "")
    ? (url.searchParams.get("by") as Grouping)
    : "class";
  const today = todayIn(ctx.tenant.timezone);
  if (url.searchParams.get("report") === "collections") {
    const report = await getCollectionReport(db(), ctx, by, {
      from: url.searchParams.get("from") ?? today,
      to: url.searchParams.get("to") ?? today,
    }).catch(() => null);
    if (!report) return new Response("Choose a valid period.", { status: 400 });
    const methods = Object.keys(report.total.byMethod);
    const rows = [
      [by, "receipts", ...methods.map((m) => METHOD_LABELS[m as keyof typeof METHOD_LABELS] ?? m), "total"],
      ...[...report.groups, report.total].map((g) => [
        g.label,
        g.receipts,
        ...methods.map((m) => pesewasToDecimal(g.byMethod[m] ?? 0, ctx.tenant.currencyCode)),
        pesewasToDecimal(g.totalPesewas, ctx.tenant.currencyCode),
      ]),
    ];
    return csvResponse(toCsv(rows), `collections-by-${by}-${report.from}-to-${report.to}.csv`);
  }
  const report = await getBalanceReport(db(), ctx, by);
  const rows = [
    [by, "students", "owing", "owed", ...AGE_BUCKETS.map((b) => b.label), "in credit"],
    ...[...report.groups, report.total].map((g) => [
      g.label,
      g.students,
      g.owing,
      pesewasToDecimal(g.owedPesewas, ctx.tenant.currencyCode),
      ...g.buckets.map((b) => pesewasToDecimal(b, ctx.tenant.currencyCode)),
      pesewasToDecimal(g.creditPesewas, ctx.tenant.currencyCode),
    ]),
  ];
  return csvResponse(toCsv(rows), `owed-by-${by}-${report.asOf}.csv`);
}
