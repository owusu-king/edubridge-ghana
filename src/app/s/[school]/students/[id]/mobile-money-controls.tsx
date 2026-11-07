"use client";

import { useState } from "react";
import { Smartphone } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { useFormAction } from "@/components/ui/use-form-action";
import { MOBILE_MONEY_NETWORKS, NETWORK_LABELS, suggestNetwork } from "@/lib/mobile-money";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface PayerPhone {
  name: string;
  /** Formatted for display and input, e.g. +233 24 123 4567. */
  phone: string;
}

export function MobileMoneyDialog({
  action,
  studentName,
  defaultAmount,
  phones,
  testMode,
  testHint,
}: {
  action: Action;
  studentName: string;
  defaultAmount: string;
  /** Guardians' phone numbers, primary contact first. */
  phones: PayerPhone[];
  testMode: boolean;
  testHint?: string | null;
}) {
  return (
    <FormDialog
      trigger={
        <>
          <Smartphone aria-hidden="true" />
          Request Mobile Money
        </>
      }
      triggerSize="sm"
      title="Request Mobile Money"
      description={`The payer approves the payment for ${studentName} on their phone with their PIN. The receipt is issued once the network confirms it.`}
      submitLabel="Send prompt"
      action={action}
    >
      {(state) => (
        <MobileMoneyFields
          state={state}
          defaultAmount={defaultAmount}
          phones={phones}
          testMode={testMode}
          testHint={testHint}
        />
      )}
    </FormDialog>
  );
}

function MobileMoneyFields({
  state,
  defaultAmount,
  phones,
  testMode,
  testHint,
}: {
  state: FormState;
  defaultAmount: string;
  phones: PayerPhone[];
  testMode: boolean;
  testHint?: string | null;
}) {
  // A new key after each failed attempt: the failed request keeps the old one, and a corrected
  // submission is a new request. Within one attempt, submitting twice still sends one prompt.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [keyState, setKeyState] = useState(state);
  if (keyState !== state) {
    setKeyState(state);
    if (state.status === "error") setKey(crypto.randomUUID());
  }
  const initialPhone = state.values?.phone ?? phones[0]?.phone ?? "";
  const [network, setNetwork] = useState(state.values?.network ?? suggestNetwork(initialPhone) ?? "mtn");
  const [networkChosen, setNetworkChosen] = useState(Boolean(state.values?.network));
  return (
    <>
      {testMode && <Alert>{testHint ?? "Test mode: no money moves."}</Alert>}
      <input type="hidden" name="idempotencyKey" value={key} />
      <Field label="Amount (GH₵)" error={state.fieldErrors?.amount}>
        {(p) => (
          <Input
            {...p}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values?.amount ?? defaultAmount}
            required
            className="tabular-nums"
          />
        )}
      </Field>
      <Field
        label="Payer's Mobile Money number"
        description={phones.length > 0 ? "A guardian's number, or type another." : undefined}
        error={state.fieldErrors?.phone}
      >
        {(p) => (
          <>
            <Input
              {...p}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              list="payer-phones"
              defaultValue={initialPhone}
              required
              onChange={(e) => {
                const suggested = suggestNetwork(e.target.value);
                if (!networkChosen && suggested) setNetwork(suggested);
              }}
            />
            <datalist id="payer-phones">
              {phones.map((g) => (
                <option key={g.phone} value={g.phone}>
                  {g.name}
                </option>
              ))}
            </datalist>
          </>
        )}
      </Field>
      <Field
        label="Network"
        description="Suggested from the number. Change it if the number moved networks."
        error={state.fieldErrors?.network}
      >
        {(p) => (
          <Select
            {...p}
            name="network"
            value={network}
            onChange={(e) => {
              setNetwork(e.target.value);
              setNetworkChosen(true);
            }}
          >
            {MOBILE_MONEY_NETWORKS.map((n) => (
              <option key={n} value={n}>
                {NETWORK_LABELS[n]}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

/** Asks the network for a prompt's outcome. A confirmed payment opens its receipt. */
export function CheckStatusButton({ action, label }: { action: Action; label: string }) {
  const { state, pending, onSubmit } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="secondary" size="sm" pending={pending} aria-label={label}>
        Check status
      </Button>
      <p aria-live="polite" className="text-right text-sm text-ink-2 empty:hidden">
        {!pending && state.status !== "idle" ? state.message : ""}
      </p>
    </form>
  );
}
