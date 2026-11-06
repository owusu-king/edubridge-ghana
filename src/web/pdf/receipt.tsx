import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Receipt } from "@/server/fees/payments";
import { METHOD_LABELS } from "@/server/fees/payments";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { base, COLORS, registerFonts } from "./theme";

const s = StyleSheet.create({
  page: { paddingTop: 44, paddingBottom: 56, paddingHorizontal: 40 },
  header: { borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingBottom: 14 },
  amountBox: { alignItems: "center", paddingVertical: 22 },
  amount: { fontSize: 24, fontWeight: 600, marginTop: 4 },
  rows: { borderTopWidth: 1, borderTopColor: COLORS.line },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  term: { color: COLORS.ink2, width: "42%" },
  detail: { width: "58%", textAlign: "right" },
  void: {
    marginTop: 12,
    padding: 8,
    borderWidth: 1,
    borderColor: COLORS.critical,
    color: COLORS.critical,
    borderRadius: 3,
  },
});

function Row({ term, children, note }: { term: string; children: string; note?: string | null }) {
  return (
    <View style={s.row} wrap={false}>
      <Text style={s.term}>{term}</Text>
      <View style={s.detail}>
        <Text>{children}</Text>
        {note ? <Text style={base.muted}>{note}</Text> : null}
      </View>
    </View>
  );
}

function balanceWords(pesewas: number): string {
  if (pesewas > 0) return `${formatCedis(pesewas)} owed`;
  if (pesewas < 0) return `${formatCedis(-pesewas)} in credit`;
  return "Nothing owed";
}

export function ReceiptDocument({
  receipt,
  schoolName,
  timeZone,
}: {
  receipt: Receipt;
  schoolName: string;
  timeZone: string;
}) {
  return (
    <Document title={`Receipt ${receipt.receiptNumber}`} author={schoolName} creator="EduBridge">
      <Page size="A5" style={[base.page, s.page]}>
        <View style={s.header}>
          <Text style={base.school}>{schoolName}</Text>
          <Text style={[base.label, { marginTop: 3 }]}>
            Payment receipt {receipt.receiptNumber}
            {receipt.voided ? "  ·  VOID" : ""}
          </Text>
        </View>
        {receipt.voided && (
          <Text style={s.void}>
            This receipt was voided on {formatDateTime(receipt.voided.at, timeZone)}
            {receipt.voided.by ? ` by ${receipt.voided.by}` : ""}: {receipt.voided.reason}
          </Text>
        )}
        <View style={s.amountBox}>
          <Text style={base.label}>Amount received</Text>
          <Text
            style={[s.amount, receipt.voided ? { textDecoration: "line-through", color: COLORS.ink3 } : {}]}
          >
            {formatCedis(receipt.amountPesewas)}
          </Text>
        </View>
        <View style={s.rows}>
          <Row term="Date">{formatCalendarDate(receipt.paidOn)}</Row>
          <Row
            term="Student"
            note={[receipt.student.admissionNumber, receipt.student.className].filter(Boolean).join(" · ")}
          >
            {receipt.student.name}
          </Row>
          {receipt.payerName ? <Row term="Received from">{receipt.payerName}</Row> : null}
          <Row term="Paid by" note={receipt.reference}>
            {METHOD_LABELS[receipt.method]}
          </Row>
          <Row term="Balance after this payment">{balanceWords(receipt.balanceAfterPesewas)}</Row>
          <Row term="Received by">{receipt.recordedBy ?? "Recorded automatically"}</Row>
        </View>
        <View style={[base.footer, { left: 40, right: 40 }]} fixed>
          <Text>Recorded {formatDateTime(receipt.recordedAt, timeZone)}</Text>
          <Text>EduBridge</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderReceiptPdf(props: Parameters<typeof ReceiptDocument>[0]): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<ReceiptDocument {...props} />);
}
