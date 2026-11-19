import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAssets, listCustodianOptions } from "@/server/inventory/assets";
import { listSuppliers } from "@/server/inventory/suppliers";
import { CONDITION_LABELS } from "@/lib/inventory";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { addAssetAction } from "../actions";
import { AssetDialog } from "../inventory-controls";

export const metadata: Metadata = { title: "Inventory · Assets" };

const TONE = {
  new: "positive",
  good: "positive",
  fair: "neutral",
  poor: "caution",
  broken: "critical",
} as const;

/** The asset register (INV-01c): tag, where it is, who has it and its condition. */
export default async function AssetsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "inventory.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "inventory.manage");
  const [assets, suppliers, custodians] = await Promise.all([
    listAssets(db(), ctx),
    manage ? listSuppliers(db(), ctx) : Promise.resolve([]),
    manage ? listCustodianOptions(db(), ctx) : Promise.resolve([]),
  ]);
  const inUse = assets.filter((a) => a.status === "active").length;

  return (
    <Section
      title="Assets"
      description={
        assets.length
          ? `${inUse} in use${assets.length > inUse ? `, ${assets.length - inUse} disposed of` : ""}.`
          : undefined
      }
      aside={
        manage ? (
          <AssetDialog
            action={addAssetAction.bind(null, slug)}
            suppliers={suppliers.filter((s) => s.status === "active")}
            custodians={custodians}
            currency={ctx.tenant.currencyCode}
          />
        ) : undefined
      }
    >
      {assets.length === 0 ? (
        <p className="text-base text-ink-3">
          No assets yet. Add furniture, computers, projectors and other things the school owns.
        </p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Asset register</caption>
            <THead>
              <tr>
                <TH>Asset</TH>
                <TH className="hidden sm:table-cell">Location</TH>
                <TH className="hidden md:table-cell">Custodian</TH>
                <TH>Condition</TH>
              </tr>
            </THead>
            <TBody>
              {assets.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `inventory/assets/${a.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      <span className="tabular-nums">{a.tag}</span> · {a.name}
                    </Link>
                    {a.category && <span className="block text-sm text-ink-3">{a.category}</span>}
                  </TD>
                  <TD className="hidden sm:table-cell">{a.location ?? "—"}</TD>
                  <TD className="hidden md:table-cell">{a.custodian ?? "—"}</TD>
                  <TD>
                    {a.status === "disposed" ? (
                      <StatusText tone="neutral">Disposed of</StatusText>
                    ) : (
                      <StatusText tone={TONE[a.condition]}>{CONDITION_LABELS[a.condition]}</StatusText>
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
