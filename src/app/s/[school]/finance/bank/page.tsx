import type { Metadata, Route } from "next";
import Link from "next/link";
import { StatusText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Section } from "@/components/ui/layout";
import { RowActions, Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ActionButton, ExplainLineDialog, StatementUploadForm } from "@/components/finance/finance-forms";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getReconciliation } from "@/server/finance/bank";
import { listFinanceAccounts } from "@/server/finance/service";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  explainLineAction,
  importStatementAction,
  matchLineAction,
  rematchAction,
  unmatchLineAction,
} from "../actions";

export const metadata: Metadata = { title: "Finances · Bank statements" };

const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * One bank account's statement for a month, line by line against what EduBridge recorded: deposits of cash and
 * cheques, families' bank payments and expenses. Open items on both sides are what someone must look into.
 */
export default async function BankStatementsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ account?: string; month?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const show = moneyFormatter(ctx.tenant.currencyCode);
  const banks = (await listFinanceAccounts(db(), ctx)).filter((a) => a.kind === "bank");
  if (banks.length === 0)
    return (
      <p className="text-base text-ink-2">
        Add the school&apos;s bank account under{" "}
        <Link href={schoolPath(slug, "finance/accounts") as Route} className="text-accent hover:underline">
          Accounts
        </Link>{" "}
        first.
      </p>
    );
  const account = banks.find((b) => b.id === search.account) ?? banks[0]!;
  const month =
    search.month && /^\d{4}-\d{2}$/.test(search.month)
      ? search.month
      : todayIn(ctx.tenant.timezone).slice(0, 7);
  const rec = await getReconciliation(db(), ctx, account.id, month);
  const canManage = allowed(ctx, "finance.manage");
  const amountCell = (minor: number) => (
    <span className={minor < 0 ? "text-ink" : "text-positive"}>
      {minor < 0 ? `−${show(-minor)}` : `+${show(minor)}`}
    </span>
  );

  return (
    <div className="space-y-12">
      <form method="get" className="flex flex-wrap items-end gap-3">
        <Field label="Account">
          {(p) => (
            <Select {...p} name="account" defaultValue={account.id}>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.status === "closed" ? " (closed)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Month">{(p) => <Input {...p} type="month" name="month" defaultValue={month} />}</Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {canManage && (
        <Section
          title="Import a statement"
          description={`For ${account.name}. Columns read: a date, a description, a reference, and an amount (or debit and credit).`}
        >
          <StatementUploadForm action={importStatementAction.bind(null, slug, account.id)} />
        </Section>
      )}

      <Section
        title={`${monthName(month)}: ${account.name}`}
        description={
          rec.lines.length === 0
            ? "No statement lines for this month yet."
            : `${show(rec.summary.inPesewas)} in, ${show(rec.summary.outPesewas)} out. ${
                rec.summary.unmatchedLines === 0
                  ? "Every line is matched or explained."
                  : `${rec.summary.unmatchedLines} line${rec.summary.unmatchedLines === 1 ? "" : "s"} for ${show(rec.summary.unmatchedPesewas)} still to match.`
              }`
        }
        aside={
          canManage && rec.summary.unmatchedLines > 0 ? (
            <ActionButton action={rematchAction.bind(null, slug, account.id)} label="Match again" />
          ) : null
        }
      >
        {rec.lines.length > 0 && (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Line</TH>
                  <TH numeric>Amount</TH>
                  <TH>Matched to</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {rec.lines.map((l) => (
                  <TR key={l.id}>
                    <TD>{formatCalendarDate(l.lineOn)}</TD>
                    <TD>
                      {l.description}
                      {l.reference && <span className="block text-sm text-ink-3">{l.reference}</span>}
                    </TD>
                    <TD numeric>{amountCell(l.amountPesewas)}</TD>
                    <TD>
                      {l.match ? (
                        <StatusText tone="positive">
                          {l.match.kind === "other" ? `Explained: ${l.match.label}` : l.match.label}
                          {l.match.automatic ? " (automatic)" : ""}
                        </StatusText>
                      ) : l.candidates.length > 0 ? (
                        <span className="text-sm text-ink-2">
                          Could be: {l.candidates.map((c) => c.label).join("; ")}
                        </span>
                      ) : (
                        <StatusText tone="caution">Nothing in EduBridge matches</StatusText>
                      )}
                    </TD>
                    <TD>
                      {canManage && (
                        <RowActions>
                          {l.match ? (
                            <ActionButton
                              action={unmatchLineAction.bind(null, slug, l.id)}
                              label="Unmatch"
                              variant="danger-outline"
                              ariaLabel={`Unmatch the line of ${formatCalendarDate(l.lineOn)}`}
                            />
                          ) : (
                            <>
                              {l.candidates.map((c) => (
                                <ActionButton
                                  key={`${c.kind}:${c.id}`}
                                  action={matchLineAction.bind(null, slug, l.id, c.kind, c.id)}
                                  label={`Match ${c.label.split(" (")[0]}`}
                                />
                              ))}
                              <ExplainLineDialog
                                action={explainLineAction.bind(null, slug, l.id)}
                                label={`Explain the line of ${formatCalendarDate(l.lineOn)}`}
                              />
                            </>
                          )}
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

      <div className="grid gap-12 lg:grid-cols-2">
        <Section
          title="Deposits not on a statement"
          description="Recorded in EduBridge up to this month, not found on any imported statement line."
        >
          {rec.depositsNotOnStatement.length === 0 ? (
            <p className="text-base text-ink-2">None.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {rec.depositsNotOnStatement.map((d) => (
                <li key={d.id} className="flex justify-between gap-3 px-4 py-2.5 text-base">
                  <span>
                    {d.label} <span className="text-sm text-ink-3">{formatCalendarDate(d.on)}</span>
                  </span>
                  <span className="tabular-nums">{show(d.amountPesewas)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Expenses not on a statement"
          description="Paid from this account up to this month, not found on any imported statement line."
        >
          {rec.expensesNotOnStatement.length === 0 ? (
            <p className="text-base text-ink-2">None.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {rec.expensesNotOnStatement.map((e) => (
                <li key={e.id} className="flex justify-between gap-3 px-4 py-2.5 text-base">
                  <span>
                    {e.label} <span className="text-sm text-ink-3">{formatCalendarDate(e.on)}</span>
                  </span>
                  <span className="tabular-nums">{show(e.amountPesewas)}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
