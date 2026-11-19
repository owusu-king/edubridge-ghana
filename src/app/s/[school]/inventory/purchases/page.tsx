import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listPurchaseRequests } from "@/server/inventory/purchases";
import { listStockChoices } from "@/server/inventory/stock";
import { listSuppliers } from "@/server/inventory/suppliers";
import { formatDateTime } from "@/lib/format";
import { PURCHASE_STATUS_LABELS, PURCHASE_TONE } from "@/lib/inventory";
import { formatMoney } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { createPurchaseAction } from "../actions";
import { PurchaseDialog } from "../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Purchases" };

/** Purchase requests (INV-02b): those waiting for the Proprietor first. */
export default async function PurchasesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const request = allowed(ctx, "purchases.request");
  const [requests, suppliers, stock] = await Promise.all([
    listPurchaseRequests(db(), ctx),
    request ? listSuppliers(db(), ctx) : Promise.resolve([]),
    request ? listStockChoices(db(), ctx) : Promise.resolve([]),
  ]);
  const waiting = requests.filter((r) => r.status === "pending").length;

  return (
    <Section
      title="Purchase requests"
      description={
        waiting
          ? `${waiting} waiting for the Proprietor's approval. EduBridge records requests; it does not pay suppliers.`
          : "EduBridge records requests and what arrived; it does not pay suppliers."
      }
      aside={
        request ? (
          <PurchaseDialog
            action={createPurchaseAction.bind(null, slug)}
            suppliers={suppliers.filter((s) => s.status === "active")}
            stockItems={stock}
            currency={currency}
          />
        ) : undefined
      }
    >
      {requests.length === 0 ? (
        <p className="text-base text-ink-3">No purchase requests yet.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Purchase requests</caption>
            <THead>
              <tr>
                <TH>Request</TH>
                <TH>Status</TH>
                <TH className="hidden text-right sm:table-cell">Estimate</TH>
                <TH className="hidden md:table-cell">Asked by</TH>
              </tr>
            </THead>
            <TBody>
              {requests.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `inventory/purchases/${r.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {r.reference} · {r.title}
                    </Link>
                    {r.supplier && <span className="block text-sm text-ink-3">{r.supplier}</span>}
                  </TD>
                  <TD>
                    <StatusText tone={PURCHASE_TONE[r.status]}>{PURCHASE_STATUS_LABELS[r.status]}</StatusText>
                  </TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">
                    {r.totalMinor ? formatMoney(r.totalMinor, currency) : "—"}
                  </TD>
                  <TD className="hidden md:table-cell">
                    {r.requestedBy}
                    <span className="block text-sm text-ink-3">
                      {formatDateTime(r.requestedAt, ctx.tenant.timezone)}
                    </span>
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
