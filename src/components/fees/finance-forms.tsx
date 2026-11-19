"use client";

export { ActionButton } from "@/components/ui/action-forms";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";
import { SuccessToast } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <FormMessage state={state} />;
}

export const METHOD_OPTIONS = [
  ["cash", "Cash"],
  ["mobile_money", "Mobile Money"],
  ["bank_deposit", "Bank deposit"],
  ["bank_transfer", "Bank transfer"],
  ["cheque", "Cheque"],
] as const;

/** A single date (and optional reason) form, e.g. closing or reopening the books. */
export function DateForm({
  action,
  label,
  submitLabel,
  defaultValue,
  withReason,
  optional,
}: {
  action: Action;
  label: string;
  submitLabel: string;
  defaultValue?: string;
  withReason?: boolean;
  optional?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="max-w-md space-y-4">
      <Message state={state} />
      <Field label={label} error={e.through}>
        {(p) => (
          <Input
            {...p}
            type="date"
            name="through"
            defaultValue={state.values?.through ?? defaultValue}
            required={!optional}
          />
        )}
      </Field>
      {withReason && (
        <Field label="Reason" error={e.reason}>
          {(p) => (
            <Textarea
              {...p}
              name="reason"
              rows={2}
              maxLength={300}
              defaultValue={state.values?.reason}
              required
            />
          )}
        </Field>
      )}
      <Button type="submit" variant="secondary" pending={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function RequestRefundDialog({ action, credit }: { action: Action; credit: string }) {
  return (
    <FormDialog
      trigger="Request a refund"
      title="Request a refund"
      description={`The family has ${credit} in credit. Another finance user approves the refund before it is paid out.`}
      submitLabel="Request refund"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="Amount" error={state.fieldErrors?.amount}>
            {(p) => (
              <Input {...p} name="amount" inputMode="decimal" defaultValue={state.values?.amount} required />
            )}
          </Field>
          <Field label="Reason" error={state.fieldErrors?.reason}>
            {(p) => (
              <Textarea
                {...p}
                name="reason"
                rows={2}
                maxLength={300}
                defaultValue={state.values?.reason}
                required
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function DecideRefundDialog({
  action,
  approve,
  label,
}: {
  action: Action;
  approve: boolean;
  label: string;
}) {
  return (
    <FormDialog
      trigger={approve ? "Approve" : "Reject"}
      triggerSize="sm"
      triggerLabel={label}
      title={approve ? "Approve this refund?" : "Reject this refund?"}
      submitLabel={approve ? "Approve" : "Reject"}
      danger={!approve}
      action={action}
    >
      {(state) => (
        <Field label="Note" optional error={state.fieldErrors?.note}>
          {(p) => <Textarea {...p} name="note" rows={2} maxLength={300} defaultValue={state.values?.note} />}
        </Field>
      )}
    </FormDialog>
  );
}

export function PayRefundDialog({ action, today, label }: { action: Action; today: string; label: string }) {
  return (
    <FormDialog
      trigger="Record payout"
      triggerSize="sm"
      triggerVariant="primary"
      triggerLabel={label}
      title="Record the refund paid out"
      description="This posts the refund on the student's account and gives it the next refund number."
      submitLabel="Record payout"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="Paid by" error={state.fieldErrors?.method}>
            {(p) => (
              <Select {...p} name="method" defaultValue={state.values?.method ?? "cash"}>
                {METHOD_OPTIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference (transfer or cheque number)" error={state.fieldErrors?.reference}>
            {(p) => <Input {...p} name="reference" maxLength={60} defaultValue={state.values?.reference} />}
          </Field>
          <Field label="Date paid" error={state.fieldErrors?.paidOn}>
            {(p) => (
              <Input
                {...p}
                type="date"
                name="paidOn"
                max={today}
                defaultValue={state.values?.paidOn ?? today}
                required
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

/** Thresholds above which discounts need the Proprietor's approval. */
export function DiscountApprovalForm({
  action,
  percent,
  amount,
}: {
  action: Action;
  percent: string;
  amount: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Discounts above (%)" error={state.fieldErrors?.percent}>
          {(p) => (
            <Input
              {...p}
              name="percent"
              inputMode="decimal"
              defaultValue={state.values?.percent ?? percent}
              placeholder="No limit"
            />
          )}
        </Field>
        <Field label="Fixed discounts above" error={state.fieldErrors?.amount}>
          {(p) => (
            <Input
              {...p}
              name="amount"
              inputMode="decimal"
              defaultValue={state.values?.amount ?? amount}
              placeholder="No limit"
            />
          )}
        </Field>
      </div>
      <p className="text-sm text-ink-3">
        Leave a box empty for no approval. The Proprietor&apos;s own discounts never wait.
      </p>
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}

/** A fee item's category and whether it is optional. */
export function FeeItemDetailsForm({
  action,
  category,
  optional,
  categories,
  name,
}: {
  action: Action;
  category: string;
  optional: boolean;
  categories: readonly (readonly [string, string])[];
  name: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <label className="sr-only" htmlFor={`category-${name}`}>
        Category of {name}
      </label>
      <select
        id={`category-${name}`}
        name="category"
        defaultValue={category}
        className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm"
      >
        {categories.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" name="optional" defaultChecked={optional} className="size-4 accent-accent" />
        Optional
      </label>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        pending={pending}
        aria-label={`Save details of ${name}`}
      >
        Save
      </Button>
      <SuccessToast state={state} fallback="Saved." />
      {state.status === "error" && <span className="text-sm text-critical">{state.message}</span>}
    </form>
  );
}
