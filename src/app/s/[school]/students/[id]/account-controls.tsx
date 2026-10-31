"use client";

import { Field, Input } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function ReverseEntryDialog({
  action,
  description,
  amount,
}: {
  action: Action;
  description: string;
  amount: string;
}) {
  return (
    <FormDialog
      trigger="Reverse"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Reverse ${description}`}
      title="Reverse this entry?"
      description={`${description}, ${amount}. An opposite entry is added; the original stays on the statement, marked as reversed.`}
      submitLabel="Reverse entry"
      danger
      action={action}
    >
      {(state) => (
        <Field
          label="Reason"
          description="Shown on the statement and in the audit log."
          error={state.fieldErrors?.reason}
        >
          {(p) => <Input {...p} name="reason" defaultValue={state.values?.reason} required maxLength={120} />}
        </Field>
      )}
    </FormDialog>
  );
}
