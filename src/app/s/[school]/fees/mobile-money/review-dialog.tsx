"use client";

import { Field, Input } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Closes a payment held for review, with what the reviewer found and did. */
export function ReviewDialog({ action, summary }: { action: Action; summary: string }) {
  return (
    <FormDialog
      trigger="Mark reviewed"
      triggerSize="sm"
      triggerLabel={`Mark ${summary} as reviewed`}
      title="Mark as reviewed"
      description={`${summary}. Check the school's Mobile Money statement first. If money arrived, record it with Record payment on the student's page, then note the receipt here.`}
      submitLabel="Mark reviewed"
      action={action}
    >
      {(state) => (
        <Field label="What you found" error={state.fieldErrors?.note}>
          {(p) => (
            <Input
              {...p}
              name="note"
              defaultValue={state.values?.note}
              placeholder="e.g. GH₵399 arrived; recorded as R000123"
              required
              maxLength={200}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}
