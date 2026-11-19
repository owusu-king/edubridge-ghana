"use client";

import { useActionState } from "react";
import type { FormState } from "@/web/forms";

const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg px-4 text-base font-medium disabled:opacity-60";

/**
 * The family's own choice of WhatsApp instead of SMS (WAB-01). Turning it on is the consent WhatsApp needs,
 * so the text says plainly what comes, from whom, and how to stop.
 */
export function WhatsAppToggle({
  on,
  schools,
  phone,
  turnOn,
  turnOff,
}: {
  on: boolean;
  schools: string[];
  /** The number, formatted for reading. */
  phone: string;
  turnOn: (prev: FormState) => Promise<FormState>;
  turnOff: (prev: FormState) => Promise<FormState>;
}) {
  const [state, formAction, pending] = useActionState(on ? turnOff : turnOn, { status: "idle" } as FormState);
  return (
    <section
      aria-labelledby="whatsapp"
      className="space-y-2 rounded-lg border border-line bg-surface px-5 py-4"
    >
      <h2 id="whatsapp" className="text-md font-semibold text-ink">
        Messages on WhatsApp
      </h2>
      <p className="text-base text-ink-2">
        {on
          ? `School messages come to ${phone} on WhatsApp, from EduBridge's WhatsApp number, instead of SMS. If WhatsApp cannot deliver one, it comes by SMS.`
          : `Get receipts, fee notices, absence alerts, announcements, forms and reminders from ${schools.join(" and ")} on WhatsApp at ${phone}, instead of SMS.`}{" "}
        Sign-in codes always come by SMS. Reply STOP on WhatsApp at any time to stop.
      </p>
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          className={`${buttonClass} border border-line-strong bg-surface text-ink hover:bg-subtle`}
        >
          {on ? "Stop WhatsApp messages" : "Get messages on WhatsApp"}
        </button>
      </form>
      <p aria-live="polite" className="text-sm text-ink-2 empty:hidden">
        {!pending && state.status !== "idle" ? state.message : ""}
      </p>
    </section>
  );
}
