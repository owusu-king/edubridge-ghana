import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { InvoiceQuote } from "@/server/billing/auto-invoices";

/**
 * A school's next EduBridge invoice, worked out the way it will be issued: the period, the students it is priced
 * on, its lines and when it is issued and due. Shown to the school (Settings, Plan) and to EduBridge staff.
 */
export function NextInvoice({ quote, audience }: { quote: InvoiceQuote; audience: "school" | "staff" }) {
  if (quote.status === "none" || quote.status === "invoiced")
    return (
      <p className="text-base text-ink-2">
        {quote.reason}
        {quote.period && quote.status === "none" && audience === "staff"
          ? ` (Period: ${quote.period.label}.)`
          : ""}
      </p>
    );
  const students = quote.students?.toLocaleString("en-GH");
  const counted = quote.counted
    ? `${students} active students, counted on the census day`
    : quote.status === "ready"
      ? `${students} active students today, counted when it is issued`
      : `${students} active students today; they are counted on the census day`;
  return (
    <div className="space-y-3">
      <p className="text-base text-ink-2">
        For {quote.period!.label}
        {quote.band ? ` (${quote.band})` : ""}: {counted}.{" "}
        {quote.status === "ready"
          ? audience === "staff"
            ? "Due to be issued now."
            : "EduBridge issues it shortly; the Proprietor is emailed."
          : `Issued on ${formatCalendarDate(quote.issueOn!)}, due on ${formatCalendarDate(quote.dueOn!)}.`}
      </p>
      <TableFrame>
        <Table>
          <caption className="sr-only">Next invoice</caption>
          <THead>
            <tr>
              <TH>Item</TH>
              <TH numeric>Amount</TH>
            </tr>
          </THead>
          <TBody>
            {quote.lines.map((l, i) => (
              <TR key={i}>
                <TD>
                  {l.description}
                  {l.quantity > 1 && (
                    <span className="block text-sm text-ink-3">
                      {l.quantity.toLocaleString("en-GH")} × {formatMoney(l.unitPesewas, quote.currencyCode)}
                    </span>
                  )}
                </TD>
                <TD numeric>{formatMoney(l.amountPesewas, quote.currencyCode)}</TD>
              </TR>
            ))}
            <TR>
              <TD className="font-semibold text-ink">Total</TD>
              <TD numeric className="font-semibold text-ink">
                {formatMoney(quote.totalMinor, quote.currencyCode)}
              </TD>
            </TR>
          </TBody>
        </Table>
      </TableFrame>
      {!quote.counted && (
        <p className="text-sm text-ink-3">
          {quote.status === "ready"
            ? "An estimate: the price follows the number of active students counted when the invoice is issued."
            : "An estimate until the census day: the price follows the number of active students counted then."}
        </p>
      )}
    </div>
  );
}
