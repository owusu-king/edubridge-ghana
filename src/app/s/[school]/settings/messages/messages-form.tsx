"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

/** SMS the school sends on its own: payment receipts and automatic fee reminders. Each SMS is charged. */
export function MessageSettingsForm({
  action,
  defaults,
  example,
  smsPrice,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: {
    paymentReceiptSms: boolean;
    autoRemindersEnabled: boolean;
    autoReminderIntervalDays: number;
    autoReminderMin: string;
  };
  /** An example receipt SMS. */
  example: string;
  smsPrice: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const checked = (name: "paymentReceiptSms" | "autoRemindersEnabled") =>
    v ? v[name] === "on" : defaults[name];
  return (
    <form action={formAction} className="max-w-2xl space-y-8" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <p className="text-sm text-ink-3">
        Each SMS is charged to the school{smsPrice ? ` (${smsPrice} each)` : ""} and counts towards your
        plan&apos;s monthly SMS limit.
      </p>
      <fieldset className="space-y-3">
        <legend className="text-md font-semibold text-ink">Payment receipts</legend>
        <label className="flex items-start gap-3 text-base text-ink">
          <input
            type="checkbox"
            name="paymentReceiptSms"
            defaultChecked={checked("paymentReceiptSms")}
            className="mt-1 size-4 accent-accent"
          />
          <span>
            Text the family when a payment is recorded
            <span className="block text-sm text-ink-3">
              Cash, bank and Mobile Money alike, to the student&apos;s primary contact.
            </span>
          </span>
        </label>
        <figure className="rounded-lg border border-line bg-subtle px-4 py-3">
          <figcaption className="mb-1 text-sm text-ink-3">The message, for example</figcaption>
          <p className="text-base text-ink">{example}</p>
        </figure>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-md font-semibold text-ink">Automatic fee reminders</legend>
        <label className="flex items-start gap-3 text-base text-ink">
          <input
            type="checkbox"
            name="autoRemindersEnabled"
            defaultChecked={checked("autoRemindersEnabled")}
            className="mt-1 size-4 accent-accent"
          />
          <span>
            Remind families who owe, automatically
            <span className="block text-sm text-ink-3">
              Sent after 9:00 on the day they are due, up to 200 a day. A family reminded by staff is not
              reminded again until the interval has passed.
            </span>
          </span>
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Every (days)" error={errors.autoReminderIntervalDays}>
            {(p) => (
              <Input
                {...p}
                name="autoReminderIntervalDays"
                type="number"
                inputMode="numeric"
                min={7}
                max={90}
                defaultValue={v?.autoReminderIntervalDays ?? defaults.autoReminderIntervalDays}
              />
            )}
          </Field>
          <Field label="To families owing at least (GH₵)" error={errors.autoReminderMin}>
            {(p) => (
              <Input
                {...p}
                name="autoReminderMin"
                inputMode="decimal"
                defaultValue={v?.autoReminderMin ?? defaults.autoReminderMin}
              />
            )}
          </Field>
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
