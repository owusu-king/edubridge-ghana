import { recordAudit } from "@/server/audit/record";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { withTenant } from "@/server/db/context";
import { DomainError } from "@/server/errors";
import { getPayrollRun } from "@/server/payroll/service";
import { toCsv } from "@/lib/csv";
import { pesewasToDecimal } from "@/lib/money";
import { requireTenant } from "@/web/auth";

export const dynamic = "force-dynamic";

/**
 * A month's payroll as CSV (PRL-03): one row per person with gross, deductions, net and the school's
 * contributions, for the bank or the accountant. EduBridge pays nobody. Every download is audited.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ school: string; runId: string }> },
) {
  const { school, runId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "payroll.view")) return new Response("Not found", { status: 404 });
  let run;
  try {
    run = await getPayrollRun(db(), ctx, runId);
  } catch (error) {
    if (error instanceof DomainError) return new Response("Not found", { status: 404 });
    throw error;
  }
  await withTenant(
    db(),
    { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId },
    (tx) =>
      recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "payroll.exported",
        entityType: "payroll_run",
        entityId: run.id,
        metadata: { month: run.month, status: run.status },
      }),
  );
  const amount = (m: number) => pesewasToDecimal(m, run.currencyCode);
  const rows: (string | number)[][] = [
    [
      "Staff number",
      "Name",
      "Position",
      "Basic",
      "Gross",
      "Deductions",
      "Net pay",
      "Employer contributions",
      "Currency",
    ],
    ...run.lines.map((l) => [
      l.staffNumber,
      l.staffName,
      l.position ?? "",
      amount(l.basic),
      amount(l.gross),
      amount(l.deductions),
      amount(l.net),
      amount(l.employer),
      run.currencyCode,
    ]),
    [
      "",
      `Total (${run.totals.people})`,
      "",
      amount(run.totals.basic),
      amount(run.totals.gross),
      amount(run.totals.deductions),
      amount(run.totals.net),
      amount(run.totals.employer),
      run.currencyCode,
    ],
  ];
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.month}${run.status === "draft" ? "-draft" : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
