"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useFormAction } from "@/components/ui/use-form-action";
import type { FormState } from "@/web/forms";

interface Props {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: { name: string; timezone: string };
  timezones: readonly string[];
}

export function ProfileForm({ action, defaults, timezones }: Props) {
  const { state, pending, onSubmit } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <Field label="School name" error={state.fieldErrors?.name}>
        {(props) => (
          <Input
            {...props}
            name="name"
            defaultValue={state.values?.name ?? defaults.name}
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
          <Select {...props} name="timezone" defaultValue={state.values?.timezone ?? defaults.timezone}>
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
