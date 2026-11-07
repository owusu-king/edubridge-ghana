"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { absenceAlertSms } from "@/lib/fee-messages";
import type { FormState } from "@/web/forms";

/** When families get an SMS about absences. Off by default: each SMS costs the school. */
export function AbsenceAlertsForm({
  action,
  defaults,
  schoolName,
  smsPrice,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: { enabled: boolean; consecutiveDays: number | null; termDays: number | null };
  schoolName: string;
  /** "GH₵0.05", or null when no price is set yet. */
  smsPrice: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const [enabled, setEnabled] = useState(v ? v.enabled === "on" : defaults.enabled);
  const [run, setRun] = useState(v?.consecutiveDays ?? String(defaults.consecutiveDays ?? ""));
  const example = Number(run) > 0 ? Number(run) : 3;

  return (
    <form action={formAction} className="max-w-2xl space-y-6" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="enabled"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          Send families an SMS about absences
          <span className="block text-sm text-ink-3">
            Sent to the student&apos;s primary contact when a register is saved. Each SMS is charged to the
            school{smsPrice ? ` (${smsPrice} each)` : ""}. Excused absences do not count.
          </span>
        </span>
      </label>
      <fieldset disabled={!enabled} className="grid gap-5 disabled:opacity-60 sm:grid-cols-2">
        <Field
          label="After this many school days absent in a row"
          description="Once per run of absences. Empty to not use."
          error={errors.consecutiveDays}
        >
          {(p) => (
            <Input
              {...p}
              name="consecutiveDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={run}
              onChange={(e) => setRun(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="After this many school days absent in a term"
          description="Once per term. Empty to not use."
          error={errors.termDays}
        >
          {(p) => (
            <Input
              {...p}
              name="termDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              defaultValue={v?.termDays ?? defaults.termDays ?? ""}
            />
          )}
        </Field>
      </fieldset>
      <figure className="rounded-lg border border-line bg-subtle px-4 py-3">
        <figcaption className="mb-1 text-sm text-ink-3">The message, for example</figcaption>
        <p className="text-base text-ink">
          {absenceAlertSms({ schoolName, studentFirstName: "Ama", days: example, kind: "consecutive" })}
        </p>
      </figure>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
