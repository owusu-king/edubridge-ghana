import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { StudentAccount } from "@/server/fees/ledger";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { parseStatementDate, statementPeriod } from "@/lib/statement";
import type { DocumentLogo } from "@/server/tenancy/branding";
import { SchoolHeading } from "./school-heading";
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

function balanceWords(pesewas: number, currency: string): string {
  if (pesewas > 0) return `${formatMoney(pesewas, currency)} owed`;
  if (pesewas < 0) return `${formatMoney(-pesewas, currency)} in credit`;
  return "Nothing owed";
}

/** One student's statement as page(s): the body of a statement or of a family statement. */
function StatementPage({
  account,
  schoolName,
  logo,
  currency = "GHS",
  className,
  asOf,
  from = null,
  to = null,
}: {
  account: StudentAccount;
  schoolName: string;
  /** The school's logo, when it has a PNG or JPEG one. */
  logo?: DocumentLogo | null;
  /** The school's currency (ISO 4217). */
  currency?: string;
  className: string | null;
  /** Today in the school's time zone (YYYY-MM-DD). */
  asOf: string;
  /** A date range (FIN-12); without one, the whole account up to today. */
  from?: string | null;
  to?: string | null;
}) {
  const { student } = account;
  const period = statementPeriod(account.entries, from, to);
  const ranged = from !== null || to !== null;
  const closing = ranged ? period.closingPesewas : account.balancePesewas;
  return (
    <Page size="A4" style={[base.page, s.page]}>
      <View style={s.header}>
        <View>
          <SchoolHeading name={schoolName} logo={logo} />
          <Text style={s.title}>Fee statement</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontWeight: 600 }}>{student.name}</Text>
          <Text style={base.muted}>
            {student.admissionNumber}
            {className ? ` · ${className}` : ""}
          </Text>
          <Text style={base.muted}>
            {ranged
              ? `${from ? formatCalendarDate(from) : "Start"} to ${formatCalendarDate(to ?? asOf)}`
              : `As at ${formatCalendarDate(asOf)}`}
          </Text>
        </View>
      </View>

      <View style={s.summary}>
        <View>
          <Text style={base.label}>{ranged ? "Closing balance" : "Balance"}</Text>
          <Text style={[s.balance, closing > 0 ? {} : { color: COLORS.positive }]}>
            {balanceWords(closing, currency)}
          </Text>
        </View>
        {ranged ? (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={base.muted}>Opening balance {formatMoney(period.openingPesewas, currency)}</Text>
            <Text style={base.muted}>+ Charges {formatMoney(period.chargesPesewas, currency)}</Text>
            <Text style={base.muted}>− Payments {formatMoney(period.paymentsPesewas, currency)}</Text>
            <Text style={base.muted}>
              ± Discounts and adjustments {formatMoney(period.adjustmentsPesewas, currency)}
            </Text>
          </View>
        ) : (
          <View style={{ alignItems: "flex-end", justifyContent: "flex-end" }}>
            <Text style={base.muted}>Charges are positive; payments and discounts negative.</Text>
          </View>
        )}
      </View>

      <View style={s.th} fixed>
        <Text style={[base.label, s.date]}>Date</Text>
        <Text style={[base.label, s.entry]}>Entry</Text>
        <Text style={[base.label, s.amount]}>Amount</Text>
        <Text style={[base.label, s.running]}>Balance</Text>
      </View>
      {ranged && from && (
        <View style={s.tr} wrap={false}>
          <Text style={s.date}>{formatCalendarDate(from)}</Text>
          <Text style={[s.entry, { fontWeight: 600 }]}>Opening balance</Text>
          <Text style={s.amount} />
          <Text style={s.running}>{formatMoney(period.openingPesewas, currency)}</Text>
        </View>
      )}
      {period.entries.length === 0 ? (
        <Text style={s.empty}>
          {ranged ? "Nothing charged or paid in this period." : "No fees billed yet."}
        </Text>
      ) : (
        period.entries.map((entry) => (
          <View key={entry.id} style={s.tr} wrap={false}>
            <Text style={s.date}>{formatCalendarDate(entry.effectiveOn)}</Text>
            <View style={s.entry}>
              <Text style={entry.reversed ? { color: COLORS.ink3, textDecoration: "line-through" } : {}}>
                {entry.description}
              </Text>
              {entry.reversed ? <Text style={base.muted}>Reversed</Text> : null}
            </View>
            <Text style={s.amount}>{formatMoney(entry.amountPesewas, currency)}</Text>
            <Text style={s.running}>{formatMoney(entry.balancePesewas, currency)}</Text>
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
  );
}

type StatementProps = Parameters<typeof StatementPage>[0];

export function StatementDocument(props: StatementProps) {
  return (
    <Document
      title={`Fee statement, ${props.account.student.name}`}
      author={props.schoolName}
      creator="EduBridge"
    >
      <StatementPage {...props} />
    </Document>
  );
}

/**
 * A family statement (FIN-12, PRT-04): a first page with each child's balance and the family total, then
 * each child's own statement, for the same period. Children are those sharing a guardian.
 */
export function FamilyStatementDocument({
  children,
  familyName,
  ...shared
}: Omit<StatementProps, "account" | "className"> & {
  children: { account: StatementProps["account"]; className: string | null }[];
  /** How the family is named on the first page, e.g. the guardian's name. */
  familyName: string;
}) {
  const currency = shared.currency ?? "GHS";
  const ranged = (shared.from ?? null) !== null || (shared.to ?? null) !== null;
  const rows = children.map((c) => {
    const period = statementPeriod(c.account.entries, shared.from ?? null, shared.to ?? null);
    return { ...c, closing: ranged ? period.closingPesewas : c.account.balancePesewas };
  });
  const total = rows.reduce((sum, r) => sum + r.closing, 0);
  return (
    <Document title={`Family fee statement, ${familyName}`} author={shared.schoolName} creator="EduBridge">
      <Page size="A4" style={[base.page, s.page]}>
        <View style={s.header}>
          <View>
            <SchoolHeading name={shared.schoolName} logo={shared.logo} />
            <Text style={s.title}>Family fee statement</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ fontWeight: 600 }}>{familyName}</Text>
            <Text style={base.muted}>
              {ranged
                ? `${shared.from ? formatCalendarDate(shared.from) : "Start"} to ${formatCalendarDate(shared.to ?? shared.asOf)}`
                : `As at ${formatCalendarDate(shared.asOf)}`}
            </Text>
          </View>
        </View>
        <View style={s.summary}>
          <View>
            <Text style={base.label}>Family balance</Text>
            <Text style={[s.balance, total > 0 ? {} : { color: COLORS.positive }]}>
              {balanceWords(total, currency)}
            </Text>
          </View>
        </View>
        <View style={s.th}>
          <Text style={[base.label, { width: "60%" }]}>Child</Text>
          <Text style={[base.label, { width: "40%", textAlign: "right" }]}>Balance</Text>
        </View>
        {rows.map((r) => (
          <View key={r.account.student.id} style={s.tr} wrap={false}>
            <Text style={{ width: "60%" }}>
              {r.account.student.name} ({r.account.student.admissionNumber}
              {r.className ? `, ${r.className}` : ""})
            </Text>
            <Text style={{ width: "40%", textAlign: "right" }}>{formatMoney(r.closing, currency)}</Text>
          </View>
        ))}
        <Text style={[base.muted, { marginTop: 12 }]}>{"Each child’s statement follows."}</Text>
      </Page>
      {rows.map((r) => (
        <StatementPage key={r.account.student.id} {...shared} account={r.account} className={r.className} />
      ))}
    </Document>
  );
}

export async function renderFamilyStatementPdf(
  props: Parameters<typeof FamilyStatementDocument>[0],
): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<FamilyStatementDocument {...props} />);
}

/**
 * The optional ?from=&to= range of a statement download (FIN-12); no dates means the whole account. Returns
 * null when the dates are invalid or in the wrong order. The end is never after today.
 */
export function statementRange(
  request: Request,
  today: string,
): { from: string | null; to: string | null } | null {
  const params = new URL(request.url).searchParams;
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const from = parseStatementDate(rawFrom);
  const to = parseStatementDate(rawTo);
  if ((rawFrom && !from) || (rawTo && !to)) return null;
  const end = to && to > today ? today : to;
  if (from && end && from > end) return null;
  return { from, to: from && !end ? today : end };
}

export async function renderStatementPdf(props: Parameters<typeof StatementDocument>[0]): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<StatementDocument {...props} />);
}
