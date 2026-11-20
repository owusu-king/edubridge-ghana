import type { Metadata, Route } from "next";
import Link from "next/link";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { getCurrentTerm } from "@/server/academics/calendar";
import { db } from "@/server/db/client";
import { METHOD_LABELS, type PaymentMethod } from "@/server/fees/payments";
import { getIncomeAndSpending } from "@/server/finance/service";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Finances · Income and spending" };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const monthName = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/*
 * Each figure has its own hairline colour, from the design tokens, with a matching dot by its label: money in is
 * green, refunds amber, spending the deep accent (spending is normal, not an alarm), and the net a strong neutral
 * that turns red only when more went out than came in.
 */
type Tone = "in" | "refunds" | "spent" | "net" | "loss";
const TONES: Record<Tone, { card: string; dot: string }> = {
  in: { card: "border-positive/60", dot: "bg-positive" },
  refunds: { card: "border-caution/60", dot: "bg-caution" },
  spent: { card: "border-accent/60", dot: "bg-accent" },
  net: { card: "border-ink/45", dot: "bg-ink" },
  loss: { card: "border-critical/60", dot: "bg-critical" },
};

function figures(t: {
  incomePesewas: number;
  refundsPesewas: number;
  spendingPesewas: number;
  netPesewas: number;
}): { label: string; value: number; tone: Tone }[] {
  return [
    { label: "Money in", value: t.incomePesewas, tone: "in" },
    { label: "Refunds paid", value: t.refundsPesewas, tone: "refunds" },
    { label: "Spent", value: t.spendingPesewas, tone: "spent" },
    { label: "Net", value: t.netPesewas, tone: t.netPesewas < 0 ? "loss" : "net" },
  ];
}

/**
 * Money in against money out for a period (the current term by default): receipts that stand, less refunds paid out,
 * against approved expenses, month by month. A cash view for the Proprietor, not accounts drawn up by an accountant.
 */
export default async function IncomeAndSpendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const show = moneyFormatter(ctx.tenant.currencyCode);
  const today = todayIn(ctx.tenant.timezone);
  const term = await getCurrentTerm(db(), ctx);
  const from =
    search.from && DATE.test(search.from) ? search.from : (term?.startsOn ?? `${today.slice(0, 4)}-01-01`);
  const toDefault = term && term.endsOn < today ? term.endsOn : today;
  const to = search.to && DATE.test(search.to) ? search.to : toDefault;
  const report = await getIncomeAndSpending(db(), ctx, { from: from <= to ? from : to, to });
  const t = report.totals;

  return (
    <div className="space-y-12">
      <form className="flex flex-wrap items-end gap-3" method="get">
        <Field label="From">
          {(p) => <Input {...p} type="date" name="from" defaultValue={report.from} />}
        </Field>
        <Field label="To">{(p) => <Input {...p} type="date" name="to" defaultValue={report.to} />}</Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      <Section
        title={`${formatCalendarDate(report.from)} to ${formatCalendarDate(report.to)}`}
        description="Fee receipts that stand, less refunds paid out, against approved expenses."
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {figures(t).map(({ label, value, tone }) => (
            <div key={label} className={`rounded-lg border bg-surface px-4 py-3 ${TONES[tone].card}`}>
              <dt className="flex items-center gap-2 text-sm text-ink-3">
                <span aria-hidden="true" className={`size-1.5 rounded-full ${TONES[tone].dot}`} />
                {label}
              </dt>
              <dd
                className={`mt-1 text-xl font-semibold tabular-nums ${tone === "loss" ? "text-critical" : "text-ink"}`}
              >
                {show(value)}
              </dd>
            </div>
          ))}
        </dl>
        <ul className="space-y-1 text-base text-ink-2">
          <li>
            Cash and cheques received but not yet banked:{" "}
            <Link
              href={schoolPath(slug, "finance/deposits") as Route}
              className="font-medium text-accent hover:underline"
            >
              {show(report.undepositedPesewas)}
            </Link>
          </li>
          {report.pending.count > 0 && (
            <li>
              {report.pending.count} expense{report.pending.count === 1 ? "" : "s"} for{" "}
              {show(report.pending.amountPesewas)} waiting for the Proprietor (not counted above):{" "}
              <Link
                href={schoolPath(slug, "finance/expenses") as Route}
                className="font-medium text-accent hover:underline"
              >
                Expenses
              </Link>
            </li>
          )}
        </ul>
      </Section>

      <Section title="By month">
        {report.months.length === 0 ? (
          <p className="text-base text-ink-2">No money in or out in these dates.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Month</TH>
                  <TH numeric>Money in</TH>
                  <TH numeric>Refunds</TH>
                  <TH numeric>Spent</TH>
                  <TH numeric>Net</TH>
                </tr>
              </THead>
              <TBody>
                {report.months.map((m) => {
                  const net = m.incomePesewas - m.refundsPesewas - m.spendingPesewas;
                  return (
                    <TR key={m.month}>
                      <TD>{monthName(m.month)}</TD>
                      <TD numeric>{show(m.incomePesewas)}</TD>
                      <TD numeric>{show(m.refundsPesewas)}</TD>
                      <TD numeric>{show(m.spendingPesewas)}</TD>
                      <TD numeric className={net < 0 ? "text-critical" : undefined}>
                        {show(net)}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <div className="grid gap-12 lg:grid-cols-2">
        <Section title="Money in by method">
          {report.incomeByMethod.length === 0 ? (
            <p className="text-base text-ink-2">No receipts in these dates.</p>
          ) : (
            <TableFrame>
              <Table>
                <TBody>
                  {report.incomeByMethod.map((r) => (
                    <TR key={r.method}>
                      <TD>{METHOD_LABELS[r.method as PaymentMethod] ?? r.method}</TD>
                      <TD numeric>{show(r.amountPesewas)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
        <Section title="Spending by category">
          {report.spendingByCategory.length === 0 ? (
            <p className="text-base text-ink-2">
              No approved expenses in these dates.{" "}
              <Link
                href={schoolPath(slug, "finance/expenses") as Route}
                className="text-accent hover:underline"
              >
                Record one
              </Link>
              .
            </p>
          ) : (
            <TableFrame>
              <Table>
                <TBody>
                  {report.spendingByCategory.map((r) => (
                    <TR key={r.category}>
                      <TD>{r.category}</TD>
                      <TD numeric>{show(r.amountPesewas)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      </div>
    </div>
  );
}
