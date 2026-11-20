import { bandFor, bandRanges, ordinal, type ReportCardSnapshot } from "@/lib/assessment";
import { formatCalendarDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { formatGpa, partHeader, partValue, REPORT_CARD_STYLE_INFO } from "@/lib/report-styles";

/**
 * A report card on screen, from the same snapshot the PDF prints, in the school's layout. On phones the
 * subject table keeps only the total and grade; the parts and positions appear from the small breakpoint up.
 */
export function ReportCardView({ card }: { card: ReportCardSnapshot }) {
  const style = card.style ?? "ges";
  const info = REPORT_CARD_STYLE_INFO[style];
  const positionsShown = card.showPositions && info.allowPositions;
  const pointsShown = info.showGpa && card.bands.some((b) => b.points !== undefined && b.points !== null);
  const gpa = card.overall.gpa ?? null;
  const facts: [string, string][] = [
    ["Class", card.student.className],
    ["Number on roll", String(card.classSize)],
    [
      "Attendance",
      card.attendance.present !== null
        ? card.attendance.open !== null
          ? `${card.attendance.present} of ${card.attendance.open} days`
          : `${card.attendance.present} days`
        : "—",
    ],
    ["Next term begins", card.term.nextTermBeginsOn ? formatCalendarDate(card.term.nextTermBeginsOn) : "—"],
  ];
  if (info.showAverage)
    facts.push([
      "Average",
      card.overall.average !== null
        ? `${card.overall.average.toFixed(1)}${style === "ges" ? "" : "%"}`
        : "Not graded",
    ]);
  if (info.showGpa) facts.push(["Term GPA", gpa !== null ? formatGpa(gpa) : "—"]);
  if (card.overall.aggregate !== undefined && card.overall.aggregate !== null)
    facts.push(["Aggregate (best six)", String(card.overall.aggregate)]);
  if (positionsShown)
    facts.push([
      "Position in class",
      card.overall.position !== null ? `${ordinal(card.overall.position)} of ${card.classSize}` : "—",
    ]);
  const th = "h-9 px-3 text-xs font-medium tracking-wide text-ink-3 uppercase";

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {facts.map(([term, detail]) => (
          <div key={term}>
            <dt className="text-sm text-ink-3">{term}</dt>
            <dd className="text-base text-ink tabular-nums">{detail}</dd>
          </div>
        ))}
      </dl>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-raised">
        <table className="w-full border-collapse text-left text-base">
          <caption className="sr-only">
            {info.title}, {card.term.name} {card.term.yearName}
          </caption>
          <thead className="border-b border-line bg-canvas/60">
            <tr>
              <th scope="col" className={cn(th, "px-4 pl-5")}>
                Subject
              </th>
              {card.components.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(th, "hidden text-right whitespace-nowrap sm:table-cell")}
                >
                  {partHeader(c, info.parts)}
                </th>
              ))}
              {info.showTotal && (
                <th scope="col" className={cn(th, "text-right")}>
                  {style === "ges" ? "Total" : "Overall"}
                </th>
              )}
              <th scope="col" className={th}>
                {info.labels.grade}
              </th>
              {pointsShown && (
                <th scope="col" className={cn(th, "hidden text-right sm:table-cell")}>
                  Points
                </th>
              )}
              {positionsShown && (
                <th scope="col" className={cn(th, "hidden pr-5 text-right sm:table-cell")}>
                  Position
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {card.subjects.map((s) => {
              const points = s.total !== null ? bandFor(card.bands, s.total)?.points : null;
              const teacher = style === "ges" || !s.comment ? null : (s.teacher ?? null);
              return (
                <tr key={s.name}>
                  <th scope="row" className="px-4 py-3 pl-5 text-left align-top font-normal text-ink">
                    {s.name}
                    {s.comment && (
                      <span className="mt-0.5 block max-w-prose text-sm text-ink-2">
                        {s.comment}
                        {teacher && (
                          <span className="text-ink-3">
                            {" · "}
                            {teacher}
                          </span>
                        )}
                      </span>
                    )}
                  </th>
                  {card.components.map((c, i) => (
                    <td
                      key={c.key}
                      className="hidden px-3 py-3 text-right align-top text-ink-2 tabular-nums sm:table-cell"
                    >
                      {partValue(s.scores[i], c, info.parts)}
                    </td>
                  ))}
                  {info.showTotal && (
                    <td className="px-3 py-3 text-right align-top font-medium text-ink tabular-nums">
                      {s.total === null ? "—" : style === "ges" ? s.total : `${s.total}%`}
                    </td>
                  )}
                  <td className="px-3 py-3 align-top">
                    {s.total === null ? (
                      <span className="text-sm text-ink-3">Not graded</span>
                    ) : (
                      <span>
                        <span className="font-medium text-ink">{s.grade}</span>
                        {style !== "american" && <span className="text-sm text-ink-3"> {s.remark}</span>}
                      </span>
                    )}
                  </td>
                  {pointsShown && (
                    <td className="hidden px-3 py-3 text-right align-top text-ink-2 tabular-nums sm:table-cell">
                      {points !== undefined && points !== null ? formatGpa(points) : "—"}
                    </td>
                  )}
                  {positionsShown && (
                    <td className="hidden px-3 py-3 pr-5 text-right align-top text-ink-2 tabular-nums sm:table-cell">
                      {s.position !== null ? ordinal(s.position) : "—"}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        {(
          [
            [info.labels.attitude, card.remarks.attitude],
            [info.labels.conduct, card.remarks.conduct],
            [info.labels.interest, card.remarks.interest],
          ] as const
        ).map(([term, detail]) => (
          <div key={term}>
            <dt className="text-sm text-ink-3">{term}</dt>
            <dd className={cn("text-base", detail ? "text-ink" : "text-ink-3")}>{detail ?? "—"}</dd>
          </div>
        ))}
      </dl>

      <div className="divide-y divide-line border-y border-line">
        <Remark
          label={info.labels.classTeacher}
          text={card.remarks.classTeacher}
          signature={card.classTeacherName}
        />
        <Remark
          label={info.labels.headTeacher}
          text={card.remarks.headTeacher}
          signature={
            card.approvedBy && card.approvedOn
              ? `Approved by ${card.approvedBy}, ${formatCalendarDate(card.approvedOn)}`
              : null
          }
        />
      </div>

      <p className="text-sm text-ink-3">
        <span className="font-medium text-ink-2">Grades: </span>
        {bandRanges(card.bands)
          .map(
            (b) =>
              `${b.grade} ${b.range}${pointsShown && b.points != null ? ` (${formatGpa(b.points)})` : ""}${b.remark ? ` ${b.remark}` : ""}`,
          )
          .join(" · ")}
      </p>
    </div>
  );
}

function Remark({
  label,
  text,
  signature,
}: {
  label: string;
  text: string | null;
  signature: string | null;
}) {
  return (
    <div className="py-3">
      <p className="text-sm text-ink-3">{label}</p>
      <p className={cn("mt-0.5 text-base whitespace-pre-line", text ? "text-ink" : "text-ink-3")}>
        {text ?? "—"}
      </p>
      {signature && <p className="mt-1 text-sm text-ink-3">{signature}</p>}
    </div>
  );
}
