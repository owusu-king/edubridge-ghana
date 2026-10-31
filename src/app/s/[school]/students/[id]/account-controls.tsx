"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
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

const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "mobile_money", label: "Mobile Money" },
  { value: "bank_deposit", label: "Bank deposit" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
];

export function RecordPaymentDialog({
  action,
  studentName,
  payerName,
  today,
}: {
  action: Action;
  studentName: string;
  payerName?: string;
  today: string;
}) {
  return (
    <FormDialog
      trigger="Record payment"
      triggerVariant="primary"
      triggerSize="sm"
      title="Record payment"
      description={`Money received for ${studentName}. A receipt is issued straight away.`}
      submitLabel="Record and issue receipt"
      action={action}
    >
      {(state) => <PaymentFields state={state} payerName={payerName} today={today} />}
    </FormDialog>
  );
}

function PaymentFields({ state, payerName, today }: { state: FormState; payerName?: string; today: string }) {
  // One key per opened form: submitting it twice records a single payment.
  const [key] = useState(() => crypto.randomUUID());
  const [method, setMethod] = useState(state.values?.method ?? "cash");
  return (
    <>
      <input type="hidden" name="idempotencyKey" value={key} />
      <Field label="Amount (GH₵)" error={state.fieldErrors?.amount}>
        {(p) => (
          <Input
            {...p}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values?.amount}
            required
            className="tabular-nums"
          />
        )}
      </Field>
      <Field label="Paid by" error={state.fieldErrors?.method}>
        {(p) => (
          <Select {...p} name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {method !== "cash" && (
        <Field
          label={
            method === "cheque"
              ? "Cheque number"
              : method === "mobile_money"
                ? "Transaction ID"
                : "Slip or reference number"
          }
          error={state.fieldErrors?.reference}
        >
          {(p) => (
            <Input {...p} name="reference" defaultValue={state.values?.reference} required maxLength={60} />
          )}
        </Field>
      )}
      <Field
        label="Received from"
        description="Optional. The person who brought the money."
        error={state.fieldErrors?.payerName}
      >
        {(p) => (
          <Input
            {...p}
            name="payerName"
            defaultValue={state.values?.payerName ?? payerName}
            maxLength={120}
          />
        )}
      </Field>
      <Field label="Date received" error={state.fieldErrors?.paidOn}>
        {(p) => (
          <Input
            {...p}
            name="paidOn"
            type="date"
            max={today}
            defaultValue={state.values?.paidOn ?? today}
            required
          />
        )}
      </Field>
    </>
  );
}

export function AdjustmentDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Add charge or credit"
      triggerVariant="ghost"
      triggerSize="sm"
      title="Add a charge or credit"
      description="For one-off amounts outside the fee structure, such as a lost book or a refund owed."
      submitLabel="Add to account"
      action={action}
    >
      {(state) => (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-ink">Type</legend>
            {[
              { value: "charge", label: "Charge: the family owes more" },
              { value: "credit", label: "Credit: the family owes less" },
            ].map((o) => (
              <label key={o.value} className="flex items-center gap-2.5 text-base text-ink">
                <input
                  type="radio"
                  name="direction"
                  value={o.value}
                  defaultChecked={(state.values?.direction ?? "charge") === o.value}
                  className="size-4 accent-ink"
                />
                {o.label}
              </label>
            ))}
          </fieldset>
          <Field label="Amount (GH₵)" error={state.fieldErrors?.amount}>
            {(p) => (
              <Input
                {...p}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={state.values?.amount}
                required
              />
            )}
          </Field>
          <Field
            label="What it is for"
            description="Shown on the statement."
            error={state.fieldErrors?.description}
          >
            {(p) => (
              <Input
                {...p}
                name="description"
                defaultValue={state.values?.description}
                required
                maxLength={120}
              />
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

export function OpeningBalanceDialog({ action, asOf }: { action: Action; asOf: string }) {
  return (
    <FormDialog
      trigger="Set opening balance"
      triggerVariant="ghost"
      triggerSize="sm"
      title="Opening balance"
      description="What this family owed (or had paid in advance) in your records before using EduBridge."
      submitLabel="Record opening balance"
      action={action}
    >
      {(state) => (
        <>
          <Field
            label="Balance (GH₵)"
            description="For example 450.50 owed, or -120 for a credit."
            error={state.fieldErrors?.amount}
          >
            {(p) => (
              <Input
                {...p}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={state.values?.amount}
                required
              />
            )}
          </Field>
          <Field
            label="As of"
            description="Usually the day before this term began."
            error={state.fieldErrors?.asOf}
          >
            {(p) => (
              <Input {...p} name="asOf" type="date" defaultValue={state.values?.asOf ?? asOf} required />
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}
