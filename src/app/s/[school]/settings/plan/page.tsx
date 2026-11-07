import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check, Minus } from "lucide-react";
import { InvoiceState, SubscriptionBadge, UsageTable } from "@/components/billing/billing-views";
import { DescriptionList, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { BILLING_PERIOD_LABELS, FEATURE_LABELS, FEATURES } from "@/lib/plan";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Plan" };

const of = (used: number, max: number | null, unit: string) =>
  max === null
    ? `${used.toLocaleString("en-GH")} ${unit} (no limit)`
    : `${used.toLocaleString("en-GH")} of ${max.toLocaleString("en-GH")} ${unit}`;

export default async function PlanPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "plan.view")) notFound();
  const { plan, usage, invoices } = await getSchoolBilling(db(), ctx);

  return (
    <div className="space-y-12">
      <Section
        title={`${plan.planName} plan`}
        description="Your plan is set by EduBridge. Contact us to change what it includes or its limits."
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
                `${formatCedis(plan.pricePesewas)} ${BILLING_PERIOD_LABELS[plan.billingPeriod].toLowerCase()}`
              ) : (
                <span className="text-ink-3">Not set</span>
              ),
            },
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
              term: "SMS price",
              detail:
                plan.smsPricePesewas !== null ? (
                  `${formatCedis(plan.smsPricePesewas)} per message`
                ) : (
                  <span className="text-ink-3">Not set</span>
                ),
            },
            {
              term: "SMS this month",
              detail: <span className="tabular">{of(plan.smsThisMonth, plan.maxSmsPerMonth, "SMS")}</span>,
            },
          ]}
        />
      </Section>

      <Section
        title="What your plan includes"
        description="Students, classes, fees, payments and receipts are in every plan."
      >
        <ul className="divide-y divide-line border-y border-line">
          {FEATURES.map((feature) => {
            const included = plan.features.includes(feature);
            return (
              <li key={feature} className="flex items-start gap-3 py-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full ${included ? "bg-positive-soft text-positive" : "bg-subtle text-ink-3"}`}
                >
                  {included ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}
                </span>
                <div className="min-w-0">
                  <p className="text-base text-ink">
                    {FEATURE_LABELS[feature].name}
                    <span className="sr-only">{included ? ": included" : ": not included"}</span>
                    {!included && <span className="ml-2 text-sm text-ink-3">Not included</span>}
                  </p>
                  <p className="text-sm text-ink-3">{FEATURE_LABELS[feature].description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="SMS sent"
        description="Fee reminders, absence SMS and parent sign-in codes your school is charged for, by month."
      >
        <UsageTable usage={usage} />
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
                    <TD className="text-right tabular-nums">{formatCedis(invoice.totalPesewas)}</TD>
                    <TD>
                      <InvoiceState invoice={invoice} />
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
