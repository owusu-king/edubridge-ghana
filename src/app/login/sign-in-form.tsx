"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { signInAction, type SignInFormState } from "./actions";

export function SignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<SignInFormState, FormData>(signInAction, {});
  return (
    <form action={action} className="space-y-5">
      {state.error && <Alert tone="critical">{state.error}</Alert>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email or phone number">
        {(props) => (
          <Input
            {...props}
            name="identifier"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            defaultValue={state.email}
            required
            autoFocus
          />
        )}
      </Field>
      <Field label="Password">
        {(props) => (
          <Input {...props} name="password" type="password" autoComplete="current-password" required />
        )}
      </Field>
      <Button type="submit" pending={pending} className="w-full">
        Sign in
      </Button>
    </form>
  );
}
