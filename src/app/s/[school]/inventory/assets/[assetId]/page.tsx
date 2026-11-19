import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { DescriptionList, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getAsset, listCustodianOptions } from "@/server/inventory/assets";
import { listSuppliers } from "@/server/inventory/suppliers";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { CONDITION_LABELS } from "@/lib/inventory";
import { formatMoney, minorToInput } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { changeAssetAction, disposeAssetAction, updateAssetAction } from "../../actions";
import { AssetDetailsDialog, ChangeAssetDialog, NoteDialog } from "../../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Asset" };

const EVENT_LABELS = {
  added: "Added",
  moved: "Moved",
  custodian: "Handed over",
  condition: "Condition",
  disposed: "Disposed of",
} as const;

/** One asset: its details and its history of moves, custodians and condition (INV-01c). */
export default async function AssetPage({
  params,
}: {
  params: Promise<{ school: string; assetId: string }>;
}) {
  const { school, assetId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const data = await getAsset(db(), ctx, assetId);
  if (!data) notFound();
  const { asset, events } = data;
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const tz = ctx.tenant.timezone;
  const manage = allowed(ctx, "inventory.manage") && asset.status === "active";
  const [suppliers, custodians] = manage
    ? await Promise.all([listSuppliers(db(), ctx), listCustodianOptions(db(), ctx)])
    : [[], []];

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "inventory/assets") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Assets
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">
            <span className="tabular-nums">{asset.tag}</span> · {asset.name}
          </h2>
          {asset.status === "disposed" ? (
            <StatusText tone="neutral">Disposed of: {asset.disposalReason}</StatusText>
          ) : (
            <p className="mt-1 text-base text-ink-2">{CONDITION_LABELS[asset.condition]} condition</p>
          )}
        </div>
        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            <ChangeAssetDialog
              action={changeAssetAction.bind(null, slug, asset.id)}
              asset={{
                location: asset.location,
                custodianMembershipId: asset.custodianMembershipId,
                custodianName: asset.custodianMembershipId ? null : asset.custodian,
                condition: asset.condition,
              }}
              custodians={custodians}
            />
            <AssetDetailsDialog
              action={updateAssetAction.bind(null, slug, asset.id)}
              asset={{ ...asset, cost: minorToInput(asset.costMinor, currency) }}
              suppliers={suppliers.filter((s) => s.status === "active" || s.id === asset.supplierId)}
              currency={currency}
            />
            <NoteDialog
              action={disposeAssetAction.bind(null, slug, asset.id)}
              trigger="Dispose of"
              title={`Dispose of ${asset.tag}`}
              description="Sold, scrapped, lost or stolen. It stays in the register, marked disposed of, and cannot be changed after."
              label="Why"
              name="reason"
              required
              submitLabel="Dispose of"
              danger
            />
          </div>
        )}
      </div>

      <DescriptionList
        items={[
          { term: "Location", detail: asset.location ?? "—" },
          { term: "Custodian", detail: asset.custodian ?? "—" },
          { term: "Category", detail: asset.category ?? "—" },
          { term: "Serial number", detail: asset.serialNumber ?? "—" },
          { term: "Acquired", detail: asset.acquiredOn ? formatCalendarDate(asset.acquiredOn) : "—" },
          { term: "Cost", detail: asset.costMinor === null ? "—" : formatMoney(asset.costMinor, currency) },
          { term: "Supplier", detail: asset.supplier ?? "—" },
          ...(asset.note ? [{ term: "Note", detail: asset.note }] : []),
        ]}
      />

      <Section
        title="History"
        description="Every move, hand-over and change of condition. None can be edited."
      >
        <ul className="divide-y divide-line border-y border-line">
          {events.map((e) => (
            <li key={e.id} className="py-3 text-base text-ink">
              <span className="font-medium">{EVENT_LABELS[e.kind]}</span>: {e.detail}
              {e.note && <span className="block text-sm text-ink-2">{e.note}</span>}
              <span className="block text-sm text-ink-3">
                {formatDateTime(e.at, tz)} · {e.by}
              </span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
