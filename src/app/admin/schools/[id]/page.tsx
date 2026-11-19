import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { getSchool } from "@/server/platform/service";
import { getSupportStatusForPlatform } from "@/server/support/access";
import { getSchoolAiLimits } from "@/server/ai/admin";
import { readAiConfig } from "@/server/ai/config";
import { SchoolAiLimitsForm } from "../../integrations/integration-forms";
import { requirePlatformAdmin } from "@/web/auth";
import { InvoiceState, SubscriptionBadge, UsageTable } from "@/components/billing/billing-views";
import { getPlatformSettings } from "@/server/billing/settings";
import { getSchoolBillingForPlatform, smsCharge } from "@/server/billing/subscriptions";
import { listPresets } from "@/server/billing/plans";
import { quoteForSchool } from "@/server/billing/auto-invoices";
import { NextInvoice } from "@/components/billing/next-invoice";
import { ActionButton } from "@/components/ui/action-forms";
import { addDays } from "@/lib/attendance";
import { countryName, formatCalendarDate, formatDate, formatDateTime, todayIn } from "@/lib/format";
import { formatMoney, minorToInput } from "@/lib/money";
import { monthLabel } from "@/lib/plan";
import {
  addSmsTopUpAction,
  applyPresetAction,
  issueAutomaticInvoiceNowAction,
  issueInvoiceAction,
  markInvoicePaidAction,
  reissueInvitationAction,
  setSchoolStatusAction,
  updateEntitlementsAction,
  updateSubscriptionAction,
  voidInvoiceAction,
  setSchoolAiLimitsAction,
} from "../../actions";
import {
  ApplyPresetForm,
  EntitlementsForm,
  InvoiceActions,
  IssueInvoiceDialog,
  SmsTopUpDialog,
  SubscriptionForm,
  type InvoiceSuggestion,
} from "./billing-controls";
import { ReissueInvitationForm, StatusControl } from "./school-controls";
import { providerChoicesForAdmin } from "@/server/mobile-money/config";
import { getSchoolModulesAdmin, type SchoolModulesAdmin } from "@/server/entitlements/admin";
import {
  ENTITLEMENT_SOURCE_LABELS,
  MODULE_STAGE_LABELS,
  MODULES,
  PLAN_CHOICES,
  addOnInvoiceLines,
} from "@/lib/modules";
import type { BillingPeriod } from "@/lib/plan";
import {
  endModuleAction,
  grantModuleAction,
  scheduleModuleEndAction,
  setReleaseAccessAction,
} from "../../module-actions";
import {
  EndModuleDialog,
  GrantModuleDialog,
  ReleaseAccessButton,
  ScheduleEndDialog,
} from "./module-controls";

export const metadata: Metadata = { title: "School" };

const INVITE_TONE = {
  pending: "accent",
  accepted: "positive",
  revoked: "neutral",
  expired: "neutral",
} as const;

