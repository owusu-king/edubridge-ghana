"use client";

import { useActionState, useState } from "react";
import { MobileMoneyFields } from "@/components/fees/mobile-money-fields";
import { Alert } from "@/components/ui/alert";
import { FormError } from "@/components/ui/toast";
import { currencySymbol, moneyFormatter, parseMoney } from "@/lib/money";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg px-4 text-base font-medium disabled:opacity-60";

/** A parent pays a child's fees by Mobile Money (PAY-01): they approve it on their phone with their PIN. */
export function PayOnlineForm({
  currency,
  action,
  defaultAmount,
  phone,
  testMode,
  testHint,
  networks,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  action: Action;
  defaultAmount: string;
  /** The parent's own number, formatted. */
  phone: string;
  testMode: boolean;
  testHint: string | null;
  networks: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  return (
    <form action={formAction} className="space-y-4">
      <FormError state={state} />
      <MobileMoneyFields
        state={state}
        defaultAmount={defaultAmount}
        phones={[{ name: "Your number", phone }]}
        testMode={testMode}
        testHint={testHint}
        networks={networks}
        currency={currency}
      />
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClass} bg-accent text-white hover:bg-accent-hover`}
      >
        {pending ? "Sending…" : "Pay"}
      </button>
    </form>
  );
}

/**
 * One Mobile Money prompt for several children (2026-11-18). Each child's amount starts at what they owe; a blank or
 * 0 leaves a child out. The total is what the payer approves; each child gets their own receipt.
 */
export function FamilyPayForm({
  currency,
  action,
  childrenOwing,
  phone,
  testMode,
  testHint,
  networks,
}: {
  currency: string;
  action: Action;
  childrenOwing: { studentId: string; name: string; className: string | null; balancePesewas: number }[];
  phone: string;
  testMode: boolean;
  testHint: string | null;
  networks: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(childrenOwing.map((c) => [c.studentId, (c.balancePesewas / 100).toFixed(2)])),
  );
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  const total = Object.values(amounts).reduce((sum, text) => sum + (parseMoney(text, currency) ?? 0), 0);
  const show = moneyFormatter(currency);
  return (
    <form action={formAction} className="space-y-4">
      <FormError state={state} />
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">
          Amount for each child ({currencySymbol(currency)})
        </legend>
        {childrenOwing.map((child, i) => (
          <div key={child.studentId} className="flex items-center justify-between gap-3">
            <label htmlFor={`share-${child.studentId}`} className="min-w-0">
              <span className="block text-base text-ink">{child.name}</span>
              <span className="block text-sm text-ink-3">
                {[child.className, `owes ${show(child.balancePesewas)}`].filter(Boolean).join(" · ")}
              </span>
            </label>
            <input type="hidden" name={`shares.${i}.studentId`} value={child.studentId} />
            <input
              id={`share-${child.studentId}`}
              name={`shares.${i}.amount`}
              inputMode="decimal"
              autoComplete="off"
              value={amounts[child.studentId] ?? ""}
              onChange={(e) => setAmounts((a) => ({ ...a, [child.studentId]: e.target.value }))}
              className="h-11 w-32 shrink-0 rounded-lg border border-line-strong bg-surface px-3 text-right text-base text-ink tabular-nums"
            />
          </div>
        ))}
        {state.fieldErrors?.amount && <p className="text-sm text-critical">{state.fieldErrors.amount}</p>}
        <p className="flex justify-between border-t border-line pt-3 text-base font-medium text-ink">
          <span>Total to approve</span>
          <span className="tabular-nums">{show(total)}</span>
        </p>
      </fieldset>
      <MobileMoneyFields
        state={state}
        defaultAmount=""
        withAmount={false}
        phones={[{ name: "Your number", phone }]}
        testMode={testMode}
        testHint={testHint}
        networks={networks}
        currency={currency}
      />
      <button
        type="submit"
        disabled={pending || total <= 0}
        className={`${buttonClass} bg-accent text-white hover:bg-accent-hover`}
      >
        {pending ? "Sending…" : `Pay ${show(total)}`}
      </button>
    </form>
  );
}

/** Asks whether a payment went through. */
export function CheckPaymentButton({ action }: { action: (prev: FormState) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClass} -mr-2 h-9 px-3 text-sm text-accent hover:bg-accent-soft`}
      >
        Check
      </button>
      <p aria-live="polite" className="text-right text-sm text-ink-2 empty:hidden">
        {!pending && state.status !== "idle" ? state.message : ""}
      </p>
    </form>
  );
}

/** Announcements by SMS on or off for one school (PAR-05). */
export function AnnouncementSmsToggle({
  on,
  turnOn,
  turnOff,
}: {
  on: boolean;
  turnOn: (prev: FormState) => Promise<FormState>;
  turnOff: (prev: FormState) => Promise<FormState>;
}) {
  const [state, formAction, pending] = useActionState(on ? turnOff : turnOn, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-2">
      <p className="text-base text-ink-2">
        {on
          ? "Announcements also come to your phone by SMS."
          : "Announcements do not come by SMS. You can read them here."}{" "}
        Receipts, fee notices and absence alerts always come (by SMS, or on WhatsApp if you chose it).
      </p>
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClass} border border-line-strong bg-surface text-ink hover:bg-subtle`}
      >
        {on ? "Stop announcement SMS" : "Get announcements by SMS"}
      </button>
      <p aria-live="polite" className="text-sm text-ink-2 empty:hidden">
        {!pending && state.status !== "idle" ? state.message : ""}
      </p>
    </form>
  );
}
