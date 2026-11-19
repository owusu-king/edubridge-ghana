import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check, Minus } from "lucide-react";
import { InvoiceState, SubscriptionBadge, UsageTable } from "@/components/billing/billing-views";
import { DescriptionList, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { getPlanOptions } from "@/server/billing/plans";
import { ActionButton } from "@/components/ui/action-forms";
import { Badge } from "@/components/ui/badge";
import { getDeliveryReport, SMS_KIND_LABELS } from "@/server/messages/delivery";
import { db } from "@/server/db/client";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { percentLabel } from "@/lib/pricing";
import { quoteForSchool } from "@/server/billing/auto-invoices";
import { NextInvoice } from "@/components/billing/next-invoice";
import { moneyFormatter } from "@/lib/money";
import { BILLING_PERIOD_LABELS, FEATURE_LABELS, PLAN_REQUEST_STATUS_LABELS } from "@/lib/plan";
import { ENTITLEMENT_SOURCE_LABELS, MODULES, PLAN_CHOICES, type ModuleState } from "@/lib/modules";
import type { PlanRequestRow } from "@/server/billing/plans";
import { schoolPath } from "@/lib/routes";
import {
  payInvoiceAction,
  requestModuleAction,
  requestPlanChangeAction,
  withdrawPlanRequestAction,
} from "./actions";
import { canPayOnline, invoicePaymentsFromEnv } from "@/server/billing/online-payments";
import { ModuleRequestDialog, PlanRequestForm } from "./plan-request";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Plan" };

const of = (used: number, max: number | null, unit: string) =>
  max === null
    ? `${used.toLocaleString("en-GH")} ${unit} (no limit)`
    : `${used.toLocaleString("en-GH")} of ${max.toLocaleString("en-GH")} ${unit}`;

export default async function PlanPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  if (!allowed(ctx, "plan.view")) notFound();
  const [{ plan, usage, invoices }, delivery, options, quote] = await Promise.all([
    getSchoolBilling(db(), ctx),
    getDeliveryReport(db(), ctx),
    getPlanOptions(db(), ctx),
    quoteForSchool(db(), {
      tenantId: ctx.tenant.id,
      userId: ctx.userId,
      supportGrantId: ctx.support?.grantId,
    }),
  ]);
  const today = todayIn(ctx.tenant.timezone);
  const slug = ctx.tenant.slug;
  const payOnline = canPayOnline(ctx, invoicePaymentsFromEnv());
  const limit = (n: number | null, unit: string) =>
    n === null ? `no ${unit} limit` : `up to ${n.toLocaleString("en-GH")} ${unit}`;
  // Modules the school has, had or can ask for; modules not released to it are not shown.
  const available = new Map(options.available.map((a) => [a.id, a]));
  const shown = PLAN_CHOICES.filter(
    (id) => ctx.modules[id]?.state !== "off" || available.has(id) || MODULES[id].stage === "general",
  );
  const whatsapp = ctx.features.includes("whatsapp");

  return (
    <div className="space-y-12">
      <Section
        title={`${plan.planName} plan`}
        description="Your plan is set by EduBridge. The Proprietor can ask for a change below."
      >
        <DescriptionList
          items={[
            {
              term: "Subscription",
              detail: (
                <SubscriptionBadge
                  status={plan.status}
                  trialEndsOn={plan.trialEndsOn}
                  paidUntil={plan.paidUntil}
                />
              ),
            },
            {
              term: "Price",
              detail: plan.pricePesewas ? (
                `${showMoney(plan.pricePesewas)} ${BILLING_PERIOD_LABELS[plan.billingPeriod].toLowerCase()} (agreed)`
              ) : plan.priceBands ? (
                <span>
                  Per term, by the number of active students counted each term:{" "}
                  {plan.priceBands
                    .map(
                      (b, i) =>
                        `${showMoney(b.termlyMinor)} ${i === 0 ? `up to ${b.upTo}` : `${plan.priceBands![i - 1]!.upTo + 1} to ${b.upTo.toLocaleString("en-GH")}`}`,
                    )
                    .join(", ")}
                  . You pay {BILLING_PERIOD_LABELS[plan.billingPeriod].toLowerCase()}.
                </span>
              ) : (
                <span className="text-ink-3">Not set</span>
              ),
            },
            ...(plan.discountBp && (plan.discountUntil === null || plan.discountUntil >= today)
              ? [
                  {
                    term: "Discount",
                    detail: `${plan.discountLabel ?? "Discount"}: ${percentLabel(plan.discountBp)} off${
                      plan.discountUntil ? ` until ${formatCalendarDate(plan.discountUntil)}` : ""
                    }`,
                  },
                ]
              : []),
            {
              term: "Active students",
              detail: (
                <span className="tabular">{of(plan.activeStudents, plan.maxStudents, "students")}</span>
              ),
            },
            {
              term: "Active campuses",
              detail: (
                <span className="tabular">{of(plan.activeCampuses, plan.maxCampuses, "campuses")}</span>
              ),
            },
            {
              term: "SMS",
              detail:
                plan.maxSmsPerMonth !== null ? (
                  `Included in your plan: up to ${plan.maxSmsPerMonth.toLocaleString("en-GH")} a month. Ask EduBridge if you need more in a month.`
                ) : plan.smsPricePesewas !== null ? (
                  `${showMoney(plan.smsPricePesewas)} per message`
                ) : (
                  <span className="text-ink-3">Not set</span>
                ),
            },
            ...(whatsapp
              ? [
                  {
                    term: "WhatsApp price",
                    detail:
                      plan.whatsappPricePesewas !== null ? (
                        `${showMoney(plan.whatsappPricePesewas)} per message`
                      ) : (
                        <span className="text-ink-3">Not set</span>
                      ),
                  },
                ]
              : []),
            {
              term: "SMS this month",
              detail: (
                <span className="tabular">
                  {of(
                    plan.smsThisMonth,
                    plan.maxSmsPerMonth === null ? null : plan.maxSmsPerMonth + plan.smsTopUpThisMonth,
                    "SMS",
                  )}
                  {plan.smsTopUpThisMonth > 0 &&
                    ` (${plan.smsTopUpThisMonth.toLocaleString("en-GH")} added this month)`}
                </span>
              ),
            },
          ]}
        />
      </Section>

      {quote.status !== "none" || quote.period ? (
        <Section
          title="Next invoice"
          description="Worked out the way EduBridge will issue it. Ask EduBridge if anything looks wrong."
        >
          <NextInvoice quote={quote} audience="school" />
        </Section>
      ) : null}

      <Section
        title="Modules"
        description="What your school can use now. School administration, students, classes, fees, payments, receipts, announcements, timetable and insights are in every plan."
      >
        <ul className="divide-y divide-line border-y border-line">
          {shown.map((id) => {
            const state = ctx.modules[id];
            const active = state?.state === "active";
            const readOnly = state?.state === "read_only";
            const grant = options.grants.find((g) => g.module === id && !g.endedAt);
            const offer = available.get(id);
            const price =
              offer?.prices.find((p) => p.billingPeriod === plan.billingPeriod) ?? offer?.prices[0];
            const priceNote = price
              ? `${showMoney(price.pricePesewas)} ${BILLING_PERIOD_LABELS[price.billingPeriod].toLowerCase()}${price.unit === "per_student" ? " per active student" : ""}`
              : null;
            return (
              <li key={id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${active ? "bg-positive-soft text-positive" : "bg-subtle text-ink-3"}`}
                  >
                    {active ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-base text-ink">{MODULES[id].name}</p>
                    <p className="text-sm text-ink-3">{MODULES[id].description}</p>
                    <p className="mt-1 text-sm text-ink-2">{moduleStatus(state)}</p>
                  </div>
                </div>
                {options.canRequest && !options.pending && (
                  <div className="shrink-0">
                    {!active && !readOnly && offer && !state?.missing.length && (
                      <ModuleRequestDialog
                        action={requestModuleAction.bind(null, slug, "add_module", id)}
                        kind="add_module"
                        moduleName={MODULES[id].name}
                        priceNote={priceNote}
                      />
                    )}
                    {active && state?.source !== "plan" && grant && grant.endsOn === null && (
                      <ModuleRequestDialog
                        action={requestModuleAction.bind(null, slug, "cancel_module", id)}
                        kind="cancel_module"
                        moduleName={MODULES[id].name}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Change your plan"
        description="EduBridge confirms each change and its price with you before it applies."
      >
        {options.pending ? (
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <p className="text-base font-medium text-ink">
                {describeRequest(options.pending)}{" "}
                <Badge tone="accent">{PLAN_REQUEST_STATUS_LABELS.pending}</Badge>
              </p>
              {options.pending.message && <p className="text-sm text-ink-2">“{options.pending.message}”</p>}
              <p className="text-sm text-ink-3">
                Asked by {options.pending.requestedBy} on{" "}
                {formatDateTime(options.pending.createdAt, ctx.tenant.timezone)}
              </p>
            </div>
            {options.canRequest && (
              <ActionButton
                action={withdrawPlanRequestAction.bind(null, slug, options.pending.id)}
                label="Withdraw"
                ariaLabel="Withdraw the plan change request"
              />
            )}
          </div>
        ) : options.canRequest ? (
          <PlanRequestForm
            action={requestPlanChangeAction.bind(null, slug)}
            plans={options.plans.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              current: p.current,
              summary: [
                p.features.map((f) => FEATURE_LABELS[f].name).join(", ") || "Core records only",
                `${p.maxCampuses} ${p.maxCampuses === 1 ? "campus" : "campuses"}`,
                limit(p.maxStudents, "students"),
                limit(p.maxSmsPerMonth, "SMS a month"),
              ].join(" · "),
            }))}
          />
        ) : (
          <p className="text-base text-ink-3">The Proprietor can ask EduBridge for a change.</p>
        )}
        {options.history.length > 0 && (
          <ul aria-label="Earlier requests" className="divide-y divide-line border-y border-line">
            {options.history.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <span className="text-ink">{describeRequest(r)}</span>{" "}
                <span className="text-ink-3">
                  · {PLAN_REQUEST_STATUS_LABELS[r.status]}
                  {r.decidedAt ? ` on ${formatCalendarDate(r.decidedAt.toISOString().slice(0, 10))}` : ""}
                  {r.decisionNote ? `: ${r.decisionNote}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="SMS sent"
        description="Every SMS your school is charged for, by month, counted in SMS segments."
      >
        <UsageTable usage={usage} />
      </Section>

      <Section
        title="Delivery"
        description={`The last ${delivery.days} days. Sent means the SMS provider accepted the message; messages are retried for about 15 minutes before they count as not delivered, and those are never charged.`}
      >
        {delivery.rows.length === 0 ? (
          <p className="text-base text-ink-3">No SMS in the last {delivery.days} days.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">SMS delivery, last {delivery.days} days</caption>
              <THead>
                <tr>
                  <TH>Kind</TH>
                  <TH numeric>Sent</TH>
                  <TH numeric>Waiting</TH>
                  <TH numeric>Not delivered</TH>
                  <TH numeric className="hidden sm:table-cell">
                    SMS charged
                  </TH>
                  {whatsapp && (
                    <TH numeric className="hidden md:table-cell">
                      By WhatsApp (delivered)
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {delivery.rows.map((r) => (
                  <TR key={r.kind}>
                    <TD>{SMS_KIND_LABELS[r.kind]}</TD>
                    <TD numeric>{r.sent}</TD>
                    <TD numeric>{r.waiting}</TD>
                    <TD numeric className={r.failed ? "text-critical" : undefined}>
                      {r.failed}
                    </TD>
                    <TD numeric className="hidden sm:table-cell">
                      {r.segments}
                    </TD>
                    {whatsapp && (
                      <TD numeric className="hidden md:table-cell">
                        {r.whatsapp} ({r.delivered})
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
        {delivery.failures.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">Messages not delivered</caption>
              <THead>
                <tr>
                  <TH>Not delivered</TH>
                  <TH>To</TH>
                  <TH className="hidden sm:table-cell">Reason</TH>
                </tr>
              </THead>
              <TBody>
                {delivery.failures.map((f, i) => (
                  <TR key={i}>
                    <TD>
                      {SMS_KIND_LABELS[f.kind]}
                      <span className="block text-sm text-ink-3">
                        {formatDateTime(f.queuedAt, ctx.tenant.timezone)}
                      </span>
                    </TD>
                    <TD className="tabular-nums">
                      {f.recipient}
                      {f.student && <span className="block text-sm text-ink-3">{f.student}</span>}
                    </TD>
                    <TD className="hidden text-sm text-ink-2 sm:table-cell">{f.reason ?? "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section title="Invoices from EduBridge">
        {invoices.length === 0 ? (
          <p className="text-base text-ink-3">No invoices yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Invoices from EduBridge</caption>
              <THead>
                <tr>
                  <TH>Invoice</TH>
                  <TH className="hidden sm:table-cell">Period</TH>
                  <TH className="hidden md:table-cell">Due</TH>
                  <TH className="text-right">Amount</TH>
                  <TH>Status</TH>
                  <TH className="sr-only">Pay or download</TH>
                </tr>
              </THead>
              <TBody>
                {invoices.map((invoice) => (
                  <TR key={invoice.id}>
                    <TD>
                      <span className="font-mono text-sm text-ink">{invoice.invoiceNumber}</span>
                      <span className="block text-sm text-ink-3">
                        Issued {formatCalendarDate(invoice.issuedOn)}
                      </span>
                    </TD>
                    <TD className="hidden sm:table-cell">
                      {formatCalendarDate(invoice.periodStartsOn)} –{" "}
                      {formatCalendarDate(invoice.periodEndsOn)}
                    </TD>
                    <TD className="hidden md:table-cell">{formatCalendarDate(invoice.dueOn)}</TD>
                    <TD className="text-right tabular-nums">{showMoney(invoice.totalPesewas)}</TD>
                    <TD>
                      <InvoiceState invoice={invoice} />
                    </TD>
                    <TD className="text-right">
                      {payOnline && (invoice.state === "open" || invoice.state === "overdue") && (
                        <span className="mr-3 inline-flex">
                          <ActionButton
                            action={payInvoiceAction.bind(null, slug, invoice.id)}
                            label="Pay online"
                            variant="primary"
                            ariaLabel={`Pay ${invoice.invoiceNumber} online`}
                          />
                        </span>
                      )}
                      <a
                        href={`${schoolPath(slug, "settings/plan/invoices")}/${invoice.id}`}
                        className="text-sm font-medium text-accent hover:underline"
                        aria-label={`Download ${invoice.invoiceNumber} as PDF`}
                      >
                        PDF
                      </a>
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

function describeRequest(r: PlanRequestRow): string {
  if (r.kind === "add_module" && r.module) return `Add ${MODULES[r.module].name}`;
  if (r.kind === "cancel_module" && r.module) return `Cancel ${MODULES[r.module].name}`;
  return r.presetName ? `Move to ${r.presetName}` : "A change to your plan";
}

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Why the school has a module (or not), in words (ENT-05). */
function moduleStatus(state: ModuleState | undefined): string {
  if (!state || state.state === "off") {
    if (state?.missing.length)
      return `Needs ${state.missing.map((m) => MODULES[m].name).join(" and ")} first.`;
    return "Not included.";
  }
  if (state.state === "read_only")
    return `Read-only since ${formatCalendarDate(nextDay(state.endsOn ?? ""))}: your records can be viewed and exported, but not changed. Add it again to carry on.`;
  if (state.source === "plan" || state.source === "core") return "In your plan.";
  const how = state.source ? ENTITLEMENT_SOURCE_LABELS[state.source] : "Included";
  return state.endsOn ? `${how}, until ${formatCalendarDate(state.endsOn)}.` : `${how}.`;
}