export default async function SchoolAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePlatformAdmin();
  const [school, billing, platform, presets] = await Promise.all([
    getSchool(db(), user.id, id),
    getSchoolBillingForPlatform(db(), user.id, id),
    getPlatformSettings(db(), user.id),
    listPresets(db(), user.id),
  ]);
  if (!school || !billing) notFound();
  const [modules, quote] = await Promise.all([
    getSchoolModulesAdmin(db(), user.id, school.id),
    quoteForSchool(db(), { tenantId: school.id, userId: user.id }),
  ]);
  const support = await getSupportStatusForPlatform(db(), user.id, school.id);
  const [aiLimits, aiConfig] = await Promise.all([
    getSchoolAiLimits(db(), user.id, school.id),
    readAiConfig(db()),
  ]);
  const tz = school.timezone;
  const today = todayIn(tz);
  const { plan } = billing;
  const lastMonth = billing.usage[1];
  const monthEnd = addDays(`${today.slice(0, 7)}-01`, 40).slice(0, 7);
  const suggestion: InvoiceSuggestion = {
    periodStartsOn: `${today.slice(0, 7)}-01`,
    periodEndsOn: addDays(`${monthEnd}-01`, -1),
    dueOn: addDays(today, 14),
    lines: [
      ...(plan.pricePesewas
        ? [
            {
              description: `${plan.planName} plan`,
              quantity: "1",
              unitPrice: minorToInput(plan.pricePesewas, school.currencyCode),
            },
          ]
        : []),
      // SUB-09: priced add-ons the school has today.
      ...addOnInvoiceLines(modules.grants, today, plan.activeStudents).map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        unitPrice: minorToInput(l.unitPesewas, school.currencyCode),
      })),
      // SMS are charged per message only on plans without an included monthly allowance.
      ...(lastMonth && lastMonth.billable > 0 && plan.maxSmsPerMonth === null
        ? [
            Number.isInteger(lastMonth.billable)
              ? {
                  description: `SMS, ${monthLabel(lastMonth.month)}`,
                  quantity: String(lastMonth.billable),
                  unitPrice: minorToInput(plan.smsPricePesewas, school.currencyCode),
                }
              : {
                  // Shares of shared sign-in codes make the count fractional: one line for the month's charge.
                  description: `SMS, ${monthLabel(lastMonth.month)} (${lastMonth.billable} SMS incl. shared codes)`,
                  quantity: "1",
                  unitPrice: minorToInput(
                    smsCharge(plan.smsPricePesewas, lastMonth.billable),
                    school.currencyCode,
                  ),
                },
          ]
        : []),
      ...(lastMonth && lastMonth.whatsapp > 0
        ? [
            {
              description: `WhatsApp messages, ${monthLabel(lastMonth.month)}`,
              quantity: String(lastMonth.whatsapp),
              unitPrice: minorToInput(plan.whatsappPricePesewas, school.currencyCode),
            },
          ]
        : []),
    ],
  };
  const lastOwnerInvite = school.invitations.find((i) => i.roles.includes("owner"));

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Schools"
        title={school.name}
        description={
          <span className="inline-flex items-center gap-3">
            <span className="font-mono text-sm">/s/{school.slug}</span>
            {school.status === "active" ? (
              <StatusText tone="positive">Active</StatusText>
            ) : (
              <StatusText tone="caution">Suspended</StatusText>
            )}
            {school.isDemo && <Badge tone="caution">Demo, made-up data</Badge>}
          </span>
        }
        actions={
          <Link href={"/admin" as Route} className="text-sm font-medium text-accent hover:underline">
            All schools
          </Link>
        }
      />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-10">
          <Section
            title="Plan"
            description={`${school.activeCampuses} active ${school.activeCampuses === 1 ? "campus" : "campuses"} in use.`}
          >
            {presets.some((p) => !p.archived) && (
              <ApplyPresetForm
                action={applyPresetAction.bind(null, school.id)}
                presets={presets.filter((p) => !p.archived)}
                current={plan.presetId}
              />
            )}
            <EntitlementsForm
              action={updateEntitlementsAction.bind(null, school.id)}
              defaults={{
                planName: plan.planName,
                maxCampuses: plan.maxCampuses,
                maxStudents: plan.maxStudents,
                maxSmsPerMonth: plan.maxSmsPerMonth,
                features: plan.features,
              }}
            />
          </Section>

          <SchoolModulesSection
            schoolId={school.id}
            currency={school.currencyCode}
            billingPeriod={plan.billingPeriod}
            modules={modules}
            timeZone={tz}
          />

          <Section
            title="Subscription"
            description={`${plan.activeStudents} active students. ${
              plan.pricePesewas !== null
                ? "Agreed price per period."
                : plan.priceBands
                  ? "Priced by the plan for the school's size, counted each term."
                  : "No price yet: set the plan from one of EduBridge's plans, or an agreed price."
            }`}
            aside={
              <SubscriptionBadge
                status={plan.status}
                trialEndsOn={plan.trialEndsOn}
                paidUntil={plan.paidUntil}
              />
            }
          >
            <SubscriptionForm
              currency={school.currencyCode}
              action={updateSubscriptionAction.bind(null, school.id)}
              defaults={{
                status: plan.status,
                billingPeriod: plan.billingPeriod,
                trialEndsOn: plan.trialEndsOn,
                paidUntil: plan.paidUntil,
                price: minorToInput(plan.pricePesewas, school.currencyCode),
                smsPrice: minorToInput(plan.ownSmsPricePesewas, school.currencyCode),
                platformSmsPrice: minorToInput(platform.smsPricePesewas, school.currencyCode),
                settlementAccount: plan.settlementAccount ?? "",
                mobileMoneyProvider: plan.mobileMoneyProvider ?? "",
                notes: plan.notes,
                discountPercent: plan.discountBp === null ? "" : String(plan.discountBp / 100),
                discountLabel: plan.discountLabel ?? "",
                discountUntil: plan.discountUntil ?? "",
              }}
              providerOptions={providerChoicesForAdmin(plan.mobileMoneyProvider)}
            />
          </Section>

          <Section
            title="Next invoice"
            description="Worked out as it will be issued automatically. Issue it now to send it before the census day, or while automatic invoices are off."
            aside={
              (quote.status === "ready" || quote.status === "waiting") && (
                <ActionButton
                  action={issueAutomaticInvoiceNowAction.bind(null, school.id)}
                  label="Issue it now"
                />
              )
            }
          >
            <NextInvoice quote={quote} audience="staff" />
          </Section>

          <Section
            title="SMS charged to the school"
            description={`The last six months, in the school's time zone.${
              plan.maxSmsPerMonth !== null
                ? ` This month: ${plan.smsThisMonth} of ${plan.maxSmsPerMonth + plan.smsTopUpThisMonth} sent${plan.smsTopUpThisMonth ? ` (${plan.smsTopUpThisMonth} added)` : ""}.`
                : ""
            }`}
            aside={
              <SmsTopUpDialog
                action={addSmsTopUpAction.bind(null, school.id)}
                currency={school.currencyCode}
              />
            }
          >
            <UsageTable usage={billing.usage} />
          </Section>

          <Section
            title="AI allowance"
            description="The school's own AI limits, for example to match the plan it pays for. Empty fields keep the platform default (Integrations, AI limits)."
          >
            <SchoolAiLimitsForm
              action={setSchoolAiLimitsAction.bind(null, school.id)}
              values={aiLimits}
              defaults={{
                monthlyTokens: aiConfig.limits.schoolMonthlyTokens,
                userPerHour: aiConfig.limits.userPerHour,
                userDailyTokens: aiConfig.limits.userDailyTokens,
              }}
            />
          </Section>

          <Section
            title="Invoices"
            description="EduBridge's invoices to this school. The school sees them under Settings, Plan."
            aside={
              <IssueInvoiceDialog
                currency={school.currencyCode}
                action={issueInvoiceAction.bind(null, school.id)}
                suggestion={suggestion}
              />
            }
          >
            {billing.invoices.length === 0 ? (
              <p className="text-base text-ink-3">No invoices yet.</p>
            ) : (
              <TableFrame>
                <Table>
                  <caption className="sr-only">Invoices to {school.name}</caption>
                  <THead>
                    <tr>
                      <TH>Invoice</TH>
                      <TH className="hidden md:table-cell">Period</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Status</TH>
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {billing.invoices.map((invoice) => (
                      <TR key={invoice.id}>
                        <TD>
                          <span className="font-mono text-sm text-ink">{invoice.invoiceNumber}</span>
                          <span className="block text-sm text-ink-3">
                            Due {formatCalendarDate(invoice.dueOn)}
                            {invoice.paymentReference ? ` · ${invoice.paymentReference}` : ""}
                            {invoice.voidReason ? ` · ${invoice.voidReason}` : ""}
                          </span>
                        </TD>
                        <TD className="hidden md:table-cell">
                          {formatCalendarDate(invoice.periodStartsOn)} –{" "}
                          {formatCalendarDate(invoice.periodEndsOn)}
                        </TD>
                        <TD className="text-right tabular-nums">
                          {formatMoney(invoice.totalPesewas, invoice.currencyCode)}
                        </TD>
                        <TD>
                          <InvoiceState invoice={invoice} />
                        </TD>
                        <TD>
                          <a
                            href={`/admin/schools/${school.id}/invoices/${invoice.id}`}
                            className="mr-3 text-sm font-medium text-accent hover:underline"
                            aria-label={`Download ${invoice.invoiceNumber} as PDF`}
                          >
                            PDF
                          </a>
                          {(invoice.state === "open" || invoice.state === "overdue") && (
                            <InvoiceActions
                              invoiceNumber={invoice.invoiceNumber}
                              today={today}
                              markPaid={markInvoicePaidAction.bind(null, school.id, invoice.id)}
                              markVoid={voidInvoiceAction.bind(null, school.id, invoice.id)}
                            />
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Section>

          <Section
            title="Proprietor access"
            description="Creating a new link revokes any pending link for that email."
          >
            <ReissueInvitationForm
              action={reissueInvitationAction.bind(null, school.id)}
              defaultEmail={lastOwnerInvite?.email ?? ""}
            />
          </Section>

          <Section title="Invitations" description="The 20 most recent.">
            {school.invitations.length === 0 ? (
              <p className="text-base text-ink-3">No invitations yet.</p>
            ) : (
              <TableFrame>
                <Table>
                  <THead>
                    <tr>
                      <TH>Email</TH>
                      <TH className="hidden sm:table-cell">Role</TH>
                      <TH>State</TH>
                      <TH className="hidden md:table-cell" numeric>
                        Issued
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {school.invitations.map((invite) => (
                      <TR key={invite.id}>
                        <TD className="text-ink">{invite.email}</TD>
                        <TD className="hidden capitalize sm:table-cell">{invite.roles.join(", ")}</TD>
                        <TD>
                          <Badge tone={INVITE_TONE[invite.state]}>
                            {invite.state[0]!.toUpperCase() + invite.state.slice(1)}
                          </Badge>
                        </TD>
                        <TD className="hidden md:table-cell" numeric>
                          {formatDate(invite.createdAt, tz)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Section>
        </div>

        <div className="space-y-10">
          <Section title="Details">
            <DescriptionList
              stacked
              items={[
                { term: "Country", detail: countryName(school.countryCode) },
                { term: "Currency", detail: school.currencyCode },
                { term: "Time zone", detail: tz.replace("_", " ") },
                { term: "Created", detail: formatDate(school.createdAt, tz) },
              ]}
            />
          </Section>
          <Section
            title="Support access"
            description="Only while the Proprietor allows it, for the time they chose. Everything you open and change is shown to them."
          >
            {support && school.status === "active" ? (
              <div className="space-y-3">
                <StatusText tone="caution">Allowed until {formatDateTime(support.expiresAt, tz)}</StatusText>
                <p className="text-sm text-ink-3">
                  By {support.grantedBy}
                  {support.note ? `: “${support.note}”` : "."}
                </p>
                <Link
                  href={`/s/${school.slug}` as Route}
                  className="inline-flex h-10 items-center rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-subtle"
                >
                  Open the school as support
                </Link>
              </div>
            ) : (
              <p className="text-sm text-ink-2">
                Not allowed. The Proprietor can allow it under Settings, Support access.
              </p>
            )}
          </Section>
          <Section title="Access">
            <StatusControl
              action={setSchoolStatusAction.bind(
                null,
                school.id,
                school.status === "active" ? "suspended" : "active",
              )}
              status={school.status}
              schoolName={school.name}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

const STATE_TEXT = { active: "Active", read_only: "Read-only", off: "Off" } as const;
const STATE_TONE = { active: "positive", read_only: "caution", off: "neutral" } as const;
const RELEASABLE = new Set(["internal_testing", "ready", "pilot"]);

/**
 * What the school can use (ENT-01), why, and until when; modules beyond the plan (SUB-06) and release access for
 * modules not yet generally released (REL-02). Every change here is in the school's audit log.
 */
function SchoolModulesSection({
  schoolId,
  currency,
  billingPeriod,
  modules,
  timeZone,
}: {
  schoolId: string;
  currency: string;
  billingPeriod: BillingPeriod;
  modules: SchoolModulesAdmin;
  timeZone: string;
}) {
  const inPlan = modules.planModules ?? [...PLAN_CHOICES];
  const open = modules.grants.filter((g) => !g.endedAt && (g.endsOn === null || g.endsOn >= modules.today));
  const past = modules.grants.filter((g) => !open.includes(g));
  return (
    <Section
      title="Modules"
      description="What the school can use today, from its plan, add-ons, trials and promotions, release and dependencies. Ending a module never deletes the school's records."
      aside={
        <GrantModuleDialog
          action={grantModuleAction.bind(null, schoolId)}
          currency={currency}
          today={modules.today}
          billingPeriod={billingPeriod}
          exclude={inPlan}
        />
      }
    >
      <TableFrame>
        <Table>
          <caption className="sr-only">Modules for this school</caption>
          <THead>
            <tr>
              <TH>Module</TH>
              <TH>Now</TH>
              <TH>From</TH>
              <TH>Release</TH>
            </tr>
          </THead>
          <TBody>
            {PLAN_CHOICES.map((id) => {
              const state = modules.states[id];
              const def = MODULES[id];
              const hasAccess = modules.releaseAccess.includes(id);
              return (
                <TR key={id}>
                  <TD>
                    {def.name}
                    {state?.missing.length ? (
                      <span className="block text-sm text-ink-3">
                        Needs {state.missing.map((m) => MODULES[m].name).join(", ")}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    <StatusText tone={STATE_TONE[state?.state ?? "off"]}>
                      {STATE_TEXT[state?.state ?? "off"]}
                    </StatusText>
                    {state?.unreleased && <span className="block text-sm text-ink-3">Not released yet</span>}
                  </TD>
                  <TD>
                    {state?.source ? ENTITLEMENT_SOURCE_LABELS[state.source] : "Not included"}
                    {state?.endsOn && (
                      <span className="block text-sm text-ink-3">
                        {state.state === "read_only" ? "Ended " : "Until "}
                        {formatCalendarDate(state.endsOn)}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <span className="block text-sm text-ink-2">{MODULE_STAGE_LABELS[def.stage]}</span>
                    {RELEASABLE.has(def.stage) && (
                      <ReleaseAccessButton
                        action={setReleaseAccessAction.bind(null, schoolId, id, !hasAccess)}
                        on={!hasAccess}
                        moduleName={def.name}
                      />
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </TableFrame>

      {open.length > 0 && (
        <div className="mt-6 space-y-3">
          <h3 className="text-base font-medium text-ink">Beyond the plan</h3>
          <TableFrame>
            <Table>
              <caption className="sr-only">Add-ons, trials and promotions</caption>
              <THead>
                <tr>
                  <TH>Module</TH>
                  <TH>Dates</TH>
                  <TH>Price</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {open.map((g) => (
                  <TR key={g.id}>
                    <TD>
                      {MODULES[g.module].name}
                      <span className="block text-sm text-ink-3">
                        {ENTITLEMENT_SOURCE_LABELS[g.source]}, added by {g.grantedBy}
                        {g.note ? `: ${g.note}` : ""}
                      </span>
                    </TD>
                    <TD>
                      {formatCalendarDate(g.startsOn)} to{" "}
                      {g.endsOn ? formatCalendarDate(g.endsOn) : "no end date"}
                    </TD>
                    <TD>
                      {g.pricePesewas === null
                        ? "No charge"
                        : `${formatMoney(g.pricePesewas, g.currencyCode ?? currency)}${g.priceUnit === "per_student" ? " per student" : ""}`}
                    </TD>
                    <TD className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        {g.endsOn === null && (
                          <ScheduleEndDialog
                            action={scheduleModuleEndAction.bind(null, schoolId, g.id)}
                            moduleName={MODULES[g.module].name}
                            today={modules.today}
                          />
                        )}
                        <EndModuleDialog
                          action={endModuleAction.bind(null, schoolId, g.id)}
                          moduleName={MODULES[g.module].name}
                        />
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </div>
      )}

      {past.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-medium text-accent">
            Earlier add-ons, trials and promotions ({past.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-ink-2">
            {past.map((g) => (
              <li key={g.id}>
                {MODULES[g.module].name}, {ENTITLEMENT_SOURCE_LABELS[g.source].toLowerCase()}:{" "}
                {formatCalendarDate(g.startsOn)} to{" "}
                {g.endedAt
                  ? `${formatDateTime(g.endedAt, timeZone)}, ended early (${g.endReason})`
                  : g.endsOn
                    ? formatCalendarDate(g.endsOn)
                    : "no end date"}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}
