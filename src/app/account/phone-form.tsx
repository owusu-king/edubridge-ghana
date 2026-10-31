"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { formatPhone, maskPhone } from "@/lib/phone";
import type { FormState } from "@/web/forms";
import { confirmPhoneAction, removePhoneAction, startPhoneAction } from "./actions";

type Started = { verificationId: string; phone: string };

export function PhoneSection({ phone }: { phone: string | null }) {
  const [start, startAction, starting] = useActionState<FormState<Started>, FormData>(startPhoneAction, {
    status: "idle",
  });
  const [remove, removeAction, removing] = useActionState<FormState, FormData>(removePhoneAction, {
    status: "idle",
  });

  if (start.status === "success" && start.data) {
    return <ConfirmCode started={start.data} />;
  }
  return (
    <div className="space-y-5">
      {remove.status === "success" && <Alert tone="positive">{remove.message}</Alert>}
      {phone && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
          <span className="text-base text-ink">
            {formatPhone(phone)} <span className="ml-2 text-sm text-positive">Verified</span>
          </span>
          <form action={removeAction}>
            <Button type="submit" variant="ghost" size="sm" pending={removing}>
              Remove
            </Button>
          </form>
        </div>
      )}
      <form
        action={startAction}
        className="flex max-w-md flex-col gap-3 sm:flex-row sm:items-start"
        noValidate
      >
        {start.status === "error" && !start.fieldErrors && <Alert tone="critical">{start.message}</Alert>}
        <Field
          label={phone ? "New phone number" : "Phone number"}
          error={start.fieldErrors?.phone}
          className="flex-1"
        >
          {(p) => (
            <Input
              {...p}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="024 123 4567"
              defaultValue={start.values?.phone}
              required
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" pending={starting} className="sm:mt-6">
          Send code
        </Button>
      </form>
    </div>
  );
}

function ConfirmCode({ started }: { started: Started }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    confirmPhoneAction.bind(null, started.verificationId),
    {
      status: "idle",
    },
  );
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  return (
    <form action={action} className="max-w-md space-y-4" noValidate>
      <p className="text-base text-ink-2">
        We sent a 6-digit code to {maskPhone(started.phone)}. It expires in 10 minutes.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field label="Code" error={state.fieldErrors?.code ?? state.fieldErrors?.phone} className="flex-1">
          {(p) => (
            <Input
              {...p}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              autoFocus
              className="font-mono tracking-widest"
            />
          )}
        </Field>
        <Button type="submit" pending={pending} className="sm:mt-6">
          Verify
        </Button>
      </div>
    </form>
  );
}
