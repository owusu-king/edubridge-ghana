import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { bandRanges, ordinal, weightedScore, type ReportCardSnapshot } from "@/lib/assessment";
import { formatCalendarDate } from "@/lib/format";
import { base, COLORS, registerFonts } from "./theme";

/** One A4 page per student, in the plain layout Ghanaian schools print for terminal reports. */
const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 52, paddingHorizontal: 40, fontSize: 9.5 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink3,
    paddingBottom: 10,
    marginBottom: 12,
  },
  title: { fontSize: 16, fontWeight: 600, marginTop: 2 },
  draft: { color: COLORS.critical, fontWeight: 600, marginTop: 2 },
  facts: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 },
  fact: { width: "25%", paddingVertical: 4, paddingRight: 8 },
  factValue: { marginTop: 1 },
  th: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: COLORS.ink3, paddingBottom: 4 },
  tr: { flexDirection: "row", paddingVertical: 4.5, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  subject: { flexGrow: 1, flexBasis: 0, paddingRight: 6 },
  num: { width: 52, textAlign: "right", paddingRight: 6 },
  grade: { width: 36, textAlign: "center" },
  remark: { width: 108, paddingLeft: 6 },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: COLORS.subtle,
    borderRadius: 3,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  traits: { flexDirection: "row", marginTop: 12 },
  trait: { width: "33.3%", paddingRight: 8 },
  remarkBlock: { marginTop: 12, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 8 },
  signature: { marginTop: 4, color: COLORS.ink3 },
  key: { marginTop: 14, flexDirection: "row", flexWrap: "wrap" },
  keyItem: { marginRight: 12, marginBottom: 2, color: COLORS.ink2, fontSize: 8 },
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.fact}>
      <Text style={base.label}>{label}</Text>
      <Text style={s.factValue}>{value}</Text>
    </View>
  );
}

