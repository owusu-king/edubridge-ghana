"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Field, Input, Select } from "@/components/ui/field";
import { suggestNetwork } from "@/lib/mobile-money";
import type { FormState } from "@/web/forms";
import { currencySymbol } from "@/lib/money";

export interface PayerPhone {
  name: string;
  /** Formatted for display and input, e.g. +233 24 123 4567. */
  phone: string;
}

/** Amount, payer number and network for a Mobile Money prompt; used by staff and by parents. */
export function MobileMoneyFields({
  currency,
  state,
  defaultAmount,
  phones,
  testMode,
  testHint,
  networks,
  withAmount = true,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  state: FormState;
  defaultAmount: string;
  /** False when the form asks for amounts itself (a family payment, one per child). */
  withAmount?: boolean;
  phones: PayerPhone[];
  testMode: boolean;
  testHint?: string | null;
  /** The networks of the school's country (in its profile). */
  networks: { id: string; label: string }[];
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
  // The prefix suggestion only knows Ghana's numbering; elsewhere it is ignored.
  const suggest = (phone: string) => {
    const id = suggestNetwork(phone);
    return id && networks.some((n) => n.id === id) ? id : null;
  };
  const [network, setNetwork] = useState(
    state.values?.network ?? suggest(initialPhone) ?? networks[0]?.id ?? "",
  );
  const [networkChosen, setNetworkChosen] = useState(Boolean(state.values?.network));
  return (
    <>
      {testMode && <Alert>{testHint ?? "Test mode: no money moves."}</Alert>}
      <input type="hidden" name="idempotencyKey" value={key} />
      {withAmount && (
        <Field label={`Amount (${currencySymbol(currency)})`} error={state.fieldErrors?.amount}>
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
      )}
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
                const suggested = suggest(e.target.value);
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
            {networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}
