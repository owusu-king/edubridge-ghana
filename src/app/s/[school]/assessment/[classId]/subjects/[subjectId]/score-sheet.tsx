"use client";

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFormAction } from "@/components/ui/use-form-action";
import { useSyncQueue, type SyncAction } from "@/components/sync/use-sync-queue";
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

interface Cell {
  studentId: string;
  key: string;
  original: string;
  value: string;
}

interface ConflictCell {
  studentId: string;
  key: string;
  yours: string;
  theirs: string;
}

/** Where offline marks go: the sheet's term, class and subject, and whose device it is. */
export interface SheetSync {
  school: string;
  userId: string;
  termId: string;
  classId: string;
  subjectId: string;
  label: string;
  action: SyncAction;
}

function changedCells(formData: FormData): Cell[] {
  const cells: Cell[] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("s:") || typeof value !== "string") continue;
    const [, studentId, key] = name.split(":");
    if (!studentId || !key) continue;
    const original = String(formData.get(`o:${studentId}:${key}`) ?? "");
    if (value.trim() !== original.trim()) cells.push({ studentId, key, original, value });
  }
  return cells;
}

/**
 * The marks grid. The form state lives here, outside the keyed grid, so the save message survives the grid
 * being rebuilt from the saved marks. Without a connection, marks are kept on the device and sent through
 * the sync protocol when it returns; marks someone else changed meanwhile come back for the person to decide.
 */
export function ScoreSheet({
  action,
  version,
  sync,
  ...sheet
}: SheetProps & {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  version: string;
  sync: SheetSync;
}) {
  const router = useRouter();
  const scope = `scores:${sync.termId}:${sync.classId}:${sync.subjectId}`;
  const queue = useSyncQueue({ school: sync.school, userId: sync.userId, scope, action: sync.action });

  useEffect(() => {
    if (queue.lastApplied.length) router.refresh();
  }, [queue.lastApplied, router]);

  async function keepOnDevice(formData: FormData): Promise<FormState> {
    const cells = changedCells(formData);
    if (cells.length === 0) return { status: "success", message: "No changes to save." };
    // One waiting change per sheet: later edits update it, keeping what the sheet first showed.
    const waiting = queue.pending[0];
    const merged = new Map<string, Cell>();
    for (const c of (waiting?.payload as { cells?: Cell[] } | undefined)?.cells ?? [])
      merged.set(`${c.studentId}:${c.key}`, c);
    for (const c of cells) {
      const earlier = merged.get(`${c.studentId}:${c.key}`);
      merged.set(`${c.studentId}:${c.key}`, { ...c, original: earlier ? earlier.original : c.original });
    }
    if (waiting) await queue.remove(waiting.id);
    await queue.add({
      kind: "assessment.scores",
      label: sync.label,
      payload: {
        termId: sync.termId,
        classId: sync.classId,
        subjectId: sync.subjectId,
        cells: [...merged.values()],
      },
    });
    return {
      status: "success",
      message: `You are offline. ${cells.length} ${cells.length === 1 ? "mark is" : "marks are"} kept on this device and will be sent when you are back online.`,
    };
  }

  async function save(prev: FormState, formData: FormData): Promise<FormState> {
    if (!navigator.onLine) return keepOnDevice(formData);
    try {
      return await action(prev, formData);
    } catch (error) {
      if (error instanceof TypeError || !navigator.onLine) return keepOnDevice(formData);
      throw error;
    }
  }

  const { state, pending, onSubmit } = useFormAction(save);
  const editable = sheet.students.some((s) => !s.locked);
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4" aria-label={`${sheet.subjectName} scores`}>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "error" ? "critical" : "positive"}>{state.message}</Alert>
      )}
      <WaitingMarks queue={queue} students={sheet.students} components={sheet.components} sync={sync} />
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

/** Marks kept on this device, and marks that came back because someone else changed them meanwhile. */
function WaitingMarks({
  queue,
  students,
  components,
  sync,
}: {
  queue: ReturnType<typeof useSyncQueue>;
  students: SheetStudent[];
  components: AssessmentComponent[];
  sync: SheetSync;
}) {
  const nameOf = (id: string) => students.find((s) => s.id === id)?.name ?? "A student";
  const partOf = (key: string) => components.find((c) => c.key === key)?.name ?? key;
  const waiting = queue.pending.reduce(
    (n, op) => n + ((op.payload as { cells?: unknown[] }).cells?.length ?? 0),
    0,
  );
  if (!waiting && !queue.conflicts.length && !queue.rejected.length && !queue.error) return null;

  /** The person keeps their own marks: sent again from what is saved now, so nothing else is overwritten. */
  async function keepMine(opId: string, cells: ConflictCell[]) {
    await queue.add({
      kind: "assessment.scores",
      label: sync.label,
      payload: {
        termId: sync.termId,
        classId: sync.classId,
        subjectId: sync.subjectId,
        cells: cells.map((c) => ({ studentId: c.studentId, key: c.key, original: c.theirs, value: c.yours })),
      },
    });
    await queue.remove(opId);
  }

  return (
    <div className="space-y-3" aria-live="polite">
      {waiting > 0 && (
        <Alert tone="info">
          {waiting} {waiting === 1 ? "mark is" : "marks are"} kept on this device, waiting for a connection.
          {queue.sending ? " Sending…" : ""}
        </Alert>
      )}
      {queue.error && <Alert tone="critical">{queue.error}</Alert>}
      {queue.conflicts.map((op) => {
        const result = op.outcome?.status === "conflict" ? op.outcome.result : {};
        const cells = (result.conflictCells as ConflictCell[] | undefined) ?? [];
        const locked = Number(result.locked ?? 0);
        return (
          <section
            key={op.id}
            aria-label="Marks to decide"
            className="space-y-2 rounded-lg border border-line-strong bg-subtle px-4 py-3"
          >
            <p className="text-sm font-medium text-ink">
              {cells.length
                ? "Someone else changed these marks while yours were waiting on this device. Which should stay?"
                : "Some marks from this device were not saved."}
            </p>
            {cells.length > 0 && (
              <ul className="space-y-1 text-sm text-ink-2">
                {cells.map((c) => (
                  <li key={`${c.studentId}:${c.key}`}>
                    {nameOf(c.studentId)}, {partOf(c.key)}: yours <strong>{c.yours || "empty"}</strong>, saved{" "}
                    <strong>{c.theirs || "empty"}</strong>
                  </li>
                ))}
              </ul>
            )}
            {locked > 0 && (
              <p className="text-sm text-ink-2">
                {locked} {locked === 1 ? "mark was" : "marks were"} not saved because the report card was
                published.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => void queue.remove(op.id)}>
                {cells.length ? "Keep saved marks" : "Dismiss"}
              </Button>
              {cells.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void keepMine(op.id, cells)}
                >
                  Use my marks
                </Button>
              )}
            </div>
          </section>
        );
      })}
      {queue.rejected.map((op) => (
        <Alert key={op.id} tone="critical">
          {op.outcome?.status === "rejected" ? op.outcome.error.message : "These marks could not be saved."}{" "}
          <button type="button" className="font-medium underline" onClick={() => void queue.remove(op.id)}>
            Dismiss
          </button>
        </Alert>
      ))}
    </div>
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
