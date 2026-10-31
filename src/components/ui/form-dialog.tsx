"use client";

import { useState, type ReactNode } from "react";
import { Alert } from "./alert";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { Dialog } from "./dialog";
import { useFormAction } from "./use-form-action";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * A button that opens a dialog containing a form bound to a server action. The dialog closes when the
 * action succeeds; field errors and submitted values come back in `state` for the fields to show.
 */
export function FormDialog({
  trigger,
  triggerVariant = "secondary",
  triggerSize = "md",
  triggerLabel,
  title,
  description,
  submitLabel,
  danger = false,
  action,
  children,
}: {
  trigger: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  /** Accessible name when the trigger text alone is ambiguous (e.g. "Edit" in a table row). */
  triggerLabel?: string;
  title: string;
  description?: string;
  submitLabel: string;
  danger?: boolean;
  action: Action;
  children?: (state: FormState) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant={triggerVariant}
        size={triggerSize}
        onClick={() => setOpen(true)}
        aria-label={triggerLabel}
      >
        {trigger}
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen} title={title} description={description}>
          <DialogForm action={action} submitLabel={submitLabel} danger={danger} onDone={() => setOpen(false)}>
            {children}
          </DialogForm>
        </Dialog>
      )}
    </>
  );
}

function DialogForm({
  action,
  submitLabel,
  danger,
  onDone,
  children,
}: {
  action: Action;
  submitLabel: string;
  danger: boolean;
  onDone: () => void;
  children?: (state: FormState) => ReactNode;
}) {
  const { state, pending, onSubmit } = useFormAction<undefined>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result.status === "success") onDone();
    return result;
  });
  const showGeneralError =
    state.status === "error" && state.message && !Object.keys(state.fieldErrors ?? {}).length;
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {showGeneralError && <Alert tone="critical">{state.message}</Alert>}
      {children?.(state)}
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} pending={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
