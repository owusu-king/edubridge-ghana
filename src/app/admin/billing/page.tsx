import type { Metadata, Route } from "next";
import Link from "next/link";
import { SubscriptionBadge } from "@/components/billing/billing-views";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getPlatformSettings } from "@/server/billing/settings";
import { getBillingOverview } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { todayIn } from "@/lib/format";
import { formatCedis, pesewasToInput } from "@/lib/money";
import { monthLabel, monthOf } from "@/lib/plan";
import { requirePlatformAdmin } from "@/web/auth";
import { updatePlatformSettingsAction } from "../actions";
import { PlatformSettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Billing" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const user = await requirePlatformAdmin();
  const { month: asked } = await searchParams;
  const current = monthOf(todayIn("Africa/Accra"));
  const month = asked && /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= current ? asked : current;
  const [rows, settings] = await Promise.all([
    getBillingOverview(db(), user.id, month),
    getPlatformSettings(db(), user.id),
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
      <Section title="Settings" description="Apply to every school unless its own page says otherwise.">
        <PlatformSettingsForm
          action={updatePlatformSettingsAction}
          defaults={{ smsPrice: pesewasToInput(settings.smsPricePesewas), graceDays: settings.graceDays }}
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
                    formatCedis(r.smsChargePesewas)
                  )}
                </TD>
                <TD className="hidden text-right tabular-nums lg:table-cell">{r.usage.sharedCodes}</TD>
                <TD className="text-right tabular-nums">
                  {r.unpaidCount === 0 ? (
                    <span className="text-ink-3">—</span>
                  ) : (
                    <>
                      {formatCedis(r.unpaidPesewas)}
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
