"use client";

import { Lock } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFormAction } from "@/components/ui/use-form-action";
import {
  bandFor,
  parseScore,
  subjectTotal,
  type AssessmentComponent,
  type GradeBand,
} from "@/lib/assessment";
import { cn } from "@/lib/cn";
import type { FormState } from "@/web/forms";

interface SheetStudent {
  id: string;
  name: string;
  admissionNumber: string;
  scores: Record<string, string>;
  locked: boolean;
}

interface SheetProps {
  components: AssessmentComponent[];
  bands: GradeBand[];
  students: SheetStudent[];
  subjectName: string;
}

/**
 * The marks grid. The form state lives here, outside the keyed grid, so the save message survives the grid
 * being rebuilt from the saved marks.
 */
export function ScoreSheet({
  action,
  version,
  ...sheet
}: SheetProps & { action: (prev: FormState, formData: FormData) => Promise<FormState>; version: string }) {
  const { state, pending, onSubmit } = useFormAction(action);
  const editable = sheet.students.some((s) => !s.locked);
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label={`${sheet.subjectName} scores`}>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "error" ? "critical" : "positive"}>{state.message}</Alert>
      )}
      <Grid key={version} {...sheet} />
      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" pending={pending}>
            Save scores
          </Button>
          <p className="text-sm text-ink-3">Press Enter or the arrow keys to move up and down a column.</p>
        </div>
      )}
    </form>
  );
}

const cellKey = (studentId: string, key: string) => `${studentId}:${key}`;

function Grid({ components, bands, students, subjectName }: SheetProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      students.flatMap((s) => components.map((c) => [cellKey(s.id, c.key), s.scores[c.key] ?? ""])),
    ),
  );

  function move(event: KeyboardEvent<HTMLInputElement>, row: number, col: number) {
    const step = event.key === "ArrowDown" || event.key === "Enter" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const target = document.querySelector<HTMLInputElement>(`[data-cell="${row + step}:${col}"]`);
    target?.focus();
    target?.select();
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface shadow-raised">
      <table className="w-full border-collapse text-left text-base">
        <caption className="sr-only">{subjectName} scores</caption>
        <thead className="border-b border-line bg-canvas/60">
          <tr>
            <th scope="col" className="h-9 px-4 pl-5 text-xs font-medium tracking-wide text-ink-3 uppercase">
              Student
            </th>
            {components.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="h-9 px-2 text-right text-xs font-medium tracking-wide whitespace-nowrap text-ink-3 uppercase"
              >
                {c.name}
                <span className="block font-normal normal-case">
                  out of {c.outOf}
                  {c.outOf !== c.weight ? ` (${c.weight}%)` : ""}
                </span>
              </th>
            ))}
            <th
              scope="col"
              className="h-9 px-3 text-right text-xs font-medium tracking-wide text-ink-3 uppercase"
            >
              Total
            </th>
            <th scope="col" className="h-9 px-3 pr-5 text-xs font-medium tracking-wide text-ink-3 uppercase">
              Grade
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {students.map((student, row) => {
            const tenths: Record<string, number | null> = {};
            let invalidRow = false;
            for (const c of components) {
              const parsed = parseScore(values[cellKey(student.id, c.key)] ?? "");
              const bad = parsed !== null && (Number.isNaN(parsed) || parsed > c.outOf * 10);
              invalidRow ||= bad;
              tenths[c.key] = bad ? null : parsed;
            }
            const total = invalidRow ? null : subjectTotal(components, tenths);
            const band = total === null ? null : bandFor(bands, total);
            return (
              <tr key={student.id} className={student.locked ? "bg-canvas/60" : undefined}>
                <th scope="row" className="px-4 py-2 pl-5 text-left font-normal">
                  <span className="flex items-center gap-1.5 font-medium text-ink">
                    {student.name}
                    {student.locked && (
                      <Lock
                        aria-label="Report card published: marks locked"
                        className="size-3.5 text-ink-3"
                      />
                    )}
                  </span>
                  <span className="block text-sm text-ink-3">{student.admissionNumber}</span>
                </th>
                {components.map((c, col) => {
                  const k = cellKey(student.id, c.key);
                  const value = values[k] ?? "";
                  const parsed = parseScore(value);
                  const bad = parsed !== null && (Number.isNaN(parsed) || parsed > c.outOf * 10);
                  return (
                    <td key={c.key} className="px-2 py-2 text-right">
                      <input type="hidden" name={`o:${k}`} value={student.scores[c.key] ?? ""} />
                      <input
                        name={`s:${k}`}
                        value={value}
                        onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                        onKeyDown={(e) => move(e, row, col)}
                        onFocus={(e) => e.target.select()}
                        data-cell={`${row}:${col}`}
                        inputMode="decimal"
                        autoComplete="off"
                        readOnly={student.locked}
                        aria-label={`${student.name}, ${c.name} (out of ${c.outOf})`}
                        aria-invalid={bad || undefined}
                        className={cn(
                          "h-10 w-20 rounded-md border bg-surface px-2 text-right text-base text-ink tabular-nums transition-colors",
                          "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-accent/25",
                          bad ? "border-critical bg-critical-soft" : "border-line-strong hover:border-ink-3",
                          student.locked && "border-transparent bg-transparent text-ink-2",
                        )}
                      />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-right font-medium text-ink tabular-nums">
                  {total ?? <span className="text-ink-3">—</span>}
                </td>
                <td className="px-3 py-2 pr-5 whitespace-nowrap">
                  {band ? (
                    <span>
                      <span className="font-medium text-ink">{band.grade}</span>
                      <span className="hidden text-sm text-ink-3 sm:inline"> {band.remark}</span>
                    </span>
                  ) : invalidRow ? (
                    <span className="text-sm text-critical">Check marks</span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
