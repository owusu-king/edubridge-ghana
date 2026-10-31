import type { Metadata } from "next";
import { ReceiptText } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listFeeItems, SUGGESTED_FEE_ITEMS } from "@/server/fees/structure";
import { requireTenant } from "@/web/auth";
import {
  addFeeItemAction,
  renameFeeItemAction,
  setFeeItemStatusAction,
  setupFeeItemsAction,
} from "../actions";
import {
  AddFeeItemDialog,
  FeeItemStatusDialog,
  RenameFeeItemDialog,
  SetupFeeItemsDialog,
} from "../fee-controls";

export const metadata: Metadata = { title: "Fees · Fee items" };

export default async function FeeItemsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const canManage = can(ctx.roles, "fees.manage") && ctx.campusIds === null;
  const items = await listFeeItems(db(), ctx);

  return (
    <Section
      title="Fee items"
      description="What your school charges for. Items appear in this order on bills and receipts."
      aside={canManage && items.length > 0 && <AddFeeItemDialog action={addFeeItemAction.bind(null, slug)} />}
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<ReceiptText />}
          title="No fee items yet"
          description={
            canManage
              ? "Start with the items most basic schools charge, or add your own."
              : "Your school has not set up its fee items yet."
          }
          action={
            canManage && (
              <div className="flex flex-wrap justify-center gap-2">
                <SetupFeeItemsDialog
                  action={setupFeeItemsAction.bind(null, slug)}
                  names={SUGGESTED_FEE_ITEMS}
                />
                <AddFeeItemDialog action={addFeeItemAction.bind(null, slug)} />
              </div>
            )
          }
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Fee items</caption>
            <THead>
              <tr>
                <TH>Item</TH>
                <TH>Status</TH>
                {canManage && (
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {items.map((item) => (
                <TR key={item.id}>
                  <TD className="font-medium text-ink">{item.name}</TD>
                  <TD>
                    {item.status === "active" ? (
                      <StatusText tone="positive">In use</StatusText>
                    ) : (
                      <StatusText tone="neutral">Archived</StatusText>
                    )}
                  </TD>
                  {canManage && (
                    <TD className="text-right whitespace-nowrap">
                      <RenameFeeItemDialog
                        action={renameFeeItemAction.bind(null, slug, item.id)}
                        name={item.name}
                      />
                      <FeeItemStatusDialog
                        action={setFeeItemStatusAction.bind(
                          null,
                          slug,
                          item.id,
                          item.status === "active" ? "archived" : "active",
                        )}
                        name={item.name}
                        archived={item.status === "archived"}
                      />
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
