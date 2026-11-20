import "server-only";
import { Document, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import { bandFor, bandRanges, ordinal, type ReportCardSnapshot } from "@/lib/assessment";
import { formatCalendarDate } from "@/lib/format";
import { formatGpa, partHeader, partValue, REPORT_CARD_STYLE_INFO } from "@/lib/report-styles";
import { base, COLORS, registerFonts } from "./theme";

/**
 * One A4 page per student. The layout follows the school's choice, frozen into each card when it is
 * published: the GES terminal report (cards published before layouts existed print this way), a British /
 * Cambridge progress report, an IB report or an American report card. The results are the same in all.
 */
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
  row: { paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: COLORS.line },
  cells: { flexDirection: "row" },
  subject: { flexGrow: 1, flexBasis: 0, paddingRight: 6 },
  num: { width: 52, textAlign: "right", paddingRight: 6 },
  grade: { width: 40, textAlign: "center" },
  remark: { width: 100, paddingLeft: 6 },
  comment: { marginTop: 2, paddingRight: 6, color: COLORS.ink2, fontSize: 8.5 },
  teacher: { color: COLORS.ink3 },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: COLORS.subtle,
    borderRadius: 3,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  traits: { flexDirection: "row", marginTop: 10 },
  trait: { width: "33.3%", paddingRight: 8 },
  remarkBlock: { marginTop: 10, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 7 },
  signature: { marginTop: 4, color: COLORS.ink3 },
  key: { marginTop: 12, flexDirection: "row", flexWrap: "wrap" },
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
  const style = card.style ?? "ges";
  const info = REPORT_CARD_STYLE_INFO[style];
  const positionsShown = card.showPositions && info.allowPositions;
  const remarkColumn = style === "ges" || style === "ib";
  const pointsColumn = info.showGpa && card.bands.some((b) => b.points !== undefined && b.points !== null);
  const gpa = card.overall.gpa ?? null;
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
          <Text style={s.title}>{info.title}</Text>
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
        {info.showAverage ? (
          <Fact
            label="Average"
            value={
              card.overall.average !== null
                ? `${card.overall.average.toFixed(1)}${style === "ges" ? "" : "%"}`
                : "Not graded"
            }
          />
        ) : null}
        {info.showGpa ? <Fact label="Term GPA" value={gpa !== null ? formatGpa(gpa) : "—"} /> : null}
        {card.overall.aggregate !== undefined && card.overall.aggregate !== null ? (
          <Fact label="Aggregate (best six)" value={String(card.overall.aggregate)} />
        ) : null}
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
            {partHeader(c, info.parts)}
          </Text>
        ))}
        {info.showTotal ? (
          <Text style={[base.label, s.num]}>{style === "ges" ? "Total 100%" : "Overall"}</Text>
        ) : null}
        <Text style={[base.label, s.grade]}>{style === "ges" ? "Grade" : info.labels.grade}</Text>
        {pointsColumn ? <Text style={[base.label, s.grade]}>Points</Text> : null}
        {positionsShown ? <Text style={[base.label, s.grade]}>Pos.</Text> : null}
        {remarkColumn ? (
          <Text style={[base.label, s.remark]}>{style === "ib" ? "Descriptor" : "Remark"}</Text>
        ) : null}
      </View>
      {card.subjects.length === 0 ? (
        <Text style={{ paddingVertical: 10, color: COLORS.ink3 }}>No subjects.</Text>
      ) : (
        card.subjects.map((subject) => {
          const points = subject.total !== null ? bandFor(card.bands, subject.total)?.points : null;
          const comment = subject.comment ?? null;
          const teacher = style === "ges" || !comment ? null : (subject.teacher ?? null);
          return (
            <View key={subject.name} style={s.row} wrap={false}>
              <View style={s.cells}>
                <Text style={s.subject}>{subject.name}</Text>
                {card.components.map((c, i) => (
                  <Text key={c.key} style={s.num}>
                    {partValue(subject.scores[i], c, info.parts)}
                  </Text>
                ))}
                {info.showTotal ? (
                  <Text style={[s.num, { fontWeight: 600 }]}>
                    {subject.total === null ? "—" : style === "ges" ? subject.total : `${subject.total}%`}
                  </Text>
                ) : null}
                <Text style={[s.grade, { fontWeight: 600 }]}>{subject.grade ?? "—"}</Text>
                {pointsColumn ? (
                  <Text style={s.grade}>
                    {points !== undefined && points !== null ? formatGpa(points) : "—"}
                  </Text>
                ) : null}
                {positionsShown ? (
                  <Text style={s.grade}>{subject.position !== null ? ordinal(subject.position) : "—"}</Text>
                ) : null}
                {remarkColumn ? (
                  <Text style={[s.remark, subject.total === null ? { color: COLORS.ink3 } : {}]}>
                    {subject.total === null ? "Not graded" : (subject.remark ?? "")}
                  </Text>
                ) : null}
              </View>
              {comment ? (
                <Text style={s.comment}>
                  {comment ?? ""}
                  {teacher ? <Text style={s.teacher}>{` · ${teacher}`}</Text> : null}
                </Text>
              ) : null}
            </View>
          );
        })
      )}

      <View style={s.summary} wrap={false}>
        <Text>
          {style === "ges"
            ? card.overall.total !== null
              ? `Total ${card.overall.total} of ${card.subjects.length * 100} · average ${card.overall.average?.toFixed(1)}`
              : `${card.overall.graded} of ${card.subjects.length} subjects graded`
            : style === "american"
              ? gpa !== null
                ? `Term GPA ${formatGpa(gpa)} (unweighted) · ${card.overall.graded} of ${card.subjects.length} subjects graded`
                : `${card.overall.graded} of ${card.subjects.length} subjects graded`
              : style === "cambridge" && card.overall.average !== null
                ? `Average ${card.overall.average.toFixed(1)}% across ${card.subjects.length} subjects`
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
            [info.labels.attitude, card.remarks.attitude],
            [info.labels.conduct, card.remarks.conduct],
            [info.labels.interest, card.remarks.interest],
          ] as const
        ).map(([label, value]) => (
          <View key={label} style={s.trait}>
            <Text style={base.label}>{label}</Text>
            <Text style={s.factValue}>{value ?? "—"}</Text>
          </View>
        ))}
      </View>

      <View style={s.remarkBlock} wrap={false}>
        <Text style={base.label}>{info.labels.classTeacher}</Text>
        <Text style={s.factValue}>{card.remarks.classTeacher ?? "—"}</Text>
        {card.classTeacherName ? <Text style={s.signature}>{card.classTeacherName}</Text> : null}
      </View>
      <View style={s.remarkBlock} wrap={false}>
        <Text style={base.label}>{info.labels.headTeacher}</Text>
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
            {pointsColumn && b.points !== undefined && b.points !== null ? ` (${formatGpa(b.points)})` : ""}
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
