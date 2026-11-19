"use client";

import { useActionState } from "react";
import { MobileMoneyFields } from "@/components/fees/mobile-money-fields";
import { Alert } from "@/components/ui/alert";
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
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}
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
