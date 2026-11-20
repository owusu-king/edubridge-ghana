import type { Metadata } from "next";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { RowActions, Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AccountDialog, ActionButton } from "@/components/finance/finance-forms";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listFinanceAccounts } from "@/server/finance/service";
import { ACCOUNT_KIND_LABELS } from "@/lib/school-finance";
import { requireTenant } from "@/web/auth";
import { saveAccountAction, setAccountStatusAction } from "../actions";

export const metadata: Metadata = { title: "Finances · Accounts" };

/** Where the school keeps money: bank accounts, the cash box, a Mobile Money wallet. */
export default async function AccountsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const accounts = await listFinanceAccounts(db(), ctx);
  const canManage = allowed(ctx, "finance.manage");
  return (
    <Section
      title="Accounts"
      description="Deposits go into a bank account; every expense says which account paid it."
      aside={canManage ? <AccountDialog action={saveAccountAction.bind(null, slug, null)} /> : null}
    >
      {accounts.length === 0 ? (
        <p className="text-base text-ink-2">
          No accounts yet. Add the school&apos;s bank account and cash box.
        </p>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Kind</TH>
                <TH>Bank or network</TH>
                <TH>Status</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {accounts.map((a) => (
                <TR key={a.id}>
                  <TD>{a.name}</TD>
                  <TD>{ACCOUNT_KIND_LABELS[a.kind]}</TD>
                  <TD>
                    {[a.institution, a.accountEnding ? `ending ${a.accountEnding}` : null]
                      .filter(Boolean)
                      .join(", ")}
                  </TD>
                  <TD>
                    <StatusText tone={a.status === "active" ? "positive" : "neutral"}>
                      {a.status === "active" ? "Open" : "Closed"}
                    </StatusText>
                  </TD>
                  <TD>
                    {canManage && (
                      <RowActions>
                        <AccountDialog action={saveAccountAction.bind(null, slug, a.id)} account={a} />
                        <ActionButton
                          action={setAccountStatusAction.bind(
                            null,
                            slug,
                            a.id,
                            a.status === "active" ? "closed" : "active",
                          )}
                          label={a.status === "active" ? "Close" : "Reopen"}
                          variant={a.status === "active" ? "danger-outline" : "secondary"}
                          ariaLabel={`${a.status === "active" ? "Close" : "Reopen"} ${a.name}`}
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
  );
}
