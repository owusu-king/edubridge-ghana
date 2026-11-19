import type { Metadata, Route } from "next";
import Link from "next/link";
import { Layers } from "lucide-react";
import { ActionButton } from "@/components/ui/action-forms";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listPendingPlanRequests, listPresets } from "@/server/billing/plans";
import { db } from "@/server/db/client";
import { SUPPORTED_CURRENCIES } from "@/server/platform/service";
import { formatDate } from "@/lib/format";
import { formatMoney, minorToInput } from "@/lib/money";
import { BILLING_PERIOD_LABELS, FEATURE_LABELS } from "@/lib/plan";
import { MODULES } from "@/lib/modules";
import { SUGGESTED_PLANS } from "@/lib/pricing";
import { requirePlatformAdmin } from "@/web/auth";
import {
  addSuggestedPlansAction,
  archivePresetAction,
  createPresetAction,
  decidePlanRequestAction,
  updatePresetAction,
} from "../actions";
import { ArchiveButton, DecideDialogs, EditPresetDialog, NewPresetDialog } from "./plan-controls";

export const metadata: Metadata = { title: "Plans" };

const limit = (n: number | null, unit: string) =>
  n === null ? `no ${unit} limit` : `${n.toLocaleString("en-GH")} ${unit}`;

/** EduBridge's plans (SUB-01) and schools' requests to change plan (SUB-02). */
export default async function PlansPage() {
  const user = await requirePlatformAdmin();
  const [presets, pending] = await Promise.all([
    listPresets(db(), user.id),
    listPendingPlanRequests(db(), user.id),
  ]);
  const newDialog = <NewPresetDialog action={createPresetAction} currencies={SUPPORTED_CURRENCIES} />;
  const missingSuggested = !SUGGESTED_PLANS.every((s) =>
    presets.some((p) => p.name.toLowerCase() === s.name.toLowerCase()),
  );
  const suggestButton = missingSuggested && (
    <ActionButton action={addSuggestedPlansAction} label="Add the suggested plans" />
  );

  return (
    <div className="space-y-10">
      <PageHeader
        title="Plans"
        description="The plans EduBridge offers. A school's plan is a copy of one: changing a plan here does not change schools already on it."
        actions={
          (presets.length > 0 || suggestButton) && (
            <>
              {suggestButton}
              {presets.length > 0 && newDialog}
            </>
          )
        }
      />

      <Section
        title="Requests from schools"
        description="Approving a request for a plan sets the school's plan from it at once, and the Proprietor is emailed."
      >
        {pending.length === 0 ? (
          <p className="text-base text-ink-3">No requests waiting.</p>
        ) : (
          <ul aria-label="Requests waiting" className="divide-y divide-line border-y border-line">
            {pending.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <Link
                    href={`/admin/schools/${r.tenantId}` as Route}
                    className="text-md font-semibold text-ink hover:underline"
                  >
                    {r.schoolName}
                  </Link>
                  <p className="text-base text-ink-2">
                    {[
                      r.kind === "add_module" && r.module
                        ? `Add ${MODULES[r.module].name}`
                        : r.kind === "cancel_module" && r.module
                          ? `Cancel ${MODULES[r.module].name}`
                          : r.presetName
                            ? `Move to ${r.presetName}`
                            : null,
                      r.message ? `“${r.message}”` : null,
                    ]
                      .filter(Boolean)
                      .join(": ")}
                  </p>
                  <p className="text-sm text-ink-3">
                    Now on {r.currentPlan} · asked by {r.requestedBy} on{" "}
                    {formatDate(r.createdAt, "Africa/Accra")}
                  </p>
                </div>
                <DecideDialogs
                  approve={decidePlanRequestAction.bind(null, r.id, true)}
                  decline={decidePlanRequestAction.bind(null, r.id, false)}
                  school={r.schoolName}
                  what={
                    r.kind === "add_module" && r.module
                      ? `${MODULES[r.module].name} will be added for the school from today, at the catalogue price for its billing period if one is set (otherwise no charge until you set one on the school's page). It needs: ${MODULES[r.module].requires.map((m) => MODULES[m].name).join(", ") || "nothing else"}.`
                      : r.kind === "cancel_module" && r.module
                        ? `${MODULES[r.module].name} will end at the end of the period the school has paid for (or today). The school's records are kept.`
                        : r.presetName
                          ? `The school's plan will be set from ${r.presetName}: its modules and limits, and its price if the school is billed in the same currency.`
                          : "This request names no plan: make the change on the school's page, then approve it here."
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Plans offered">
        {presets.length === 0 ? (
          <EmptyState
            icon={<Layers />}
            title="No plans yet"
            description="Add the plans you offer, or start from the suggested ones (Starter, Standard, Premium, priced per term by school size). New schools can start on one, and schools can ask to move to another."
            action={newDialog}
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Plans</caption>
              <THead>
                <tr>
                  <TH>Plan</TH>
                  <TH className="hidden md:table-cell">Limits</TH>
                  <TH className="hidden sm:table-cell">Price per term, by size</TH>
                  <TH numeric>Schools</TH>
                  <TH className="sr-only">Actions</TH>
                </tr>
              </THead>
              <TBody>
                {presets.map((p) => (
                  <TR key={p.id}>
                    <TD>
                      <span className="font-medium text-ink">{p.name}</span>{" "}
                      {p.archived && <Badge>Archived</Badge>}
                      <span className="block text-sm text-ink-3">
                        {p.features.map((f) => FEATURE_LABELS[f].name).join(", ") || "Core records only"}
                      </span>
                    </TD>
                    <TD className="hidden text-sm md:table-cell">
                      {[
                        limit(p.maxCampuses, p.maxCampuses === 1 ? "campus" : "campuses"),
                        limit(p.maxStudents, "students"),
                        limit(p.maxSmsPerMonth, "SMS a month"),
                      ].join(", ")}
                    </TD>
                    <TD className="hidden sm:table-cell">
                      {p.priceBands ? (
                        <ul className="space-y-0.5 text-sm" aria-label={`${p.name} prices per term`}>
                          {p.priceBands.map((b, i) => (
                            <li key={b.upTo}>
                              <span className="text-ink-3">
                                {i === 0
                                  ? `Up to ${b.upTo}`
                                  : `${(p.priceBands![i - 1]!.upTo + 1).toLocaleString("en-GH")} to ${b.upTo.toLocaleString("en-GH")}`}
                                :{" "}
                              </span>
                              <span className="tabular-nums">
                                {formatMoney(b.termlyMinor, p.currencyCode)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : p.pricePesewas === null ? (
                        "Agreed per school"
                      ) : (
                        `${formatMoney(p.pricePesewas, p.currencyCode)} ${BILLING_PERIOD_LABELS[p.billingPeriod].toLowerCase()}`
                      )}
                    </TD>
                    <TD numeric>{p.schools}</TD>
                    <TD className="text-right">
                      <div className="flex justify-end gap-2">
                        <EditPresetDialog
                          action={updatePresetAction.bind(null, p.id)}
                          currencies={SUPPORTED_CURRENCIES}
                          values={{
                            name: p.name,
                            description: p.description,
                            features: p.features,
                            maxCampuses: p.maxCampuses,
                            maxStudents: p.maxStudents,
                            maxSmsPerMonth: p.maxSmsPerMonth,
                            billingPeriod: p.billingPeriod,
                            currencyCode: p.currencyCode,
                            band0: minorToInput(p.priceBands?.[0]?.termlyMinor ?? null, p.currencyCode),
                            band1: minorToInput(p.priceBands?.[1]?.termlyMinor ?? null, p.currencyCode),
                            band2: minorToInput(p.priceBands?.[2]?.termlyMinor ?? null, p.currencyCode),
                            band3: minorToInput(p.priceBands?.[3]?.termlyMinor ?? null, p.currencyCode),
                          }}
                        />
                        <ArchiveButton
                          action={archivePresetAction.bind(null, p.id, !p.archived)}
                          archived={p.archived}
                          name={p.name}
                        />
                      </div>
                    </TD>
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
