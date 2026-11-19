import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { BoardSummary } from "@/server/dashboard/board-summary";
import type { DocumentLogo } from "@/server/tenancy/branding";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { SchoolHeading } from "./school-heading";
import { base, COLORS, registerFonts } from "./theme";

const s = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 40 },
  header: { borderBottomWidth: 1, borderBottomColor: COLORS.line, paddingBottom: 10 },
  title: { marginTop: 10, marginBottom: 6, fontSize: 14, fontWeight: 600, lineHeight: 1.3 },
  section: { marginTop: 14 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
  },
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row} wrap={false}>
      <Text>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "Not available" : `${v}%`);

/**
 * The board summary (CMD-06): the chosen term's figures from the Command Center (the school overview), on one
 * page. Only figures the person could see on screen are printed; a figure with no data says so instead of showing
 * a number.
 */
export function BoardSummaryDocument({
  cc,
  schoolName,
  logo,
  currency,
  generatedOn,
  report = null,
}: {
  cc: BoardSummary;
  schoolName: string;
  logo?: DocumentLogo | null;
  currency: string;
  generatedOn: string;
  /** The Proprietor's report to the board, as they edited it (R5-5, DRF-03); printed above the figures. */
  report?: string | null;
}) {
  const money = (m: number | null | undefined) =>
    m === null || m === undefined ? "Not available" : formatMoney(m, currency);
  const point = cc.results;
  const finance = cc.money?.finance ?? null;
  const movement = cc.enrolment?.movement ?? null;
  return (
    <Document title={`${schoolName}: ${cc.term.label}`}>
      <Page size="A4" style={[base.page, s.page]}>
        <View style={s.header}>
          <SchoolHeading name={schoolName} logo={logo} />
          <Text style={s.title}>Board summary: {cc.term.label}</Text>
          <Text style={base.muted}>
            {cc.campus ? `${cc.campus.name} campus` : "Whole school"} · {formatCalendarDate(cc.term.startsOn)}{" "}
            to {formatCalendarDate(cc.term.endsOn)} · prepared {formatCalendarDate(generatedOn)} from the
            school&apos;s records
          </Text>
        </View>

        {report?.trim() && (
          <View style={s.section}>
            <Text style={base.label}>Report</Text>
            {report
              .trim()
              .split(/\n\s*\n/)
              .map((para, i) => (
                <Text key={i} style={{ marginTop: 6, lineHeight: 1.45 }}>
                  {para.replace(/\s*\n\s*/g, " ")}
                </Text>
              ))}
          </View>
        )}

        {cc.money && (
          <View style={s.section}>
            <Text style={base.label}>Money</Text>
            <Row label="Billed for the term" value={money(finance?.billedPesewas)} />
            <Row
              label="Collected in the term"
              value={money(finance?.collected?.totalPesewas ?? (finance?.period ? 0 : null))}
            />
            <Row label="Collection rate" value={pct(finance?.collectionRate)} />
            <Row label="Owed today, every term" value={money(cc.money.owed.totalPesewas)} />
            <Row label="Refunds waiting" value={String(cc.money.reconciliation.refundsWaiting)} />
            <Row
              label="Mobile Money differences open"
              value={String(cc.money.reconciliation.openDifferences)}
            />
          </View>
        )}

        {cc.enrolment && (
          <View style={s.section}>
            <Text style={base.label}>Enrolment</Text>
            <Row label="Students placed in classes" value={String(cc.enrolment.enrolment?.total ?? 0)} />
            <Row label="Applications received" value={String(movement?.applications ?? 0)} />
            <Row label="Admitted" value={String(movement?.admitted ?? 0)} />
            <Row
              label="Left (withdrawn, transferred, graduated)"
              value={`${movement?.left.withdrawn ?? 0}, ${movement?.left.transferred ?? 0}, ${movement?.left.graduated ?? 0}`}
            />
            <Row
              label={movement?.retention ? `Retention from ${movement.retention.previousTerm}` : "Retention"}
              value={pct(movement?.retention?.rate)}
            />
          </View>
        )}

        {cc.results && (
          <View style={s.section}>
            <Text style={base.label}>Results and attendance</Text>
            <Row label="Attendance (late counts as attending)" value={pct(point?.attendanceRate)} />
            <Row
              label="Average of published report cards"
              value={
                point?.averageScore === null || point?.averageScore === undefined
                  ? "Not available"
                  : point.averageScore.toFixed(1)
              }
            />
            <Row label="Report cards published" value={String(point?.publishedCards ?? 0)} />
          </View>
        )}

        {cc.comparison && cc.money && (
          <View style={s.section}>
            <Text style={base.label}>Campuses</Text>
            {cc.comparison.map((c) => (
              <Row
                key={c.id}
                label={`${c.name}: ${c.point?.enrolled ?? 0} students`}
                value={`${money(c.point?.collectedPesewas)} of ${money(c.point?.billedPesewas)} (${pct(c.point?.collectionRate)})`}
              />
            ))}
          </View>
        )}

        <View style={[base.footer, { left: 40, right: 40 }]} fixed>
          <Text>Figures from the school&apos;s records in EduBridge, as on the Command Center</Text>
          <Text>EduBridge</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function renderBoardSummaryPdf(
  props: Parameters<typeof BoardSummaryDocument>[0],
): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<BoardSummaryDocument {...props} />);
}
