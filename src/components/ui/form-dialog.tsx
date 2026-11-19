"use client";

import { useId, useState, type ReactNode } from "react";
import { Alert } from "./alert";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { Dialog } from "./dialog";
import { toast } from "./toast";
import { useFormAction } from "./use-form-action";
import type { FormState } from "@/web/forms";

/** A server action for the dialog's form; `T` is any data it returns with its result (e.g. what to confirm). */
type Action<T> = (prev: FormState<T>, formData: FormData) => Promise<FormState<T>>;

/**
 * A button that opens a dialog containing a form bound to a server action. The dialog closes when the
 * action succeeds; field errors and submitted values come back in `state` for the fields to show.
 */
export function FormDialog<T = undefined>({
  trigger,
  triggerVariant = "secondary",
  triggerSize = "md",
  triggerLabel,
  title,
  description,
  submitLabel,
  danger = false,
  size,
  action,
  defaultOpen = false,
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
  size?: "md" | "lg";
  action: Action<T>;
  /** Open on arrival (e.g. a link that asks for this form). */
  defaultOpen?: boolean;
  children?: (state: FormState<T>) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        <DialogForm
          title={title}
          description={description}
          size={size}
          action={action}
          submitLabel={submitLabel}
          danger={danger}
          onDone={() => setOpen(false)}
        >
          {children}
        </DialogForm>
      )}
    </>
  );
}

/** The dialog and its form; the actions sit in the dialog's footer, tied to the form by its id. */
function DialogForm<T>({
  title,
  description,
  size,
  action,
  submitLabel,
  danger,
  onDone,
  children,
}: {
  title: string;
  description?: string;
  size?: "md" | "lg";
  action: Action<T>;
  submitLabel: string;
  danger: boolean;
  onDone: () => void;
  children?: (state: FormState<T>) => ReactNode;
}) {
  const { state, pending, onSubmit } = useFormAction<T>(async (prev, formData) => {
    const result = await action(prev, formData);
    // The dialog closes on success; its confirmation shows as a toast.
    if (result.status === "success") {
      if (result.message) toast(result.message);
      onDone();
    }
    return result;
  });
  const formId = useId();
  const showGeneralError =
    state.status === "error" && state.message && !Object.keys(state.fieldErrors ?? {}).length;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onDone()}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={danger ? "danger" : "primary"} pending={pending}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="space-y-5" noValidate>
        {showGeneralError && <Alert tone="critical">{state.message}</Alert>}
        {children?.(state)}
      </form>
    </Dialog>
  );
}
