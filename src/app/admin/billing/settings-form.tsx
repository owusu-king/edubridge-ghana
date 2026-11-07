"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

/** The platform's SMS price and grace period. A school's own SMS price, set on its page, wins. */
export function PlatformSettingsForm({
  action,
  defaults,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: { smsPrice: string; graceDays: number };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <div className="grid gap-5 sm:grid-cols-[14rem_14rem_auto] sm:items-end">
        <Field
          label="SMS price (GH₵ per message)"
          description="Used where a school has no price of its own."
          error={errors.smsPrice}
        >
          {(p) => (
            <Input
              {...p}
              name="smsPrice"
              inputMode="decimal"
              defaultValue={v?.smsPrice ?? defaults.smsPrice}
            />
          )}
        </Field>
        <Field
          label="Grace days"
          description="After an invoice falls due, before SMS pause."
          error={errors.graceDays}
        >
          {(p) => (
            <Input
              {...p}
              name="graceDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={60}
              defaultValue={v?.graceDays ?? defaults.graceDays}
              required
            />
          )}
        </Field>
        <div className="sm:pb-6">
          <Button type="submit" variant="secondary" pending={pending}>
            Save settings
          </Button>
        </div>
      </div>
    </form>
  );
}
