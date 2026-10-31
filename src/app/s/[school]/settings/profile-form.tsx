"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import type { ProfileFormState } from "./actions";

interface Props {
  action: (prev: ProfileFormState, formData: FormData) => Promise<ProfileFormState>;
  defaults: { name: string; timezone: string };
  timezones: readonly string[];
}

export function ProfileForm({ action, defaults, timezones }: Props) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "saved" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <Field label="School name" error={state.fieldErrors?.name}>
        {(props) => (
          <Input
            {...props}
            name="name"
            defaultValue={defaults.name}
            required
            maxLength={120}
            autoComplete="organization"
          />
        )}
      </Field>
      <Field
        label="Time zone"
        description="Used for dates, attendance and reports."
        error={state.fieldErrors?.timezone}
      >
        {(props) => (
          <Select {...props} name="timezone" defaultValue={defaults.timezone}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace("_", " ")}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex justify-end border-t border-line pt-5">
        <Button type="submit" pending={pending}>
          Save changes
        </Button>
      </div>
    </form>
  );
}
