"use client";

import type { Route } from "next";
import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { verifyCodeAction } from "../actions";

export function VerifyCodeForm({ next, again }: { next?: string; again: Route }) {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyCodeAction, {
    status: "idle",
  });
  return (
    <form action={action} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors && <Alert tone="critical">{state.message}</Alert>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Code" error={state.fieldErrors?.code}>
        {(p) => (
          <Input
            {...p}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            className="h-11 font-mono text-lg tracking-[0.3em]"
            required
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="h-11 w-full">
        Sign in
      </Button>
      <p className="text-sm text-ink-2">
        No text after a minute?{" "}
        <Link href={again} className="font-medium text-accent hover:underline">
          Send a new code
        </Link>
      </p>
    </form>
  );
}
