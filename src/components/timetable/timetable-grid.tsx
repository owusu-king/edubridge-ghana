import type { ReactNode } from "react";
import { SCHOOL_WEEKDAYS, WEEKDAY_NAMES } from "@/lib/timetable";

export interface GridPeriod {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  kind: "lesson" | "break";
}

/**
 * A week's timetable: periods down the side, Monday to Friday across. On phones it becomes one list per day,
 * since five columns do not fit. `cell` renders a lesson slot (empty slots render whatever it returns for
 * them); breaks span the week. Used for class and teacher timetables, on the server and in the editor.
 */
export function TimetableGrid({
  periods,
  cell,
  caption,
}: {
  periods: GridPeriod[];
  cell: (weekday: number, period: GridPeriod) => ReactNode;
  caption: string;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface shadow-raised sm:block">
        <table className="w-full table-fixed border-collapse text-left text-base">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-line bg-canvas/60">
            <tr>
              <th
                scope="col"
                className="h-9 w-36 px-4 text-xs font-medium tracking-wide text-ink-3 uppercase"
              >
                Period
              </th>
              {SCHOOL_WEEKDAYS.map((d) => (
                <th
                  key={d}
                  scope="col"
                  className="h-9 px-3 text-xs font-medium tracking-wide text-ink-3 uppercase"
                >
                  {WEEKDAY_NAMES[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {periods.map((p) => (
              <tr key={p.id} className={p.kind === "break" ? "bg-canvas/50" : undefined}>
                <th scope="row" className="px-4 py-2.5 align-top font-normal">
                  <span className="block font-medium text-ink">{p.name}</span>
                  <span className="text-sm text-ink-3 tabular-nums">
                    {p.startsAt}–{p.endsAt}
                  </span>
                </th>
                {p.kind === "break" ? (
                  <td colSpan={SCHOOL_WEEKDAYS.length} className="px-3 py-2.5 text-sm text-ink-3">
                    Break
                  </td>
                ) : (
                  SCHOOL_WEEKDAYS.map((d) => (
                    <td key={d} className="px-2 py-1.5 align-top">
                      {cell(d, p)}
                    </td>
                  ))
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="space-y-5 sm:hidden">
        {SCHOOL_WEEKDAYS.map((d) => (
          <section key={d} aria-label={WEEKDAY_NAMES[d]} className="space-y-2">
            <h3 className="text-base font-semibold text-ink">{WEEKDAY_NAMES[d]}</h3>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {periods
                .filter((p) => p.kind === "lesson")
                .map((p) => (
                  <li key={p.id} className="flex items-start gap-3 px-3 py-2">
                    <span className="w-20 shrink-0 text-sm text-ink-3 tabular-nums">
                      {p.startsAt}
                      <span className="block">{p.name}</span>
                    </span>
                    <span className="min-w-0 flex-1">{cell(d, p)}</span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

/** A lesson's content in a cell: subject, and the class or teacher underneath. */
export function LessonText({ title, detail }: { title: string; detail: string | null }) {
  return (
    <span className="block px-1 py-1">
      <span className="block text-sm font-medium text-ink">{title}</span>
      {detail && <span className="block truncate text-sm text-ink-3">{detail}</span>}
    </span>
  );
}
