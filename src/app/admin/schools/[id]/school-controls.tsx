"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import type { InviteResult } from "../../actions";
import { InviteLinkPanel } from "@/components/ui/invite-link";

type Action<T = undefined> = (prev: FormState<T>, formData: FormData) => Promise<FormState<T>>;

function Message({ state }: { state: FormState<unknown> }) {
  if (state.status === "idle" || !state.message) return null;
  return <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>;
}

export function EntitlementsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: { planName: string; maxCampuses: number; maxStudents: number | null };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Plan name" error={errors.planName}>
          {(p) => (
            <Input
              {...p}
              name="planName"
              defaultValue={v?.planName ?? defaults.planName}
              required
              maxLength={60}
            />
          )}
        </Field>
        <Field label="Campus limit" error={errors.maxCampuses}>
          {(p) => (
            <Input
              {...p}
              name="maxCampuses"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              defaultValue={v?.maxCampuses ?? defaults.maxCampuses}
              required
            />
          )}
        </Field>
        <Field label="Student limit" description="Empty for no limit." error={errors.maxStudents}>
          {(p) => (
            <Input
              {...p}
              name="maxStudents"
              type="number"
              inputMode="numeric"
              min={1}
              defaultValue={v?.maxStudents ?? defaults.maxStudents ?? ""}
            />
          )}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save plan
        </Button>
      </div>
    </form>
  );
}

export function StatusControl({
  action,
  status,
  schoolName,
}: {
  action: Action;
  status: "active" | "suspended";
  schoolName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    async (prev, formData) => {
      const result = await action(prev, formData);
      if (result.status === "success") setOpen(false);
      return result;
    },
    { status: "idle" },
  );
  const suspending = status === "active";
  return (
    <div className="space-y-3">
      <Message state={state} />
      <Button variant={suspending ? "danger" : "primary"} onClick={() => setOpen(true)}>
        {suspending ? "Suspend school" : "Reactivate school"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={suspending ? `Suspend ${schoolName}?` : `Reactivate ${schoolName}?`}
        description={
          suspending
            ? "Everyone at this school loses access immediately. No data is deleted, and you can reactivate the school later."
            : "Members regain access immediately."
        }
      >
        <form action={formAction} className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" variant={suspending ? "danger" : "primary"} pending={pending}>
            {suspending ? "Suspend school" : "Reactivate school"}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

export function ReissueInvitationForm({
  action,
  defaultEmail,
}: {
  action: Action<InviteResult>;
  defaultEmail: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  return (
    <div className="space-y-4">
      {state.status === "success" && state.data ? (
        <InviteLinkPanel result={state.data} />
      ) : (
        state.status === "error" && !state.fieldErrors && <Message state={state} />
      )}
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
        <Field label="Owner's email" error={state.fieldErrors?.email} className="flex-1">
          {(p) => (
            <Input
              {...p}
              name="email"
              type="email"
              defaultValue={state.values?.email ?? defaultEmail}
              required
              autoComplete="off"
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" pending={pending} className="sm:mt-6">
          Create new owner link
        </Button>
      </form>
    </div>
  );
}
