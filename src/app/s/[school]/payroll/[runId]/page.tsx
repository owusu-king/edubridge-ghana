import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { DescriptionList, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getPayrollRun } from "@/server/payroll/service";
import { formatDateTime } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { PAYROLL_STATUS_LABELS } from "@/lib/payroll";
import { monthLabel } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { approvePayrollAction, cancelPayrollAction, recalculatePayrollAction } from "../actions";

export const metadata: Metadata = { title: "Payroll month" };

export default async function PayrollRunPage({
  params,
}: {
  params: Promise<{ school: string; runId: string }>;
}) {
  const { school, runId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "payroll.view")) notFound();
  let run;
  try {
    run = await getPayrollRun(db(), ctx, runId);
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const money = moneyFormatter(run.currencyCode);
  const draft = run.status === "draft";
  const base = schoolPath(slug, "payroll");
  const negative = run.lines.filter((l) => l.net < 0);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href={base} className="text-sm font-medium text-accent hover:underline">
            All months
          </Link>
          <h2 className="mt-2 text-xl font-semibold text-ink">{monthLabel(run.month)}</h2>
          <StatusText tone={draft ? "caution" : "positive"}>{PAYROLL_STATUS_LABELS[run.status]}</StatusText>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <a
            href={`${base}/${run.id}/export`}
            className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-subtle"
          >
            Download CSV
          </a>
          {draft && allowed(ctx, "payroll.manage") && (
            <>
              <ActionButton
                action={recalculatePayrollAction.bind(null, slug, run.month)}
                label="Recalculate"
              />
              <ActionButton action={cancelPayrollAction.bind(null, slug, run.id)} label="Cancel draft" />
            </>
          )}
          {draft && allowed(ctx, "payroll.approve") && (
            <ActionButton
              action={approvePayrollAction.bind(null, slug, run.id)}
              label="Approve"
              variant="primary"
            />
          )}
        </div>
      </div>

      {draft && run.stale && (
        <Alert tone="info">
          Salaries or adjustments changed since this draft was prepared. Recalculate it before approving.
        </Alert>
      )}
      {draft && run.withoutSalary.length > 0 && (
        <Alert tone="info">
          Not on this payroll because they have no salary for {monthLabel(run.month)}:{" "}
          {run.withoutSalary.join(", ")}.
        </Alert>
      )}
      {negative.length > 0 && (
        <Alert tone="critical">
          Net pay is below zero for {negative.map((l) => l.staffName).join(", ")}. It cannot be approved until
          their deductions or adjustments are corrected.
        </Alert>
      )}

      <DescriptionList
        items={[
          { term: "People", detail: String(run.totals.people) },
          { term: "Gross pay", detail: money(run.totals.gross) },
          { term: "Deductions", detail: money(run.totals.deductions) },
          { term: "Net pay", detail: money(run.totals.net) },
          { term: "Employer contributions", detail: money(run.totals.employer) },
          { term: "Prepared", detail: `${run.preparedBy}, ${formatDateTime(run.preparedAt, tz)}` },
          ...(run.approvedAt
            ? [
                {
                  term: "Approved",
                  detail: `${run.approvedBy ?? "Unknown"}, ${formatDateTime(run.approvedAt, tz)}`,
                },
              ]
            : []),
        ]}
      />

      <Section title="People">
        {run.lines.length === 0 ? (
          <p className="text-base text-ink-3">Nobody on this payroll yet. Set salaries, then recalculate.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Payroll for {monthLabel(run.month)}</caption>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH numeric className="hidden sm:table-cell">
                    Gross
                  </TH>
                  <TH numeric className="hidden sm:table-cell">
                    Deductions
                  </TH>
                  <TH numeric>Net pay</TH>
                  <TH>
                    <span className="sr-only">Payslip</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {run.lines.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      <Link
                        href={`${base}/people/${l.staffId}` as Route}
                        className="font-medium text-ink hover:underline"
                      >
                        {l.staffName}
                      </Link>
                      <span className="block text-sm text-ink-3">
                        {[l.staffNumber, l.position].filter(Boolean).join(" · ")}
                      </span>
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {money(l.gross)}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {money(l.deductions)}
                    </TD>
                    <TD numeric className={l.net < 0 ? "text-critical" : undefined}>
                      {money(l.net)}
                    </TD>
                    <TD className="text-right">
                      <a
                        href={`${base}/payslips/${l.id}`}
                        className="text-sm font-medium text-accent hover:underline"
                        aria-label={`Payslip for ${l.staffName}`}
                      >
                        Payslip
                      </a>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
    </div>
  );
}
