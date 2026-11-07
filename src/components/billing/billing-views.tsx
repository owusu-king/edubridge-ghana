import { StatusText } from "@/components/ui/badge";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { MonthUsage, SubscriptionInvoice } from "@/server/billing/subscriptions";
import { formatCalendarDate } from "@/lib/format";
import { monthLabel, SUBSCRIPTION_STATUS_LABELS, type SubscriptionStatus } from "@/lib/plan";

/** "Trial, ends 30 Nov 2026" or "Active, paid until 18 Dec 2026", with a status colour and words. */
export function SubscriptionBadge({
  status,
  trialEndsOn,
  paidUntil,
}: {
  status: SubscriptionStatus;
  trialEndsOn: string | null;
  paidUntil: string | null;
}) {
  const tone = status === "active" ? "positive" : status === "trial" ? "neutral" : "caution";
  const detail =
    status === "trial" && trialEndsOn
      ? `, ends ${formatCalendarDate(trialEndsOn)}`
      : paidUntil
        ? `, paid until ${formatCalendarDate(paidUntil)}`
        : "";
  return (
    <StatusText tone={tone}>
      {SUBSCRIPTION_STATUS_LABELS[status]}
      {detail}
    </StatusText>
  );
}

export function InvoiceState({ invoice }: { invoice: SubscriptionInvoice }) {
  switch (invoice.state) {
    case "paid":
      return (
        <StatusText tone="positive">
          Paid {invoice.paidOn ? formatCalendarDate(invoice.paidOn) : ""}
        </StatusText>
      );
    case "void":
      return <StatusText tone="neutral">Void</StatusText>;
    case "overdue":
      return <StatusText tone="critical">Overdue</StatusText>;
    default:
      return <StatusText tone="caution">Due</StatusText>;
  }
}

/** SMS by month: what is billed, shared sign-in codes (not billed yet) and messages not delivered. */
export function UsageTable({ usage }: { usage: MonthUsage[] }) {
  return (
    <TableFrame>
      <Table>
        <caption className="sr-only">SMS by month</caption>
        <THead>
          <tr>
            <TH>Month</TH>
            <TH className="text-right">Fee reminders</TH>
            <TH className="hidden text-right md:table-cell">Absence SMS</TH>
            <TH className="text-right">Sign-in codes</TH>
            <TH className="hidden text-right sm:table-cell">Shared codes</TH>
            <TH className="hidden text-right sm:table-cell">Not delivered</TH>
            <TH className="text-right">Charged</TH>
          </tr>
        </THead>
        <TBody>
          {usage.map((u) => (
            <TR key={u.month}>
              <TD>{monthLabel(u.month)}</TD>
              <TD className="text-right tabular-nums">{u.reminders}</TD>
              <TD className="hidden text-right tabular-nums md:table-cell">{u.absenceAlerts}</TD>
              <TD className="text-right tabular-nums">{u.codes}</TD>
              <TD className="hidden text-right tabular-nums sm:table-cell">{u.sharedCodes}</TD>
              <TD className="hidden text-right tabular-nums sm:table-cell">{u.undelivered}</TD>
              <TD className="text-right font-medium tabular-nums">
                {u.billable.toLocaleString("en-GH", { maximumFractionDigits: 2 })}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <p className="border-t border-line px-4 py-2 text-sm text-ink-3">
        Shared codes went to a number other schools also have on file: each school is charged an equal share.
        Messages that could not be delivered are never charged.
      </p>
    </TableFrame>
  );
}
