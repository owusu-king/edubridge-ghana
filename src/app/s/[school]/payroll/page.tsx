import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Banknote } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listMyPayslips, listPayrollRuns } from "@/server/payroll/service";
import { todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { PAYROLL_STATUS_LABELS } from "@/lib/payroll";
import { monthLabel } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { preparePayrollAction } from "./actions";
import { PrepareForm } from "./payroll-controls";

export const metadata: Metadata = { title: "Payroll" };

/** Each month's payroll (PRL-02), and the signed-in member's own payslips (PRL-03). */
export default async function PayrollPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const staffView = allowed(ctx, "payroll.view");
  if (!staffView && !allowed(ctx, "payroll.own")) notFound();
  const slug = ctx.tenant.slug;
  const money = moneyFormatter(ctx.tenant.currencyCode);
  const [runs, mine] = await Promise.all([
    staffView ? listPayrollRuns(db(), ctx) : null,
    allowed(ctx, "payroll.own") ? listMyPayslips(db(), ctx) : null,
  ]);
  const slipHref = (id: string) => `${schoolPath(slug, "payroll/payslips")}/${id}`;

  return (
    <div className="space-y-10">
      {runs && (
        <Section
          title="Months"
          description="A month is prepared as a draft from the salaries in force, checked, then approved by the Proprietor. Approved months never change; corrections go into a later month as adjustments."
          aside={
            allowed(ctx, "payroll.manage") &&
            ctx.campusIds === null && (
              <PrepareForm
                action={preparePayrollAction.bind(null, slug)}
                month={todayIn(ctx.tenant.timezone).slice(0, 7)}
              />
            )
          }
        >
          {runs.length === 0 ? (
            <EmptyState
              icon={<Banknote />}
              title="No payroll yet"
              description="Set the components and each person's salary first, then prepare a month."
            />
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">Payroll by month</caption>
                <THead>
                  <tr>
                    <TH>Month</TH>
                    <TH>Status</TH>
                    <TH numeric>People</TH>
                    <TH numeric className="hidden sm:table-cell">
                      Gross
                    </TH>
                    <TH numeric>Net pay</TH>
                    <TH numeric className="hidden md:table-cell">
                      Employer
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {runs.map((r) => (
                    <TR key={r.id}>
                      <TD>
                        <Link
                          href={`${schoolPath(slug, "payroll")}/${r.id}` as Route}
                          className="font-medium text-ink hover:underline"
                        >
                          {monthLabel(r.month)}
                        </Link>
                      </TD>
                      <TD>
                        <StatusText tone={r.status === "approved" ? "positive" : "caution"}>
                          {PAYROLL_STATUS_LABELS[r.status]}
                        </StatusText>
                      </TD>
                      <TD numeric>{r.totals.people}</TD>
                      <TD numeric className="hidden sm:table-cell">
                        {money(r.totals.gross)}
                      </TD>
                      <TD numeric>{money(r.totals.net)}</TD>
                      <TD numeric className="hidden md:table-cell">
                        {money(r.totals.employer)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}

      {mine && (mine.payslips.length > 0 || !staffView) && (
        <Section title="Your payslips">
          {!mine.hasStaffRecord ? (
            <p className="text-base text-ink-3">
              You have no staff record at {ctx.tenant.name} yet. Ask the office to add one and link it to your
              account.
            </p>
          ) : mine.payslips.length === 0 ? (
            <p className="text-base text-ink-3">No approved payslips yet.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {mine.payslips.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                  <span>
                    <span className="block text-base text-ink">{monthLabel(p.month)}</span>
                    <span className="text-sm text-ink-3">Net pay {money(p.net)}</span>
                  </span>
                  <a href={slipHref(p.id)} className="text-sm font-medium text-accent hover:underline">
                    Payslip (PDF)
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
