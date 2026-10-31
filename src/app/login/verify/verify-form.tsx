"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { verifyAction, type VerifyState } from "./actions";

export function VerifyForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<VerifyState, FormData>(verifyAction, {});
  if (state.expired) {
    return (
      <div className="space-y-5">
        <Alert tone="critical">{state.error}</Alert>
        <Link href="/login" className="text-base font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-5">
      {state.error && <Alert tone="critical">{state.error}</Alert>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field
        label="Verification code"
        description="The 6-digit code from your authenticator app, or a recovery code."
      >
        {(p) => (
          <Input
            {...p}
            name="code"
            required
            autoFocus
            autoComplete="one-time-code"
            inputMode="text"
            maxLength={16}
            className="font-mono tracking-widest"
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="w-full">
        Verify
      </Button>
    </form>
  );
}
