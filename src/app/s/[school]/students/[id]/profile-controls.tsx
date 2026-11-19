"use client";

export { UploadForm } from "@/components/ui/action-forms";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { GUARDIAN_FLAG_LABELS } from "@/lib/guardians";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const FLAGS = GUARDIAN_FLAG_LABELS;

export function GuardianFlagsDialog({
  action,
  name,
  flags,
}: {
  action: Action;
  name: string;
  flags: Record<(typeof FLAGS)[number][0], boolean>;
}) {
  return (
    <FormDialog
      trigger="Roles"
      triggerSize="sm"
      triggerVariant="ghost"
      triggerLabel={`Roles of ${name}`}
      title={`What ${name} does for this child`}
      description="Receipts and sign-in codes always go to the number on file; announcements only when ticked."
      submitLabel="Save"
      action={action}
    >
      {() => (
        <div className="space-y-3">
          {FLAGS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 text-base text-ink">
              <input
                type="checkbox"
                name={key}
                defaultChecked={flags[key]}
                className="size-4 accent-accent"
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </FormDialog>
  );
}

const MEDICAL_FIELDS = [
  ["bloodGroup", "Blood group", 10, false],
  ["allergies", "Allergies", 500, true],
  ["conditions", "Medical conditions", 500, true],
  ["medications", "Medicines", 500, true],
  ["doctorName", "Doctor or clinic", 120, false],
  ["doctorPhone", "Doctor's phone", 30, false],
  ["emergencyNotes", "In an emergency", 500, true],
] as const;

export function MedicalForm({ action, values }: { action: Action; values: Record<string, string | null> }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      {MEDICAL_FIELDS.map(([name, label, max, long]) => (
        <Field key={name} label={label} error={state.fieldErrors?.[name]}>
          {(p) =>
            long ? (
              <Textarea
                {...p}
                name={name}
                rows={2}
                maxLength={max}
                defaultValue={state.values?.[name] ?? values[name] ?? ""}
              />
            ) : (
              <Input
                {...p}
                name={name}
                maxLength={max}
                defaultValue={state.values?.[name] ?? values[name] ?? ""}
              />
            )
          }
        </Field>
      ))}
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}
