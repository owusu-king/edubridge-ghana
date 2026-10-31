import type { Metadata } from "next";
import Link from "next/link";
import { Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { listPaymentsOn, METHOD_LABELS } from "@/server/fees/payments";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Fees · Payments" };

export default async function PaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const today = todayIn(ctx.tenant.timezone);
  const day = await listPaymentsOn(db(), ctx, search.date ?? today);
  const label = day.date === today ? "today" : formatCalendarDate(day.date);

  return (
    <div className="space-y-6">
      <form method="get" className="flex items-end gap-2" aria-label="Choose day">
        <div className="space-y-1.5">
          <label htmlFor="payments-date" className="block text-sm font-medium text-ink">
            Day
          </label>
          <Input
            id="payments-date"
            name="date"
            type="date"
            defaultValue={day.date}
            max={today}
            className="w-44"
          />
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {day.payments.length === 0 ? (
        <EmptyState
          icon={<Banknote />}
          title={`No payments ${day.date === today ? "today" : `on ${label}`}`}
          description="Payments are recorded from each student's page."
        />
      ) : (
        <>
          <section aria-labelledby="day-totals" className="space-y-2">
            <h2 id="day-totals" className="text-md font-semibold text-ink">
              Received {label}: <span className="tabular-nums">{formatCedis(day.totalPesewas)}</span>
            </h2>
            <ul className="flex flex-wrap gap-x-6 gap-y-1 text-base text-ink-2">
              {day.byMethod.map((m) => (
                <li key={m.method}>
                  {METHOD_LABELS[m.method]}:{" "}
                  <span className="text-ink tabular-nums">{formatCedis(m.totalPesewas)}</span> ({m.count})
                </li>
              ))}
            </ul>
          </section>
          <TableFrame>
            <Table>
              <caption className="sr-only">Payments received {label}</caption>
              <THead>
                <tr>
                  <TH>Receipt</TH>
                  <TH>Student</TH>
                  <TH className="hidden sm:table-cell">Method</TH>
                  <TH className="text-right">Amount</TH>
                </tr>
              </THead>
              <TBody>
                {day.payments.map((p) => (
                  <TR key={p.id}>
                    <TD className="whitespace-nowrap">
                      <Link
                        href={schoolPath(slug, `fees/receipts/${p.id}`)}
                        className="font-mono text-sm text-accent hover:underline"
                      >
                        {p.receiptNumber}
                      </Link>
                      {p.voided && <span className="block text-sm text-critical">Voided</span>}
                    </TD>
                    <TD>
                      <Link
                        href={schoolPath(slug, `students/${p.studentId}`)}
                        className="text-ink hover:underline"
                      >
                        {p.studentName}
                      </Link>
                      <span className="block text-sm text-ink-3 sm:hidden">{METHOD_LABELS[p.method]}</span>
                    </TD>
                    <TD className="hidden sm:table-cell">
                      {METHOD_LABELS[p.method]}
                      {p.reference && <span className="block text-sm text-ink-3">{p.reference}</span>}
                    </TD>
                    <TD
                      className={`text-right whitespace-nowrap tabular-nums ${p.voided ? "text-ink-3 line-through" : ""}`}
                    >
                      {formatCedis(p.amountPesewas)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </>
      )}
    </div>
  );
}
