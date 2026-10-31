"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

export function PrintButton() {
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      <Printer aria-hidden="true" />
      Print
    </Button>
  );
}

export function VoidReceiptDialog({
  action,
  receiptNumber,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  receiptNumber: string;
}) {
  return (
    <FormDialog
      trigger="Void receipt"
      triggerVariant="ghost"
      title={`Void receipt ${receiptNumber}?`}
      description="The payment is removed from the student's account. The receipt keeps its number and is marked void, so it can still be accounted for."
      submitLabel="Void receipt"
      danger
      action={action}
    >
      {(state) => (
        <Field
          label="Reason"
          description="Shown on the receipt and in the audit log."
          error={state.fieldErrors?.reason}
        >
          {(p) => <Input {...p} name="reason" defaultValue={state.values?.reason} required maxLength={120} />}
        </Field>
      )}
    </FormDialog>
  );
}
