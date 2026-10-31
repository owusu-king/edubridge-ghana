"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function NewAccountForm({
  action,
  email,
  minLength,
}: {
  action: Action;
  email: string;
  minLength: number;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}
      <Field label="Email">
        {(p) => <Input {...p} value={email} readOnly disabled autoComplete="username" />}
      </Field>
      <Field label="Full name" error={errors.name}>
        {(p) => (
          <Input
            {...p}
            name="name"
            defaultValue={state.values?.name}
            required
            maxLength={120}
            autoComplete="name"
            autoFocus
          />
        )}
      </Field>
      <Field label="Password" description={`At least ${minLength} characters.`} error={errors.password}>
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            required
            minLength={minLength}
            autoComplete="new-password"
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="w-full">
        Create account and join
      </Button>
    </form>
  );
}

export function AcceptForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  return (
    <form action={formAction} className="space-y-5">
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}
      <Button type="submit" pending={pending} className="w-full">
        Accept invitation
      </Button>
    </form>
  );
}
