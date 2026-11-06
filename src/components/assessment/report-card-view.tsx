import { bandRanges, ordinal, weightedScore, type ReportCardSnapshot } from "@/lib/assessment";
import { formatCalendarDate } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * A report card on screen, from the same snapshot the PDF prints. On phones the subject table keeps only
 * total and grade; the parts and positions appear from the small breakpoint up.
 */
export function ReportCardView({ card }: { card: ReportCardSnapshot }) {
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
    ["Average", card.overall.average !== null ? card.overall.average.toFixed(1) : "Not graded"],
  ];
  if (card.showPositions)
    facts.push([
      "Position in class",
      card.overall.position !== null ? `${ordinal(card.overall.position)} of ${card.classSize}` : "—",
    ]);

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
            Results, {card.term.name} {card.term.yearName}
          </caption>
          <thead className="border-b border-line bg-canvas/60">
            <tr>
              <th
                scope="col"
                className="h-9 px-4 pl-5 text-xs font-medium tracking-wide text-ink-3 uppercase"
              >
                Subject
              </th>
              {card.components.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="hidden h-9 px-3 text-right text-xs font-medium tracking-wide whitespace-nowrap text-ink-3 uppercase sm:table-cell"
                >
                  {c.name} {c.weight}%
                </th>
              ))}
              <th
                scope="col"
                className="h-9 px-3 text-right text-xs font-medium tracking-wide text-ink-3 uppercase"
              >
                Total
              </th>
              <th scope="col" className="h-9 px-3 text-xs font-medium tracking-wide text-ink-3 uppercase">
                Grade
              </th>
              {card.showPositions && (
                <th
                  scope="col"
                  className="hidden h-9 px-3 pr-5 text-right text-xs font-medium tracking-wide text-ink-3 uppercase sm:table-cell"
                >
                  Position
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {card.subjects.map((s) => (
              <tr key={s.name}>
                <th scope="row" className="px-4 py-3 pl-5 text-left font-normal text-ink">
                  {s.name}
                </th>
                {card.components.map((c, i) => (
                  <td
                    key={c.key}
                    className="hidden px-3 py-3 text-right text-ink-2 tabular-nums sm:table-cell"
                  >
                    {s.scores[i] !== null && s.scores[i] !== undefined ? weightedScore(s.scores[i]!, c) : "—"}
                  </td>
                ))}
                <td className="px-3 py-3 text-right font-medium text-ink tabular-nums">{s.total ?? "—"}</td>
                <td className="px-3 py-3">
                  {s.total === null ? (
                    <span className="text-sm text-ink-3">Not graded</span>
                  ) : (
                    <span>
                      <span className="font-medium text-ink">{s.grade}</span>
                      <span className="text-sm text-ink-3"> {s.remark}</span>
                    </span>
                  )}
                </td>
                {card.showPositions && (
                  <td className="hidden px-3 py-3 pr-5 text-right text-ink-2 tabular-nums sm:table-cell">
                    {s.position !== null ? ordinal(s.position) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
        {(
          [
            ["Attitude", card.remarks.attitude],
            ["Conduct", card.remarks.conduct],
            ["Interest", card.remarks.interest],
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
          label="Class teacher's remark"
          text={card.remarks.classTeacher}
          signature={card.classTeacherName}
        />
        <Remark
          label="Head teacher's remark"
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
          .map((b) => `${b.grade} ${b.range}${b.remark ? ` ${b.remark}` : ""}`)
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
