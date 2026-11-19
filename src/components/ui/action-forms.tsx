"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { SuccessToast } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Bare = (prev: FormState) => Promise<FormState>;

/** One button that runs an action and shows its message (approve, cancel, add, remove). */
export function ActionButton({
  action,
  label,
  ariaLabel,
  variant = "secondary",
}: {
  action: Bare;
  label: string;
  ariaLabel?: string;
  variant?: "primary" | "secondary" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <Button type="submit" size="sm" variant={variant} pending={pending} aria-label={ariaLabel}>
        {label}
      </Button>
      {state.status === "error" && (
        <span className="max-w-xs text-right text-sm text-critical">{state.message}</span>
      )}
    </form>
  );
}

/** Uploading one file (a photo or a document), with the server's check message if it is refused. */
export function UploadForm({
  action,
  label,
  accept,
  submitLabel,
}: {
  action: Action;
  label: string;
  accept: string;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-1.5">
      <Field
        label={label}
        error={state.fieldErrors?.file ?? (state.status === "error" ? state.message : undefined)}
      >
        {(p) => (
          // The button sits on the file box's line, at its height; messages go below the whole row.
          <div className="flex flex-wrap items-center gap-3">
            <Input
              {...p}
              type="file"
              name="file"
              accept={accept}
              required
              className="min-w-0 grow basis-56 sm:max-w-xs"
            />
            <Button type="submit" variant="secondary" pending={pending}>
              {submitLabel}
            </Button>
          </div>
        )}
      </Field>
      <SuccessToast state={state} />
    </form>
  );
}

/** Choosing one option and saving it (a setting with a few named choices), with the server's message. */
export function ChoiceForm({
  action,
  name,
  label,
  options,
  value,
  submitLabel = "Save",
}: {
  action: Action;
  name: string;
  label: string;
  options: { value: string; label: string; description?: string }[];
  value: string;
  submitLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-2xl space-y-3">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">{label}</legend>
        {options.map((o) => (
          <label key={o.value} className="flex items-start gap-3 text-base text-ink">
            <input
              type="radio"
              name={name}
              value={o.value}
              defaultChecked={o.value === value}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              {o.label}
              {o.description && <span className="block text-sm text-ink-3">{o.description}</span>}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" pending={pending}>
          {submitLabel}
        </Button>
        <SuccessToast state={state} />
        <span aria-live="polite" className="text-sm text-critical">
          {!pending && state.status === "error" ? state.message : ""}
        </span>
      </div>
    </form>
  );
}
