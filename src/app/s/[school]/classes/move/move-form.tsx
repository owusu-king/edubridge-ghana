"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { useFormAction } from "@/components/ui/use-form-action";
import type { FormState } from "@/web/forms";

export interface MoveFormClass {
  id: string;
  name: string;
  campusName: string | null;
  destination: string;
  students: { id: string; name: string; admissionNumber: string; alreadyPlaced: boolean }[];
}

export interface DestinationOption {
  value: string;
  label: string;
}

/**
 * Where each class goes, and who stays behind. Nothing is saved until the button at the end; the counts
 * update as choices change.
 */
export function MoveForm({
  fromTermId,
  toTermId,
  toLabel,
  newYear,
  classes,
  options,
  action,
}: {
  fromTermId: string;
  toTermId: string;
  toLabel: string;
  newYear: boolean;
  classes: MoveFormClass[];
  options: DestinationOption[];
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
}) {
  const { state, pending, onSubmit } = useFormAction<undefined>(action);
  const [destinations, setDestinations] = useState<Record<string, string>>(
    Object.fromEntries(classes.map((c) => [c.id, c.destination])),
  );
  const [keptBack, setKeptBack] = useState<Set<string>>(new Set());

  const moving = (c: MoveFormClass) =>
    c.students.filter((s) => !s.alreadyPlaced && !keptBack.has(s.id)).length;
  const placed = classes.reduce(
    (n, c) => (destinations[c.id] && !["graduate", "none"].includes(destinations[c.id]!) ? n + moving(c) : n),
    0,
  );
  const graduating = classes.reduce((n, c) => (destinations[c.id] === "graduate" ? n + moving(c) : n), 0);
  const unchosen = classes.filter((c) => destinations[c.id] === "none" && moving(c) > 0);

  if (state.status === "success")
    return (
      <Alert tone="positive">
        {state.message} Fees for {toLabel} are not billed yet: bill the term from Fees when its fees are set.
      </Alert>
    );

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}
      <input type="hidden" name="fromTermId" value={fromTermId} />
      <input type="hidden" name="toTermId" value={toTermId} />
      <ul className="divide-y divide-line border-y border-line">
        {classes.map((c) => {
          const already = c.students.filter((s) => s.alreadyPlaced).length;
          return (
            <li key={c.id} className="space-y-3 py-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_18rem] sm:items-center">
                <div className="min-w-0">
                  <p className="text-base font-semibold text-ink">
                    {c.name}
                    {c.campusName && <span className="font-normal text-ink-3"> · {c.campusName}</span>}
                  </p>
                  <p className="text-sm text-ink-3">
                    {moving(c)} of {c.students.length} moving
                    {already ? ` · ${already} already in a class for ${toLabel}` : ""}
                  </p>
                </div>
                <div>
                  <label htmlFor={`dest-${c.id}`} className="sr-only">
                    Where {c.name} goes
                  </label>
                  <Select
                    id={`dest-${c.id}`}
                    name={`dest:${c.id}`}
                    value={destinations[c.id]}
                    onChange={(e) => setDestinations((d) => ({ ...d, [c.id]: e.target.value }))}
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-sm text-ink-2 hover:text-ink">
                  Keep students back
                  {keptBack.size && c.students.some((s) => keptBack.has(s.id))
                    ? ` (${c.students.filter((s) => keptBack.has(s.id)).length})`
                    : ""}
                </summary>
                <p className="mt-2 text-sm text-ink-3">
                  Students kept back are not moved{newYear ? " or graduated" : ""}: for those repeating a
                  level or leaving. Place them by hand from their page afterwards.
                </p>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {c.students.map((s) => (
                    <li key={s.id}>
                      <label className="flex items-center gap-2 text-sm text-ink">
                        <input
                          type="checkbox"
                          name="keepBack"
                          value={s.id}
                          disabled={s.alreadyPlaced}
                          checked={keptBack.has(s.id)}
                          onChange={(e) =>
                            setKeptBack((k) => {
                              const next = new Set(k);
                              if (e.target.checked) next.add(s.id);
                              else next.delete(s.id);
                              return next;
                            })
                          }
                          className="size-4 accent-accent"
                        />
                        <span className={s.alreadyPlaced ? "text-ink-3" : undefined}>
                          {s.name}
                          {s.alreadyPlaced && " (already placed)"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-base text-ink-2" aria-live="polite">
          <span className="font-semibold text-ink">{placed}</span> {placed === 1 ? "student" : "students"}{" "}
          will be placed in classes for {toLabel}
          {graduating ? (
            <>
              {" "}
              and <span className="font-semibold text-ink">{graduating}</span> will graduate
            </>
          ) : null}
          .
          {unchosen.length > 0 && (
            <span className="block text-sm text-caution">
              Not moving: {unchosen.map((c) => c.name).join(", ")} (no destination chosen).
            </span>
          )}
        </p>
        <Button type="submit" pending={pending} disabled={placed + graduating === 0}>
          Move students
        </Button>
      </div>
    </form>
  );
}
