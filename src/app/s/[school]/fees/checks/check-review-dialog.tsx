"use client";

import { Field, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Reviews a finance check flag, once, with what the reviewer found (FCT-02b). */
export function CheckReviewDialog({ action, summary }: { action: Action; summary: string }) {
  return (
    <FormDialog
      trigger="Review"
      triggerSize="sm"
      triggerLabel={`Review: ${summary}`}
      title="Review this flag"
      description={`${summary} Open the records first. The note is kept with the flag and cannot be changed.`}
      submitLabel="Mark reviewed"
      action={action}
    >
      {(state) => (
        <Field label="What you found" error={state.fieldErrors?.note}>
          {(p) => (
            <Textarea
              {...p}
              name="note"
              rows={3}
              defaultValue={state.values?.note}
              placeholder="e.g. Two payments from the same slip, confirmed with the bank; the second was voided."
              required
              minLength={3}
              maxLength={500}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}
