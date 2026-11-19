import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TGroupLabel, TH, THead, TR } from "@/components/ui/table";
import { listPresets } from "@/server/billing/plans";
import { PERMISSION_MODULES } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getCatalog, type CatalogPrice } from "@/server/entitlements/admin";
import { SUPPORTED_CURRENCIES } from "@/server/platform/service";
import { formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import {
  MODULE_CATEGORIES,
  MODULE_LIST,
  MODULE_STAGE_LABELS,
  MODULES,
  isModuleId,
  type ModuleDefinition,
} from "@/lib/modules";
import { BILLING_PERIOD_LABELS } from "@/lib/plan";
import { requirePlatformAdmin } from "@/web/auth";
import { archiveCatalogPriceAction, setCatalogPriceAction, setReadOnlyDaysAction } from "../module-actions";
import { ReadOnlyDaysForm, SetPriceDialog } from "./module-controls";

export const metadata: Metadata = { title: "Modules" };

const STAGE_TONE = {
  planned: "neutral",
  in_development: "neutral",
  internal_testing: "caution",
  ready: "caution",
  pilot: "accent",
  general: "positive",
  deprecated: "caution",
  retired: "neutral",
} as const;

function sold(def: ModuleDefinition): string {
  if (def.availability === "core") return "In every plan";
  if (def.stage === "planned") return "Not decided";
  if (!def.purchasable) return "In plans only";
  return "In plans, or as an add-on";
}

function PriceList({ prices }: { prices: CatalogPrice[] }) {
  if (!prices.length) return <span className="text-ink-3">No price set</span>;
  return (
    <ul className="space-y-1">
      {prices.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-2">
          <span>
            {formatMoney(p.pricePesewas, p.currencyCode)}{" "}
            {BILLING_PERIOD_LABELS[p.billingPeriod].toLowerCase()}
            {p.unit === "per_student" ? ", per student" : ""}
          </span>
          <ActionButton
            action={archiveCatalogPriceAction.bind(null, p.id)}
            label="Remove"
            ariaLabel={`Remove the price ${formatMoney(p.pricePesewas, p.currencyCode)} ${BILLING_PERIOD_LABELS[p.billingPeriod].toLowerCase()}`}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The module registry as platform staff see it (SUB-10): every module, its release stage, how it is sold,
 * what it needs, which permissions belong to it, how many schools have it, and the catalogue prices.
 */
export default async function ModulesPage() {
  const user = await requirePlatformAdmin();
  const [catalog, presets] = await Promise.all([getCatalog(db(), user.id), listPresets(db(), user.id)]);
  const byModule = new Map<string, (typeof catalog.modules)[number]>(catalog.modules.map((m) => [m.id, m]));
  const permissionsOf = (id: string) =>
    Object.entries(PERMISSION_MODULES)
      .filter(([, m]) => m === id)
      .map(([p]) => p);
  const activePresets = presets.filter((p) => !p.archived);
  const targets = [
    ...activePresets.map((p) => ({ value: `plan:${p.id}`, label: p.name, group: "Plans" as const })),
    ...catalog.modules
      .filter((m) => MODULES[m.id].purchasable)
      .map((m) => ({ value: `module:${m.id}`, label: MODULES[m.id].name, group: "Modules" as const })),
  ];

  return (
    <div className="space-y-10">
      <PageHeader
        title="Modules"
        description="Everything a school can have, how it is released and how it is sold. A module being built is never available to schools; a module in a plan reaches a school only once it is released to it."
        actions={
          <SetPriceDialog
            action={setCatalogPriceAction}
            targets={targets}
            currencies={SUPPORTED_CURRENCIES}
          />
        }
      />

      {/* Every category in one table, so the columns line up all the way down. */}
      <Section title="Modules">
        <TableFrame>
          <Table>
            <caption className="sr-only">Modules by category</caption>
            <THead>
              <tr>
                <TH>Module</TH>
                <TH>Stage</TH>
                <TH>Sold</TH>
                <TH>With it</TH>
                <TH>Catalogue price</TH>
              </tr>
            </THead>
            {(Object.keys(MODULE_CATEGORIES) as (keyof typeof MODULE_CATEGORIES)[]).map((category) => {
              const defs = MODULE_LIST.filter((d) => d.category === category);
              if (!defs.length) return null;
              return (
                <TBody key={category}>
                  <TGroupLabel colSpan={5}>{MODULE_CATEGORIES[category]}</TGroupLabel>
                  {defs.map((def) => {
                    const row = byModule.get(def.id);
                    const permissions = permissionsOf(def.id);
                    return (
                      <TR key={def.id}>
                        <TD className="max-w-md">
                          <span className="font-medium text-ink">{def.name}</span>
                          <span className="block text-sm text-ink-3">{def.description}</span>
                          <span className="mt-1 block font-mono text-xs text-ink-3">
                            {def.id} · {def.release}
                            {def.requires.length ? ` · needs ${def.requires.join(", ")}` : ""}
                            {permissions.length ? ` · ${permissions.join(", ")}` : ""}
                          </span>
                        </TD>
                        <TD>
                          <Badge tone={STAGE_TONE[def.stage]}>{MODULE_STAGE_LABELS[def.stage]}</Badge>
                        </TD>
                        <TD>{sold(def)}</TD>
                        <TD>
                          {def.availability === "core" ? (
                            "All"
                          ) : (
                            <>
                              {row?.schools ?? 0}
                              {row && row.releaseSchools > 0 && (
                                <span className="block text-sm text-ink-3">
                                  {row.releaseSchools} with release access
                                </span>
                              )}
                            </>
                          )}
                        </TD>
                        <TD>
                          {def.availability === "core" ? (
                            "Included"
                          ) : (
                            <PriceList prices={row?.prices ?? []} />
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              );
            })}
          </Table>
        </TableFrame>
      </Section>

      <Section
        title="Plan prices"
        description="Catalogue prices for each plan, by billing period and currency. A school's agreed price stays on its own page."
      >
        {activePresets.length === 0 ? (
          <p className="text-base text-ink-3">No plans yet. Create them under Plans.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Plan prices</caption>
              <THead>
                <tr>
                  <TH>Plan</TH>
                  <TH>Catalogue price</TH>
                </tr>
              </THead>
              <TBody>
                {activePresets.map((p) => (
                  <TR key={p.id}>
                    <TD>{p.name}</TD>
                    <TD>
                      <PriceList prices={catalog.presetPrices.filter((c) => c.presetId === p.id)} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section
        title="When a module ends"
        description="For add-ons, trials and promotions of modules from R4 on."
      >
        <ReadOnlyDaysForm action={setReadOnlyDaysAction} days={catalog.readOnlyDays} />
      </Section>

      <Section
        title="Recent changes"
        description="Prices, release access and modules added or ended, newest first."
      >
        {catalog.events.length === 0 ? (
          <p className="text-base text-ink-3">Nothing changed yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line text-sm">
            {catalog.events.map((e, i) => (
              <li key={i} className="flex flex-col gap-1 py-3 sm:flex-row sm:justify-between">
                <span className="text-ink">
                  {describeEvent(e.action, e.metadata)}
                  {e.by ? <span className="text-ink-3">, by {e.by}</span> : null}
                </span>
                <span className="text-ink-3">{formatDateTime(e.at, "Africa/Accra")}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function describeEvent(action: string, m: Record<string, unknown>): string {
  const name = typeof m.module === "string" && isModuleId(m.module) ? MODULES[m.module].name : "A module";
  const school = typeof m.school === "string" ? m.school : "a school";
  switch (action) {
    case "modules.granted":
      return `${name} added for ${school}`;
    case "modules.ended":
      return `${name} ended for ${school}`;
    case "modules.end_scheduled":
      return `${name} given an end date for ${school}`;
    case "modules.release_access_granted":
      return `Release access to ${name} for ${school}`;
    case "modules.release_access_ended":
      return `Release access to ${name} ended for ${school}`;
    case "modules.read_only_days_set":
      return `Read-only window set to ${String(m.days)} days`;
    case "catalog.price_set":
      return `Price set for ${typeof m.module === "string" ? name : "a plan"}`;
    case "catalog.price_archived":
      return `Price removed for ${typeof m.module === "string" ? name : "a plan"}`;
    default:
      return action;
  }
}
