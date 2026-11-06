"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { requestCodeAction } from "./actions";

export function RequestCodeForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestCodeAction, {
    status: "idle",
  });
  return (
    <form action={action} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors && <Alert tone="critical">{state.message}</Alert>}
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Mobile number" error={state.fieldErrors?.phone}>
        {(p) => (
          <Input
            {...p}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="024 123 4567"
            defaultValue={state.values?.phone}
            className="h-11"
            required
            autoFocus
          />
        )}
      </Field>
      <Button type="submit" pending={pending} className="h-11 w-full">
        Text me a code
      </Button>
    </form>
  );
}
