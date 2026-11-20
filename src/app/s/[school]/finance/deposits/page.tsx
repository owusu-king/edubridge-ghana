import type { Metadata, Route } from "next";
import Link from "next/link";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { RowActions, Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { DepositForm, ReasonDialog } from "@/components/finance/finance-forms";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listDeposits, listFinanceAccounts, listUndepositedReceipts } from "@/server/finance/service";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { cancelDepositAction, createDepositAction } from "../actions";

export const metadata: Metadata = { title: "Finances · Cash to bank" };

/** Cash and cheques received but not yet banked, and the deposits that took them to the bank. */
export default async function DepositsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const show = moneyFormatter(ctx.tenant.currencyCode);
  const [receipts, deposits, accounts] = await Promise.all([
    listUndepositedReceipts(db(), ctx),
    listDeposits(db(), ctx),
    listFinanceAccounts(db(), ctx),
  ]);
  const banks = accounts.filter((a) => a.kind === "bank" && a.status === "active");
  const held = receipts.reduce((s, r) => s + r.amountPesewas, 0);
  const canManage = allowed(ctx, "finance.manage");
  const canCancel = allowed(ctx, "expenses.approve");

  return (
    <div className="space-y-12">
      <Section
        title="Not yet banked"
        description={`${receipts.length} cash and cheque receipt${receipts.length === 1 ? "" : "s"} for ${show(held)} that no deposit includes yet.`}
      >
        {receipts.length === 0 ? (
          <p className="text-base text-ink-2">Every cash and cheque receipt is in a deposit.</p>
        ) : banks.length === 0 ? (
          <p className="text-base text-ink-2">
            Add the school&apos;s bank account under{" "}
            <Link
              href={schoolPath(slug, "finance/accounts") as Route}
              className="text-accent hover:underline"
            >
              Accounts
            </Link>{" "}
            to record deposits.
          </p>
        ) : canManage ? (
          <DepositForm
            action={createDepositAction.bind(null, slug)}
            currency={ctx.tenant.currencyCode}
            receipts={receipts}
            bankAccounts={banks.map((b) => ({ value: b.id, label: b.name }))}
            today={todayIn(ctx.tenant.timezone)}
          />
        ) : (
          <p className="text-base text-ink-2">The Proprietor or Accountant records deposits.</p>
        )}
      </Section>

      <Section title="Deposits">
        {deposits.length === 0 ? (
          <p className="text-base text-ink-2">No deposits recorded yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Deposit</TH>
                  <TH>Account</TH>
                  <TH numeric>Receipts</TH>
                  <TH numeric>Amount</TH>
                  <TH>Status</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {deposits.map((d) => (
                  <TR key={d.id}>
                    <TD>
                      {d.depositNumber}
                      <span className="block text-sm text-ink-3">
                        {formatCalendarDate(d.depositedOn)}
                        {d.slipReference ? ` · slip ${d.slipReference}` : ""}
                      </span>
                    </TD>
                    <TD>{d.accountName}</TD>
                    <TD numeric>{d.receipts}</TD>
                    <TD numeric>{show(d.amountPesewas)}</TD>
                    <TD>
                      {d.cancelled ? (
                        <StatusText tone="neutral">Cancelled: {d.cancelled.reason}</StatusText>
                      ) : d.onStatement ? (
                        <StatusText tone="positive">On the bank statement</StatusText>
                      ) : (
                        <StatusText tone="caution">Not yet on a statement</StatusText>
                      )}
                    </TD>
                    <TD>
                      {canCancel && !d.cancelled && !d.onStatement && (
                        <RowActions>
                          <ReasonDialog
                            action={cancelDepositAction.bind(null, slug, d.id)}
                            trigger="Cancel"
                            label={`Cancel deposit ${d.depositNumber}`}
                            title={`Cancel deposit ${d.depositNumber}?`}
                            description="Its receipts go back to Not yet banked. The record and your reason are kept."
                            submitLabel="Cancel deposit"
                          />
                        </RowActions>
                      )}
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
