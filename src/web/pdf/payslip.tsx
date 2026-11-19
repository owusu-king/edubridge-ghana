import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { Payslip } from "@/server/payroll/service";
import type { DocumentLogo } from "@/server/tenancy/branding";
import { formatMoney } from "@/lib/money";
import { monthLabel } from "@/lib/plan";
import { SchoolHeading } from "./school-heading";
import { base, COLORS, registerFonts } from "./theme";

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 36 },
  header: { borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingBottom: 12 },
  who: { marginTop: 12, marginBottom: 10 },
  name: { fontSize: 12, fontWeight: 600 },
  section: { marginTop: 10 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
  total: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, fontWeight: 600 },
  net: {
    marginTop: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 3,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  netAmount: { fontSize: 14, fontWeight: 600 },
  draft: { marginTop: 10, padding: 6, borderWidth: 1, borderColor: COLORS.critical, color: COLORS.critical },
});

function Line({ label, note, amount }: { label: string; note?: string | null; amount: string }) {
  return (
    <View style={s.row} wrap={false}>
      <View>
        <Text>{label}</Text>
        {note ? <Text style={base.muted}>{note}</Text> : null}
      </View>
      <Text>{amount}</Text>
    </View>
  );
}

/** A payslip (PRL-03): what was earned, what was deducted, net pay, and the school's own contributions. */
export function PayslipDocument({
  slip,
  schoolName,
  logo,
}: {
  slip: Payslip;
  schoolName: string;
  logo?: DocumentLogo | null;
}) {
  const money = (m: number) => formatMoney(m, slip.currencyCode);
  const earnings = slip.items.filter((i) => i.kind === "earning");
  const deductions = slip.items.filter((i) => i.kind === "deduction");
  const employer = slip.items.filter((i) => i.kind === "employer");
  return (
    <Document title={`Payslip ${slip.staffNumber} ${slip.month}`} author={schoolName} creator="EduBridge">
      <Page size="A5" style={[base.page, s.page]}>
        <View style={s.header}>
          <SchoolHeading name={schoolName} logo={logo} />
          <Text style={[base.label, { marginTop: 3 }]}>Payslip · {monthLabel(slip.month)}</Text>
        </View>
        {slip.status !== "approved" && (
          <Text style={s.draft}>Draft: payroll for this month is not approved yet. Not a final payslip.</Text>
        )}
        <View style={s.who}>
          <Text style={s.name}>{slip.staffName}</Text>
          <Text style={base.muted}>{[slip.staffNumber, slip.position].filter(Boolean).join(" · ")}</Text>
        </View>
        <View style={s.section}>
          <Text style={base.label}>Earnings</Text>
          <Line label="Basic salary" amount={money(slip.basic)} />
          {earnings.map((i, n) => (
            <Line
              key={n}
              label={i.name}
              note={i.adjustment ? "Adjustment" : i.basis}
              amount={money(i.amount)}
            />
          ))}
          <View style={s.total}>
            <Text>Gross pay</Text>
            <Text>{money(slip.gross)}</Text>
          </View>
        </View>
        {deductions.length > 0 && (
          <View style={s.section}>
            <Text style={base.label}>Deductions</Text>
            {deductions.map((i, n) => (
              <Line
                key={n}
                label={i.name}
                note={i.adjustment ? "Adjustment" : i.basis}
                amount={money(i.amount)}
              />
            ))}
            <View style={s.total}>
              <Text>Total deductions</Text>
              <Text>{money(slip.deductions)}</Text>
            </View>
          </View>
        )}
        <View style={s.net}>
          <Text style={s.netAmount}>Net pay</Text>
          <Text style={s.netAmount}>{money(slip.net)}</Text>
        </View>
        {employer.length > 0 && (
          <View style={s.section}>
            <Text style={base.label}>Paid by the school on top of your pay</Text>
            {employer.map((i, n) => (
              <Line key={n} label={i.name} note={i.basis} amount={money(i.amount)} />
            ))}
          </View>
        )}
        <View style={[base.footer, { left: 36, right: 36 }]} fixed>
          <Text>Payroll record kept in EduBridge</Text>
          <Text>EduBridge</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderPayslipPdf(props: Parameters<typeof PayslipDocument>[0]): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<PayslipDocument {...props} />);
}
