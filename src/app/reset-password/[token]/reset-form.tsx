"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

export function ResetForm({
  action,
  minLength,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  minLength: number;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, { status: "idle" });
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors && <Alert tone="critical">{state.message}</Alert>}
      <Field
        label="New password"
        description={`At least ${minLength} characters.`}
        error={state.fieldErrors?.password}
      >
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            required
            minLength={minLength}
            autoComplete="new-password"
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="w-full">
        Set new password
      </Button>
    </form>
  );
}
