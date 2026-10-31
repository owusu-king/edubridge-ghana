"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { requestResetAction } from "./actions";

export function RequestResetForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(requestResetAction, {
    status: "idle",
  });
  if (state.status === "success") {
    return (
      <div className="space-y-6">
        <Alert tone="positive">
          If an account matches, we have sent a link to reset the password by email or SMS. It expires in 30
          minutes.
        </Alert>
        <Link href="/login" className="text-base font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label="Email or phone number" error={state.fieldErrors?.identifier}>
        {(p) => (
          <Input
            {...p}
            name="identifier"
            type="text"
            autoComplete="username"
            defaultValue={state.values?.identifier}
            required
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="w-full">
        Send reset link
      </Button>
      <p className="text-sm">
        <Link href="/login" className="text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
