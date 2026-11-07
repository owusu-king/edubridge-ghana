"use client";

import { Field, Input } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function AddHolidayDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Add holiday"
      title="Add a school holiday"
      description="A day or days the school is closed during a term, such as a public holiday or mid-term break. No register is taken on them."
      submitLabel="Add holiday"
      action={action}
    >
      {(state) => {
        const errors = state.fieldErrors ?? {};
        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name} className="sm:col-span-2">
              {(p) => <Input {...p} name="name" maxLength={80} defaultValue={state.values?.name} required />}
            </Field>
            <Field label="First day" error={errors.startsOn}>
              {(p) => (
                <Input {...p} name="startsOn" type="date" defaultValue={state.values?.startsOn} required />
              )}
            </Field>
            <Field label="Last day" description="Leave empty for one day." error={errors.endsOn}>
              {(p) => <Input {...p} name="endsOn" type="date" defaultValue={state.values?.endsOn} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

export interface Suggestion {
  name: string;
  date: string;
  label: string;
  weekend: boolean;
  added: boolean;
}

/** Ghana's public holidays for a year, to review and add. */
export function SuggestHolidaysDialog({
  action,
  yearName,
  suggestions,
}: {
  action: Action;
  yearName: string;
  suggestions: Suggestion[];
}) {
  return (
    <FormDialog
      trigger={`Public holidays ${yearName}`}
      triggerVariant="ghost"
      title={`Ghana's public holidays, ${yearName}`}
      description="Tick the days your school will be closed. Eid al-Fitr, Shaqq Day and Eid al-Adha are announced each year: add them yourself once the dates are known. Check against the Ministry of the Interior's list, which can move a holiday that falls on a weekend."
      submitLabel="Add ticked holidays"
      action={action}
    >
      {() => (
        <ul className="space-y-1.5">
          {suggestions.map((s) => (
            <li key={s.date}>
              <label className="flex items-center gap-2 text-base text-ink">
                <input
                  type="checkbox"
                  name="holiday"
                  value={`${s.date}|${s.name}`}
                  defaultChecked={!s.weekend && !s.added}
                  disabled={s.added}
                  className="size-4 accent-accent"
                />
                <span className={s.added ? "text-ink-3" : undefined}>
                  {s.name} <span className="text-ink-3">· {s.label}</span>
                  {s.weekend && <span className="text-ink-3"> (a weekend)</span>}
                  {s.added && <span className="text-ink-3"> (already added)</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </FormDialog>
  );
}

export function RemoveHolidayButton({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Remove"
      triggerSize="sm"
      triggerVariant="ghost"
      triggerLabel={`Remove ${name}`}
      title={`Remove ${name}?`}
      description="Registers can then be taken on these days."
      submitLabel="Remove holiday"
      danger
      action={action}
    />
  );
}
