import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getPurchaseRequest } from "@/server/inventory/purchases";
import { formatDateTime } from "@/lib/format";
import { lineTotal, PURCHASE_STATUS_LABELS, PURCHASE_TONE } from "@/lib/inventory";
import { formatMoney } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { cancelPurchaseAction, decidePurchaseAction, receivePurchaseAction } from "../../actions";
import { NoteDialog, ReceiveForm } from "../../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Purchase request" };

/** One purchase request: its lines, the decision, and what arrived (INV-02b). */
export default async function PurchaseRequestPage({
  params,
}: {
  params: Promise<{ school: string; requestId: string }>;
}) {
  const { school, requestId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const r = await getPurchaseRequest(db(), ctx, requestId);
  if (!r) notFound();
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const tz = ctx.tenant.timezone;
  const mine = r.requestedByUserId === ctx.userId;
  const canDecide = r.status === "pending" && allowed(ctx, "purchases.approve") && !mine;
  const office = allowed(ctx, "inventory.manage") || allowed(ctx, "purchases.approve");
  const canCancel =
    allowed(ctx, "purchases.request") &&
    ((r.status === "pending" && (mine || office)) || (r.status === "approved" && office));
  const canReceive = r.status === "approved" && allowed(ctx, "inventory.manage");
  const received = r.status === "received";

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "inventory/purchases") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Purchase requests
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">
            {r.reference} · {r.title}
          </h2>
          <p className="mt-1 text-base text-ink-2">
            Asked by {r.requestedBy}, {formatDateTime(r.requestedAt, tz)}
            {r.supplier && ` · from ${r.supplier}`}
          </p>
          <StatusText tone={PURCHASE_TONE[r.status]}>{PURCHASE_STATUS_LABELS[r.status]}</StatusText>
        </div>
        {(canDecide || canCancel) && (
          <div className="flex flex-wrap items-center gap-2">
            {canDecide && (
              <>
                <ActionButton
                  action={decidePurchaseAction.bind(null, slug, r.id, true)}
                  label="Approve"
                  variant="primary"
                />
                <NoteDialog
                  action={decidePurchaseAction.bind(null, slug, r.id, false)}
                  trigger="Decline"
                  title={`Decline ${r.reference}`}
                  label="Why it is declined"
                  name="note"
                  required
                  submitLabel="Decline"
                  danger
                />
              </>
            )}
            {canCancel && (
              <NoteDialog
                action={cancelPurchaseAction.bind(null, slug, r.id)}
                trigger="Cancel request"
                title={`Cancel ${r.reference}`}
                description="It stays on record, marked cancelled."
                label="Why"
                name="note"
                required={false}
                submitLabel="Cancel request"
                danger
              />
            )}
          </div>
        )}
      </div>

      {r.reason && <p className="max-w-2xl text-base text-ink-2">{r.reason}</p>}
      {mine && r.status === "pending" && allowed(ctx, "purchases.approve") && (
        <p className="text-sm text-ink-3">This is your own request: someone else must decide on it.</p>
      )}

      <Section title="What to buy">
        <TableFrame>
          <Table>
            <caption className="sr-only">Lines of {r.reference}</caption>
            <THead>
              <tr>
                <TH>Item</TH>
                <TH className="text-right">Quantity</TH>
                <TH className="hidden text-right sm:table-cell">Unit price</TH>
                <TH className="text-right">Estimate</TH>
                {received && <TH className="text-right">Arrived</TH>}
              </tr>
            </THead>
            <TBody>
              {r.lines.map((l) => (
                <TR key={l.id}>
                  <TD>
                    {l.description}
                    {l.stockItem && <span className="block text-sm text-ink-3">Stock: {l.stockItem}</span>}
                  </TD>
                  <TD className="text-right tabular-nums">{l.quantity}</TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">
                    {l.unitPriceMinor === null ? "—" : formatMoney(l.unitPriceMinor, currency)}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {l.unitPriceMinor === null ? "—" : formatMoney(lineTotal(l), currency)}
                  </TD>
                  {received && <TD className="text-right tabular-nums">{l.receivedQuantity ?? "—"}</TD>}
                </TR>
              ))}
              <TR>
                <TD className="font-medium text-ink">Total</TD>
                <TD />
                <TD className="hidden sm:table-cell" />
                <TD className="text-right font-medium text-ink tabular-nums">
                  {formatMoney(r.totalMinor, currency)}
                </TD>
                {received && <TD />}
              </TR>
            </TBody>
          </Table>
        </TableFrame>
      </Section>

      {(r.decidedAt || r.closedAt) && (
        <Section title="What happened">
          <ul className="divide-y divide-line border-y border-line">
            {r.decidedAt && (
              <li className="py-3 text-base text-ink">
                {r.status === "declined" ? "Declined" : "Approved"} by {r.decidedBy}
                {r.decisionNote && `: ${r.decisionNote}`}
                <span className="block text-sm text-ink-3">{formatDateTime(r.decidedAt, tz)}</span>
              </li>
            )}
            {r.closedAt && (
              <li className="py-3 text-base text-ink">
                {r.status === "received" ? "Received" : "Cancelled"} by {r.closedBy}
                {r.closingNote && `: ${r.closingNote}`}
                <span className="block text-sm text-ink-3">{formatDateTime(r.closedAt, tz)}</span>
              </li>
            )}
          </ul>
        </Section>
      )}

      {canReceive && (
        <Section
          title="Receive"
          description="When the goods arrive, record how many of each came. Lines with a stock item are added to stock."
        >
          <ReceiveForm action={receivePurchaseAction.bind(null, slug, r.id)} lines={r.lines} />
        </Section>
      )}
    </div>
  );
}
