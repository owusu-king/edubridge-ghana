"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { changePasswordAction, signOutOthersAction, updateProfileAction } from "./actions";

const idle = { status: "idle" } as const;

function Message({ state }: { state: FormState<unknown> }) {
  if (state.status === "idle" || !state.message) return null;
  return <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>;
}

export function ProfileForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfileAction, idle);
  return (
    <form action={action} className="space-y-5" noValidate>
      <Message state={state} />
      <Field label="Full name" error={state.fieldErrors?.name}>
        {(p) => (
          <Input
            {...p}
            name="name"
            defaultValue={state.values?.name ?? name}
            required
            maxLength={120}
            autoComplete="name"
          />
        )}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save profile
        </Button>
      </div>
    </form>
  );
}

export function PasswordForm({ minLength, email }: { minLength: number; email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(changePasswordAction, idle);
  return (
    <form action={action} className="space-y-5" noValidate>
      <Message state={state} />
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
      <Field label="Current password" error={state.fieldErrors?.currentPassword}>
        {(p) => (
          <Input {...p} name="currentPassword" type="password" required autoComplete="current-password" />
        )}
      </Field>
      <Field
        label="New password"
        description={`At least ${minLength} characters.`}
        error={state.fieldErrors?.newPassword}
      >
        {(p) => (
          <Input
            {...p}
            name="newPassword"
            type="password"
            required
            minLength={minLength}
            autoComplete="new-password"
          />
        )}
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Change password
        </Button>
      </div>
    </form>
  );
}

export function SignOutOthersForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signOutOthersAction, idle);
  return (
    <form action={action} className="space-y-4">
      <Message state={state} />
      <Button type="submit" variant="secondary" pending={pending}>
        Sign out of other devices
      </Button>
    </form>
  );
}
