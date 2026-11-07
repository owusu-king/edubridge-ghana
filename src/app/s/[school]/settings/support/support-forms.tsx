"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>;
}

/** The Proprietor lets EduBridge support in for a chosen time (replacing any current grant). */
export function GrantSupportForm({
  action,
  durations,
  live,
}: {
  action: Action;
  durations: readonly { hours: number; label: string }[];
  /** True when support can already come in: saving starts a new period from now. */
  live: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="max-w-xl space-y-5">
      <Message state={state} />
      <Field label="For how long" error={errors.hours}>
        {(p) => (
          <Select {...p} name="hours" defaultValue={state.values?.hours ?? "24"}>
            {durations.map((d) => (
              <option key={d.hours} value={d.hours}>
                {d.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="What do you need help with? (optional)" error={errors.note}>
        {(p) => <Textarea {...p} name="note" rows={3} maxLength={300} defaultValue={state.values?.note} />}
      </Field>
      <Button type="submit" variant={live ? "secondary" : "primary"} pending={pending}>
        {live ? "Start a new period from now" : "Allow support access"}
      </Button>
    </form>
  );
}

/** Ends support access at once. */
export function EndSupportForm({ action }: { action: (prev: FormState) => Promise<FormState> }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-3">
      <Message state={state} />
      <Button type="submit" variant="danger" pending={pending}>
        End support access now
      </Button>
    </form>
  );
}
