import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { StudentAccount } from "@/server/fees/ledger";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { cn } from "@/lib/cn";
import { reverseEntryAction } from "./account-actions";
import { ReverseEntryDialog } from "./account-controls";

function balanceText(pesewas: number): string {
  if (pesewas > 0) return `${formatCedis(pesewas)} owed`;
  if (pesewas < 0) return `${formatCedis(-pesewas)} in credit`;
  return "Nothing owed";
}

/** The student's fee statement: every entry, oldest first, with a running balance. */
export function FeeAccount({
  slug,
  account,
  canManage,
}: {
  slug: string;
  account: StudentAccount;
  canManage: boolean;
}) {
  return (
    <Section
      title="Fees"
      aside={
        <p className="text-base font-semibold text-ink tabular-nums">{balanceText(account.balancePesewas)}</p>
      }
    >
      {account.entries.length === 0 ? (
        <p className="text-base text-ink-3">No fees billed yet.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Fee statement for {account.student.name}</caption>
            <THead>
              <tr>
                <TH className="hidden sm:table-cell">Date</TH>
                <TH>Entry</TH>
                <TH className="text-right">Amount</TH>
                <TH className="hidden text-right sm:table-cell">Balance</TH>
                {canManage && (
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {account.entries.map((entry) => (
                <TR key={entry.id}>
                  <TD className="hidden whitespace-nowrap sm:table-cell">
                    {formatCalendarDate(entry.effectiveOn)}
                  </TD>
                  <TD>
                    <span className={cn("text-ink", entry.reversed && "text-ink-3 line-through")}>
                      {entry.description}
                    </span>
                    <span className="block text-sm text-ink-3 sm:hidden">
                      {formatCalendarDate(entry.effectiveOn)}
                    </span>
                    {entry.reversed && <span className="block text-sm text-ink-3">Reversed</span>}
                  </TD>
                  <TD className="text-right whitespace-nowrap tabular-nums">
                    {formatCedis(entry.amountPesewas)}
                  </TD>
                  <TD className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                    {formatCedis(entry.balancePesewas)}
                  </TD>
                  {canManage && (
                    <TD className="text-right">
                      {!entry.reversed && entry.kind !== "reversal" && (
                        <ReverseEntryDialog
                          action={reverseEntryAction.bind(null, slug, account.student.id, entry.id)}
                          description={entry.description}
                          amount={formatCedis(entry.amountPesewas)}
                        />
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
