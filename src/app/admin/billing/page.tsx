import type { Metadata, Route } from "next";
import Link from "next/link";
import { SubscriptionBadge } from "@/components/billing/billing-views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getInvoiceDetails, getPlatformSettings } from "@/server/billing/settings";
import { getBillingOverview } from "@/server/billing/subscriptions";
import { getRevenueOverview, readInvoicingSettings } from "@/server/billing/auto-invoices";
import { db } from "@/server/db/client";
import { todayIn } from "@/lib/format";
import { formatMoney, minorToInput } from "@/lib/money";
import { monthLabel, monthOf } from "@/lib/plan";
import { requirePlatformAdmin } from "@/web/auth";
import {
  updateInvoiceDetailsAction,
  updateInvoicingSettingsAction,
  updatePlatformSettingsAction,
} from "../actions";
import { InvoiceDetailsForm, InvoicingSettingsForm, PlatformSettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requirePlatformAdmin();
  const { month: asked } = await searchParams;
  const current = monthOf(todayIn("Africa/Accra"));
  const month = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= current ? asked : current;
  const year = current.slice(0, 4);
  const [rows, settings, invoiceDetails, invoicing, revenue] = await Promise.all([
    getBillingOverview(db(), user.id, month),
    getPlatformSettings(db(), user.id),
    getInvoiceDetails(db(), user.id),
    readInvoicingSettings(db()),
    getRevenueOverview(db(), user.id, year),
  ]);
  const real = rows.filter((r) => !r.isDemo);
  const sum = (pick: (r: (typeof rows)[number]) => number) => real.reduce((n, r) => n + pick(r), 0);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Billing"
        description="Each school's subscription, the SMS it was charged for in a month, and invoices not yet paid. Demo schools are listed but left out of the totals."
        actions={
          <form method="get" className="flex items-end gap-2" aria-label="Choose month">
            <div className="space-y-1.5">
              <label htmlFor="billing-month" className="block text-sm font-medium text-ink">
                Month
              </label>
              <Input
                id="billing-month"
                type="month"
                name="month"
                defaultValue={month}
                max={current}
                className="w-44"
              />
            </div>
            <Button type="submit" variant="secondary">
              Show
            </Button>
          </form>
        }
      />
      <Section
        title={`Revenue in ${year}`}
        description="EduBridge invoices issued this year (void ones left out), what has been paid and what is still owed."
      >
        {revenue.byCurrency.length === 0 ? (
          <p className="text-base text-ink-3">No invoices issued this year yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Revenue in {year}, by currency</caption>
              <THead>
                <tr>
                  <TH>Currency</TH>
                  <TH numeric>Invoiced</TH>
                  <TH numeric>Paid</TH>
                  <TH numeric>Owed</TH>
                  <TH numeric>Overdue</TH>
                </tr>
              </THead>
              <TBody>
                {revenue.byCurrency.map((r) => (
                  <TR key={r.currencyCode}>
                    <TD>{r.currencyCode}</TD>
                    <TD numeric>{formatMoney(r.invoiced, r.currencyCode)}</TD>
                    <TD numeric>{formatMoney(r.collected, r.currencyCode)}</TD>
                    <TD numeric>{formatMoney(r.outstanding, r.currencyCode)}</TD>
                    <TD numeric>{formatMoney(r.overdue, r.currencyCode)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
        {revenue.byPlan.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">Schools and revenue in {year}, by plan</caption>
              <THead>
                <tr>
                  <TH>Plan</TH>
                  <TH numeric>Schools</TH>
                  <TH numeric>Invoiced in {year}</TH>
                </tr>
              </THead>
              <TBody>
                {revenue.byPlan.map((p) => (
                  <TR key={`${p.planName}-${p.currencyCode}`}>
                    <TD>{p.planName}</TD>
                    <TD numeric>{p.schools}</TD>
                    <TD numeric>{formatMoney(p.invoiced, p.currencyCode)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
        {revenue.needPrice.length > 0 && (
          <p className="text-base text-ink-2">
            Not invoiced automatically until they have a price (set their plan, or an agreed price):{" "}
            {revenue.needPrice.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                <Link href={`/admin/schools/${s.id}` as Route} className="text-accent hover:underline">
                  {s.name}
                </Link>
              </span>
            ))}
            .
          </p>
        )}
      </Section>
      <Section
        title="Automatic invoices"
        description="Plans are priced per term by school size. Students are counted on the census day each term, and that count prices the term, the year or each month."
      >
        <InvoicingSettingsForm
          action={updateInvoicingSettingsAction}
          defaults={{
            autoInvoicing: invoicing.autoInvoicing,
            censusDays: invoicing.censusDays,
            invoiceDueDays: invoicing.invoiceDueDays,
            annualDiscount: String(invoicing.annualDiscountBp / 100),
            monthlySurcharge: String(invoicing.monthlySurchargeBp / 100),
          }}
        />
      </Section>
      <Section title="Settings" description="Apply to every school unless its own page says otherwise.">
        <PlatformSettingsForm
          action={updatePlatformSettingsAction}
          defaults={{
            smsPrice: minorToInput(settings.smsPricePesewas, "GHS"),
            whatsappPrice: minorToInput(settings.whatsappPricePesewas, "GHS"),
            graceDays: settings.graceDays,
          }}
        />
      </Section>
      <Section title="Invoice details" description="Printed on every EduBridge invoice PDF.">
        <InvoiceDetailsForm
          action={updateInvoiceDetailsAction}
          defaults={{
            issuer: invoiceDetails.issuer ?? "",
            paymentInstructions: invoiceDetails.paymentInstructions ?? "",
          }}
        />
      </Section>
      <p className="text-base text-ink-2">
        {monthLabel(month)}:{" "}
        <span className="font-semibold text-ink tabular-nums">
          {sum((r) => r.usage.billable).toLocaleString("en-GH", { maximumFractionDigits: 2 })}
        </span>{" "}
        SMS charged across {real.length} {real.length === 1 ? "school" : "schools"};{" "}
        <span className="font-semibold text-ink tabular-nums">{sum((r) => r.unpaidCount)}</span> invoices
        unpaid.
      </p>
      <TableFrame>
        <Table>
          <caption className="sr-only">Billing by school, {monthLabel(month)}</caption>
          <THead>
            <tr>
              <TH>School</TH>
              <TH>Subscription</TH>
              <TH className="text-right">Active students</TH>
              <TH className="text-right">SMS charged</TH>
              <TH className="hidden text-right md:table-cell">SMS charge</TH>
              <TH className="hidden text-right lg:table-cell">Shared codes</TH>
              <TH className="text-right">Unpaid</TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.tenantId}>
                <TD>
                  <Link
                    href={`/admin/schools/${r.tenantId}` as Route}
                    className="font-medium text-ink hover:text-accent hover:underline"
                  >
                    {r.name}
                  </Link>
                  <span className="mt-0.5 flex flex-wrap gap-1.5">
                    {r.isDemo && <Badge tone="caution">Demo</Badge>}
                    {r.schoolStatus === "suspended" && <Badge>Suspended</Badge>}
                  </span>
                </TD>
                <TD>
                  <SubscriptionBadge status={r.status} trialEndsOn={null} paidUntil={r.paidUntil} />
                </TD>
                <TD className="text-right tabular-nums">{r.activeStudents.toLocaleString("en-GH")}</TD>
                <TD className="text-right tabular-nums">
                  {r.usage.billable.toLocaleString("en-GH", { maximumFractionDigits: 2 })}
                </TD>
                <TD className="hidden text-right tabular-nums md:table-cell">
                  {r.smsChargePesewas === null ? (
                    <span className="text-ink-3">No price</span>
                  ) : (
                    formatMoney(r.smsChargePesewas, r.currencyCode)
                  )}
                </TD>
                <TD className="hidden text-right tabular-nums lg:table-cell">{r.usage.sharedCodes}</TD>
                <TD className="text-right tabular-nums">
                  {r.unpaidCount === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <>
                      {formatMoney(r.unpaidPesewas, r.currencyCode)}
                      <span className="block text-sm text-ink-3">
                        {r.unpaidCount} {r.unpaidCount === 1 ? "invoice" : "invoices"}
                      </span>
                    </>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
    </div>
  );
}
