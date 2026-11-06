import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { StudentAccount } from "@/server/fees/ledger";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { base, COLORS, registerFonts } from "./theme";

const s = StyleSheet.create({
  page: { paddingTop: 48, paddingBottom: 64, paddingHorizontal: 48 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    paddingBottom: 16,
    marginBottom: 18,
  },
  title: { fontSize: 18, fontWeight: 600, marginTop: 4 },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: COLORS.subtle,
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  balance: { fontSize: 15, fontWeight: 600, marginTop: 2 },
  th: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink3,
    paddingBottom: 5,
    marginBottom: 2,
  },
  tr: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  date: { width: "17%" },
  entry: { width: "47%", paddingRight: 8 },
  amount: { width: "18%", textAlign: "right" },
  running: { width: "18%", textAlign: "right" },
  empty: { paddingVertical: 16, color: COLORS.ink3 },
});

function balanceWords(pesewas: number): string {
  if (pesewas > 0) return `${formatCedis(pesewas)} owed`;
  if (pesewas < 0) return `${formatCedis(-pesewas)} in credit`;
  return "Nothing owed";
}

export function StatementDocument({
  account,
  schoolName,
  className,
  asOf,
}: {
  account: StudentAccount;
  schoolName: string;
  className: string | null;
  /** Today in the school's time zone (YYYY-MM-DD). */
  asOf: string;
}) {
  const { student } = account;
  return (
    <Document title={`Fee statement, ${student.name}`} author={schoolName} creator="EduBridge">
      <Page size="A4" style={[base.page, s.page]}>
        <View style={s.header}>
          <View>
            <Text style={base.school}>{schoolName}</Text>
            <Text style={s.title}>Fee statement</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ fontWeight: 600 }}>{student.name}</Text>
            <Text style={base.muted}>
              {student.admissionNumber}
              {className ? ` · ${className}` : ""}
            </Text>
            <Text style={base.muted}>As at {formatCalendarDate(asOf)}</Text>
          </View>
        </View>

        <View style={s.summary}>
          <View>
            <Text style={base.label}>Balance</Text>
            <Text style={[s.balance, account.balancePesewas > 0 ? {} : { color: COLORS.positive }]}>
              {balanceWords(account.balancePesewas)}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end", justifyContent: "flex-end" }}>
            <Text style={base.muted}>Charges are positive; payments and discounts negative.</Text>
          </View>
        </View>

        <View style={s.th} fixed>
          <Text style={[base.label, s.date]}>Date</Text>
          <Text style={[base.label, s.entry]}>Entry</Text>
          <Text style={[base.label, s.amount]}>Amount</Text>
          <Text style={[base.label, s.running]}>Balance</Text>
        </View>
        {account.entries.length === 0 ? (
          <Text style={s.empty}>No fees billed yet.</Text>
        ) : (
          account.entries.map((entry) => (
            <View key={entry.id} style={s.tr} wrap={false}>
              <Text style={s.date}>{formatCalendarDate(entry.effectiveOn)}</Text>
              <View style={s.entry}>
                <Text style={entry.reversed ? { color: COLORS.ink3, textDecoration: "line-through" } : {}}>
                  {entry.description}
                </Text>
                {entry.reversed ? <Text style={base.muted}>Reversed</Text> : null}
              </View>
              <Text style={s.amount}>{formatCedis(entry.amountPesewas)}</Text>
              <Text style={s.running}>{formatCedis(entry.balancePesewas)}</Text>
            </View>
          ))
        )}

        <View style={base.footer} fixed>
          <Text>
            {schoolName} · {student.name}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderStatementPdf(props: Parameters<typeof StatementDocument>[0]): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<StatementDocument {...props} />);
}
