import type { Metadata, Route } from "next";
import Link from "next/link";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { RowActions, Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  ApprovalAmountForm,
  DecideExpenseDialog,
  ExpenseDialog,
  ReasonDialog,
} from "@/components/finance/finance-forms";
import { getCurrentTerm } from "@/server/academics/calendar";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import {
  getExpenseApprovalAmount,
  listExpenses,
  listFinanceAccounts,
  type ExpenseRow,
} from "@/server/finance/service";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { minorToInput, moneyFormatter } from "@/lib/money";
import { EXPENSE_METHOD_LABELS } from "@/lib/school-finance";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  decideExpenseAction,
  recordExpenseAction,
  setApprovalAmountAction,
  voidExpenseAction,
} from "../actions";

export const metadata: Metadata = { title: "Finances · Expenses" };

const STATUS: Record<
  ExpenseRow["status"],
  { label: string; tone: "positive" | "caution" | "critical" | "neutral" }
> = {
  pending: { label: "Waiting for approval", tone: "caution" },
  approved: { label: "Approved", tone: "positive" },
  rejected: { label: "Rejected", tone: "critical" },
  voided: { label: "Voided", tone: "neutral" },
};

/** What the school spends: recorded by finance staff, approved by the Proprietor at or above the school's amount. */
export default async function ExpensesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const show = moneyFormatter(currency);
  const today = todayIn(ctx.tenant.timezone);
  const term = await getCurrentTerm(db(), ctx);
  const from = term?.startsOn ?? `${today.slice(0, 4)}-01-01`;
  const [rows, accounts, threshold] = await Promise.all([
    listExpenses(db(), ctx, { from, to: today }),
    listFinanceAccounts(db(), ctx),
    getExpenseApprovalAmount(db(), ctx),
  ]);
  const open = accounts.filter((a) => a.status === "active");
  const canRecord = allowed(ctx, "expenses.record");
  const canApprove = allowed(ctx, "expenses.approve");
  const approvalNote =
    threshold === 0
      ? "Every expense waits for the Proprietor's approval before it counts."
      : `Expenses of ${show(threshold)} or more wait for the Proprietor's approval before they count.`;

  return (
    <div className="space-y-12">
      <Section
        title="Expenses"
        description={`Since ${formatCalendarDate(from)}, with any still waiting for approval first. ${approvalNote}`}
        aside={
          canRecord && open.length > 0 ? (
            <ExpenseDialog
              action={recordExpenseAction.bind(null, slug)}
              currency={currency}
              accounts={open.map((a) => ({ value: a.id, label: a.name }))}
              today={today}
              approvalNote={
                canApprove ? "You are the Proprietor: what you record counts at once." : approvalNote
              }
            />
          ) : null
        }
      >
        {open.length === 0 ? (
          <p className="text-base text-ink-2">
            Add the school&apos;s bank accounts and cash box first, under{" "}
            <Link
              href={schoolPath(slug, "finance/accounts") as Route}
              className="text-accent hover:underline"
            >
              Accounts
            </Link>
            : every expense says which one it was paid from.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-base text-ink-2">No expenses recorded since {formatCalendarDate(from)}.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Expense</TH>
                  <TH>Paid to</TH>
                  <TH>Category</TH>
                  <TH>From</TH>
                  <TH numeric>Amount</TH>
                  <TH>Status</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {rows.map((e) => (
                  <TR key={e.id}>
                    <TD>
                      {e.expenseNumber}
                      <span className="block text-sm text-ink-3">{formatCalendarDate(e.spentOn)}</span>
                    </TD>
                    <TD>
                      {e.payee}
                      {e.description && <span className="block text-sm text-ink-3">{e.description}</span>}
                    </TD>
                    <TD>{e.category}</TD>
                    <TD>
                      {e.accountName}
                      <span className="block text-sm text-ink-3">
                        {EXPENSE_METHOD_LABELS[e.method]}
                        {e.reference ? ` · ${e.reference}` : ""}
                      </span>
                    </TD>
                    <TD numeric>{show(e.amountPesewas)}</TD>
                    <TD>
                      <StatusText tone={STATUS[e.status].tone}>{STATUS[e.status].label}</StatusText>
                      <span className="block text-sm text-ink-3">
                        {e.status === "voided"
                          ? e.voidReason
                          : [e.recordedBy && `By ${e.recordedBy}`, e.decisionNote]
                              .filter(Boolean)
                              .join(" · ")}
                      </span>
                    </TD>
                    <TD>
                      <RowActions>
                        {canApprove && e.status === "pending" && (
                          <>
                            <DecideExpenseDialog
                              action={decideExpenseAction.bind(null, slug, e.id, true)}
                              approve
                              label={`Approve expense ${e.expenseNumber}`}
                            />
                            <DecideExpenseDialog
                              action={decideExpenseAction.bind(null, slug, e.id, false)}
                              approve={false}
                              label={`Reject expense ${e.expenseNumber}`}
                            />
                          </>
                        )}
                        {canApprove && e.status === "approved" && (
                          <ReasonDialog
                            action={voidExpenseAction.bind(null, slug, e.id)}
                            trigger="Void"
                            label={`Void expense ${e.expenseNumber}`}
                            title={`Void expense ${e.expenseNumber}?`}
                            description="It then counts nowhere. The record and your reason are kept."
                            submitLabel="Void expense"
                          />
                        )}
                      </RowActions>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
      {canApprove && (
        <Section
          title="Approval"
          description="The amount from which an expense waits for you before it counts."
        >
          <ApprovalAmountForm
            action={setApprovalAmountAction.bind(null, slug)}
            currency={currency}
            value={minorToInput(threshold, currency)}
          />
        </Section>
      )}
    </div>
  );
}
