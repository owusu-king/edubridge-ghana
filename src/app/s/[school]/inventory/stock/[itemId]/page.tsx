import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStockItem } from "@/server/inventory/stock";
import { listSuppliers } from "@/server/inventory/suppliers";
import { formatDateTime } from "@/lib/format";
import { MOVEMENT_LABELS } from "@/lib/inventory";
import { formatMoney } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { recordMovementAction, saveStockItemAction, setStockItemArchivedAction } from "../../actions";
import { MovementDialog, StockItemDialog } from "../../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Item" };

/** One stock item: on hand, receive, issue, correct the count, and every movement (INV-01a). */
export default async function StockItemPage({
  params,
}: {
  params: Promise<{ school: string; itemId: string }>;
}) {
  const { school, itemId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const data = await getStockItem(db(), ctx, itemId);
  if (!data) notFound();
  const { item, movements } = data;
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const tz = ctx.tenant.timezone;
  const manage = allowed(ctx, "inventory.manage") && item.status === "active";
  const suppliers = manage ? (await listSuppliers(db(), ctx)).filter((s) => s.status === "active") : [];
  const move = recordMovementAction.bind(null, slug, item.id);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "inventory") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Stock
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">{item.name}</h2>
          <p className="mt-1 text-base text-ink-2">
            <span className="font-medium text-ink tabular-nums">
              {item.onHand} {item.unit}
            </span>{" "}
            on hand
            {item.reorderLevel !== null && ` · reorder at ${item.reorderLevel}`}
            {item.category && ` · ${item.category}`}
          </p>
          {item.low && <StatusText tone="caution">Low: order more</StatusText>}
          {item.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
        </div>
        {allowed(ctx, "inventory.manage") && (
          <div className="flex flex-wrap items-center gap-2">
            {manage && (
              <>
                <MovementDialog
                  action={move}
                  kind="received"
                  unit={item.unit}
                  onHand={item.onHand}
                  suppliers={suppliers}
                  currency={currency}
                />
                <MovementDialog
                  action={move}
                  kind="issued"
                  unit={item.unit}
                  onHand={item.onHand}
                  suppliers={[]}
                  currency={currency}
                />
                <MovementDialog
                  action={move}
                  kind="counted"
                  unit={item.unit}
                  onHand={item.onHand}
                  suppliers={[]}
                  currency={currency}
                />
                <StockItemDialog action={saveStockItemAction.bind(null, slug, item.id)} item={item} />
              </>
            )}
            <ActionButton
              action={setStockItemArchivedAction.bind(null, slug, item.id, item.status === "active")}
              label={item.status === "active" ? "Archive" : "Restore"}
              variant={item.status === "active" ? "danger-outline" : "secondary"}
              ariaLabel={`${item.status === "active" ? "Archive" : "Restore"} ${item.name}`}
            />
          </div>
        )}
      </div>

      <Section
        title="Movements"
        description="Every change to stock, newest first. None can be edited or removed."
      >
        {movements.length === 0 ? (
          <p className="text-base text-ink-3">Nothing recorded yet. Receive what you have to start.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Stock movements of {item.name}</caption>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Movement</TH>
                  <TH className="text-right">Quantity</TH>
                  <TH className="hidden md:table-cell">Details</TH>
                  <TH className="hidden lg:table-cell">By</TH>
                </tr>
              </THead>
              <TBody>
                {movements.map((m) => (
                  <TR key={m.id}>
                    <TD className="whitespace-nowrap">{formatDateTime(m.recordedAt, tz)}</TD>
                    <TD>{MOVEMENT_LABELS[m.kind]}</TD>
                    <TD className="text-right tabular-nums">
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </TD>
                    <TD className="hidden md:table-cell">
                      {[
                        m.issuedTo && `to ${m.issuedTo}`,
                        m.supplier && `from ${m.supplier}`,
                        m.unitCostMinor !== null && `${formatMoney(m.unitCostMinor, currency)} each`,
                        m.purchaseRequestId && "from a purchase request",
                        m.reason,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </TD>
                    <TD className="hidden lg:table-cell">{m.recordedBy}</TD>
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
