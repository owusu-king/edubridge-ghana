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
