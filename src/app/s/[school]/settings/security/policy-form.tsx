"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { FormState } from "@/web/forms";

export function MfaPolicyForm({
  action,
  options,
  selected,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  options: { value: string; label: string }[];
  selected: string[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, { status: "idle" });
  const current = state.values ? (state.values.roles?.split(",") ?? []) : selected;
  return (
    <form action={formAction} className="space-y-5">
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Require two-step verification for</legend>
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              name="roles"
              value={option.value}
              defaultChecked={current.includes(option.value)}
              className="size-4 accent-ink"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <p className="text-sm text-ink-3">
        Members with a selected role must set up two-step verification before they can use this school.
      </p>
      <div className="flex justify-end border-t border-line pt-5">
        <Button type="submit" pending={pending}>
          Save policy
        </Button>
      </div>
    </form>
  );
}
