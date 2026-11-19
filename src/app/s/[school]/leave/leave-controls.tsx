"use client";

import { Field, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { LeaveFields, type Option } from "../staff/staff-controls";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function AskLeaveDialog({ action, types, today }: { action: Action; types: Option[]; today: string }) {
  return (
    <FormDialog
      trigger="Ask for leave"
      triggerVariant="primary"
      title="Ask for leave"
      description="Days are working days, Monday to Friday, less the school's holidays. A leave approver decides it."
      submitLabel="Send request"
      action={action}
    >
      {(state) => <LeaveFields state={state} types={types} today={today} />}
    </FormDialog>
  );
}

/** Approve (confirming when it goes beyond the year's allowance) or decline (with a reason). */
export function DecideLeaveDialogs({
  approve,
  decline,
  name,
  overBalance,
}: {
  approve: Action;
  decline: Action;
  name: string;
  overBalance: number | null;
}) {
  return (
    <span className="inline-flex flex-wrap justify-end gap-2">
      <FormDialog
        trigger="Approve"
        triggerSize="sm"
        triggerVariant="primary"
        triggerLabel={`Approve leave for ${name}`}
        title={`Approve leave for ${name}`}
        description={
          overBalance
            ? `This is ${overBalance} ${overBalance === 1 ? "day" : "days"} more than the year's allowance.`
            : "Approved once; it can still be cancelled later, which returns the days."
        }
        submitLabel="Approve"
        action={approve}
      >
        {(state) => (
          <div className="space-y-4">
            {overBalance ? (
              <label className="flex items-start gap-2 text-base text-ink">
                <input type="checkbox" name="confirmOverBalance" className="mt-1 size-4 accent-accent" />
                <span>Approve it beyond the allowance</span>
              </label>
            ) : null}
            {state.fieldErrors?.confirmOverBalance && (
              <p className="text-sm text-critical">{state.fieldErrors.confirmOverBalance}</p>
            )}
            <Field label="Note" optional error={state.fieldErrors?.note}>
              {(p) => <Textarea {...p} name="note" rows={2} maxLength={300} />}
            </Field>
          </div>
        )}
      </FormDialog>
      <FormDialog
        trigger="Decline"
        triggerSize="sm"
        triggerLabel={`Decline leave for ${name}`}
        title={`Decline leave for ${name}`}
        submitLabel="Decline"
        danger
        action={decline}
      >
        {(state) => (
          <Field label="Why" description="The person asking sees this." error={state.fieldErrors?.note}>
            {(p) => <Textarea {...p} name="note" rows={2} maxLength={300} required />}
          </Field>
        )}
      </FormDialog>
    </span>
  );
}
