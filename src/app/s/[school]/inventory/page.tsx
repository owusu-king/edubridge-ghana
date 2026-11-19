import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listStockItems } from "@/server/inventory/stock";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveStockItemAction } from "./actions";
import { StockItemDialog } from "./inventory-controls";

export const metadata: Metadata = { title: "Inventory · Stock" };

/** What the school keeps in stock and how much is on hand (INV-01a, INV-01b). */
export default async function StockPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  // Staff who only report repairs land on Maintenance.
  if (!allowed(ctx, "inventory.view")) redirect(schoolPath(slug, "inventory/maintenance"));
  const manage = allowed(ctx, "inventory.manage");
  const items = await listStockItems(db(), ctx);
  const low = items.filter((i) => i.low).length;

  return (
    <Section
      title="Stock"
      description={
        items.length
          ? low
            ? `${low} ${low === 1 ? "item is" : "items are"} at or below the reorder level.`
            : "Nothing is low."
          : undefined
      }
      aside={manage ? <StockItemDialog action={saveStockItemAction.bind(null, slug, null)} /> : undefined}
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No stock items yet"
          description="Add the things the school keeps, such as paper, chalk and cleaning supplies, then receive what you have."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Stock items</caption>
            <THead>
              <tr>
                <TH>Item</TH>
                <TH className="hidden sm:table-cell">Category</TH>
                <TH className="text-right">On hand</TH>
                <TH className="hidden text-right md:table-cell">Reorder at</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((i) => (
                <TR key={i.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `inventory/stock/${i.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {i.name}
                    </Link>
                    {i.status === "archived" && (
                      <span className="block">
                        <StatusText tone="neutral">Archived</StatusText>
                      </span>
                    )}
                  </TD>
                  <TD className="hidden sm:table-cell">{i.category ?? "—"}</TD>
                  <TD className="text-right tabular-nums">
                    {i.low ? (
                      <StatusText tone="caution">
                        {i.onHand} {i.unit}
                      </StatusText>
                    ) : (
                      `${i.onHand} ${i.unit}`
                    )}
                  </TD>
                  <TD className="hidden text-right tabular-nums md:table-cell">{i.reorderLevel ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