function ReportCardPage({ card, draft }: { card: ReportCardSnapshot; draft: boolean }) {
  const positionsShown = card.showPositions;
  const attendance =
    card.attendance.present !== null && card.attendance.open !== null
      ? `${card.attendance.present} of ${card.attendance.open} days`
      : card.attendance.present !== null
        ? `${card.attendance.present} days`
        : "—";
  return (
    <Page size="A4" style={[base.page, s.page]}>
      <View style={s.header}>
        <View>
          <Text style={base.school}>{card.schoolName}</Text>
          <Text style={s.title}>Terminal report</Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={{ fontWeight: 600 }}>
            {card.term.name}, {card.term.yearName}
          </Text>
          {draft ? <Text style={s.draft}>Draft, not approved</Text> : null}
        </View>
      </View>

      <View style={s.facts}>
        <Fact label="Name" value={card.student.name} />
        <Fact label="Admission no." value={card.student.admissionNumber} />
        <Fact label="Class" value={card.student.className} />
        <Fact label="Number on roll" value={String(card.classSize)} />
        <Fact label="Attendance" value={attendance} />
        <Fact
          label="Next term begins"
          value={card.term.nextTermBeginsOn ? formatCalendarDate(card.term.nextTermBeginsOn) : "—"}
        />
        <Fact
          label="Average"
          value={card.overall.average !== null ? card.overall.average.toFixed(1) : "Not graded"}
        />
        {positionsShown ? (
          <Fact
            label="Position in class"
            value={
              card.overall.position !== null ? `${ordinal(card.overall.position)} of ${card.classSize}` : "—"
            }
          />
        ) : null}
      </View>

      <View style={s.th} fixed>
        <Text style={[base.label, s.subject]}>Subject</Text>
        {card.components.map((c) => (
          <Text key={c.key} style={[base.label, s.num]}>
            {c.name} {c.weight}%
          </Text>
        ))}
        <Text style={[base.label, s.num]}>Total 100%</Text>
        <Text style={[base.label, s.grade]}>Grade</Text>
        {positionsShown ? <Text style={[base.label, s.grade]}>Pos.</Text> : null}
        <Text style={[base.label, s.remark]}>Remark</Text>
      </View>
      {card.subjects.length === 0 ? (
        <Text style={{ paddingVertical: 10, color: COLORS.ink3 }}>No subjects.</Text>
      ) : (
        card.subjects.map((subject) => (
          <View key={subject.name} style={s.tr} wrap={false}>
            <Text style={s.subject}>{subject.name}</Text>
            {card.components.map((c, i) => (
              <Text key={c.key} style={s.num}>
                {subject.scores[i] !== null && subject.scores[i] !== undefined
                  ? weightedScore(subject.scores[i]!, c)
                  : "—"}
              </Text>
            ))}
            <Text style={[s.num, { fontWeight: 600 }]}>{subject.total ?? "—"}</Text>
            <Text style={[s.grade, { fontWeight: 600 }]}>{subject.grade ?? "—"}</Text>
            {positionsShown ? (
              <Text style={s.grade}>{subject.position !== null ? ordinal(subject.position) : "—"}</Text>
            ) : null}
            <Text style={[s.remark, subject.total === null ? { color: COLORS.ink3 } : {}]}>
              {subject.total === null ? "Not graded" : (subject.remark ?? "")}
            </Text>
          </View>
        ))
      )}

      <View style={s.summary} wrap={false}>
        <Text>
          {card.overall.total !== null
            ? `Total ${card.overall.total} of ${card.subjects.length * 100} · average ${card.overall.average?.toFixed(1)}`
            : `${card.overall.graded} of ${card.subjects.length} subjects graded`}
        </Text>
        {positionsShown && card.overall.position !== null ? (
          <Text style={{ fontWeight: 600 }}>
            {ordinal(card.overall.position)} of {card.classSize}
          </Text>
        ) : null}
      </View>

      <View style={s.traits} wrap={false}>
        {(
          [
            ["Attitude", card.remarks.attitude],
            ["Conduct", card.remarks.conduct],
            ["Interest", card.remarks.interest],
          ] as const
        ).map(([label, value]) => (
          <View key={label} style={s.trait}>
            <Text style={base.label}>{label}</Text>
            <Text style={s.factValue}>{value ?? "—"}</Text>
          </View>
        ))}
      </View>

      <View style={s.remarkBlock} wrap={false}>
        <Text style={base.label}>Class teacher&apos;s remark</Text>
        <Text style={s.factValue}>{card.remarks.classTeacher ?? "—"}</Text>
        {card.classTeacherName ? <Text style={s.signature}>{card.classTeacherName}</Text> : null}
      </View>
      <View style={s.remarkBlock} wrap={false}>
        <Text style={base.label}>Head teacher&apos;s remark</Text>
        <Text style={s.factValue}>{card.remarks.headTeacher ?? "—"}</Text>
        {card.approvedBy && card.approvedOn ? (
          <Text style={s.signature}>
            Approved by {card.approvedBy}, {formatCalendarDate(card.approvedOn)}
          </Text>
        ) : null}
      </View>

      <View style={s.key} wrap={false}>
        <Text style={[s.keyItem, { fontWeight: 600 }]}>Grades</Text>
        {bandRanges(card.bands).map((b) => (
          <Text key={b.min} style={s.keyItem}>
            {b.grade} {b.range}
            {b.remark ? ` ${b.remark}` : ""}
          </Text>
        ))}
      </View>

      <View style={base.footer} fixed>
        <Text>
          {card.schoolName} · {card.student.name} · {card.term.name}, {card.term.yearName}
        </Text>
        <Text>Prepared with EduBridge</Text>
      </View>
    </Page>
  );
}

export function ReportCardsDocument({
  cards,
  draft = false,
}: {
  cards: ReportCardSnapshot[];
  draft?: boolean;
}) {
  const first = cards[0];
  return (
    <Document
      title={
        cards.length === 1 && first
          ? `Report card, ${first.student.name}, ${first.term.name} ${first.term.yearName}`
          : `Report cards${first ? `, ${first.student.className}, ${first.term.name} ${first.term.yearName}` : ""}`
      }
      author={first?.schoolName}
      creator="EduBridge"
    >
      {cards.map((card, i) => (
        <ReportCardPage key={`${card.student.admissionNumber}-${i}`} card={card} draft={draft} />
      ))}
    </Document>
  );
}

/** One PDF with a page per report card. Drafts are marked as not approved. */
export async function renderReportCardsPdf(cards: ReportCardSnapshot[], draft = false): Promise<Buffer> {
  registerFonts();
  return renderToBuffer(<ReportCardsDocument cards={cards} draft={draft} />);
}
