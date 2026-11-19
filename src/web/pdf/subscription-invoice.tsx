import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { InvoiceDocument } from "@/server/billing/subscriptions";
import { countryName, formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { base, COLORS, registerFonts } from "./theme";

/** An EduBridge invoice to a school (SUB-03): plain, one A4 page, the same figures the school sees on screen. */
const s = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 64, paddingHorizontal: 52, fontSize: 10, lineHeight: 1.45 },
  top: { flexDirection: "row", justifyContent: "space-between", marginBottom: 28 },
  brand: { fontSize: 16, fontWeight: 600 },
  title: { fontSize: 20, fontWeight: 600, textAlign: "right" },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  party: { width: "48%" },
  label: {
    color: COLORS.ink3,
    fontSize: 8.5,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  table: { borderTopWidth: 1, borderTopColor: COLORS.ink3 },
  row: { flexDirection: "row", paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  head: { color: COLORS.ink2, fontWeight: 600 },
  desc: { width: "52%" },
  qty: { width: "12%", textAlign: "right" },
  unit: { width: "18%", textAlign: "right" },
  amount: { width: "18%", textAlign: "right" },
  total: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 9 },
  totalText: { fontSize: 12, fontWeight: 600 },
  state: { marginTop: 18, padding: 10, borderWidth: 1, borderRadius: 3 },
  section: { marginTop: 18 },
});

function InvoicePage({ doc }: { doc: InvoiceDocument }) {
  const { invoice } = doc;
  const money = (minor: number) => formatMoney(minor, invoice.currencyCode);
  const stateBox =
    invoice.state === "paid"
      ? {
          color: COLORS.positive,
          text: `Paid on ${formatCalendarDate(invoice.paidOn!)}, reference ${invoice.paymentReference}. Thank you.`,
        }
      : invoice.state === "void"
        ? { color: COLORS.critical, text: `Void: ${invoice.voidReason}. Nothing is owed on this invoice.` }
        : invoice.state === "overdue"
          ? {
              color: COLORS.critical,
              text: `Overdue: payment was due on ${formatCalendarDate(invoice.dueOn)}.`,
            }
          : null;
  return (
    <Page size="A4" style={[base.page, s.page]}>
      <View style={s.top}>
        <Text style={s.brand}>EduBridge</Text>
        <View>
          <Text style={s.title}>Invoice</Text>
          <Text style={{ textAlign: "right", color: COLORS.ink2 }}>{invoice.invoiceNumber}</Text>
        </View>
      </View>
      <View style={s.parties}>
        <View style={s.party}>
          <Text style={s.label}>From</Text>
          <Text>{doc.issuer ?? "EduBridge"}</Text>
        </View>
        <View style={s.party}>
          <Text style={s.label}>To</Text>
          <Text>{doc.schoolName}</Text>
          <Text style={{ color: COLORS.ink2 }}>{countryName(doc.countryCode)}</Text>
        </View>
      </View>
      <View style={s.parties}>
        <View style={s.party}>
          <Text style={s.label}>Issued</Text>
          <Text>{formatCalendarDate(invoice.issuedOn)}</Text>
          <Text style={[s.label, { marginTop: 8 }]}>Due</Text>
          <Text>{formatCalendarDate(invoice.dueOn)}</Text>
        </View>
        <View style={s.party}>
          <Text style={s.label}>For the period</Text>
          <Text>
            {formatCalendarDate(invoice.periodStartsOn)} to {formatCalendarDate(invoice.periodEndsOn)}
          </Text>
        </View>
      </View>
      <View style={s.table}>
        <View style={[s.row, s.head]}>
          <Text style={s.desc}>Description</Text>
          <Text style={s.qty}>Quantity</Text>
          <Text style={s.unit}>Unit price</Text>
          <Text style={s.amount}>Amount</Text>
        </View>
        {invoice.lines.map((l, i) => (
          <View key={i} style={s.row} wrap={false}>
            <Text style={s.desc}>{l.description}</Text>
            <Text style={s.qty}>{l.quantity.toLocaleString("en-GH")}</Text>
            <Text style={s.unit}>{money(l.unitPesewas)}</Text>
            <Text style={s.amount}>{money(l.amountPesewas)}</Text>
          </View>
        ))}
      </View>
      <View style={s.total}>
        <Text style={s.totalText}>Total {money(invoice.totalPesewas)}</Text>
      </View>
      {stateBox && (
        <Text style={[s.state, { borderColor: stateBox.color, color: stateBox.color }]}>{stateBox.text}</Text>
      )}
      {doc.paymentInstructions && invoice.state !== "paid" && invoice.state !== "void" && (
        <View style={s.section}>
          <Text style={s.label}>How to pay</Text>
          <Text>{doc.paymentInstructions}</Text>
          <Text style={{ color: COLORS.ink2, marginTop: 4 }}>
            Please quote {invoice.invoiceNumber} with your payment.
          </Text>
        </View>
      )}
      <View style={base.footer} fixed>
        <Text>EduBridge · Invoice {invoice.invoiceNumber}</Text>
        <Text>{doc.schoolName}</Text>
      </View>
    </Page>
  );
}

export async function renderSubscriptionInvoicePdf(doc: InvoiceDocument): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(
    <Document title={`EduBridge invoice ${doc.invoice.invoiceNumber}`} author="EduBridge" creator="EduBridge">
      <InvoicePage doc={doc} />
    </Document>,
  );
}
