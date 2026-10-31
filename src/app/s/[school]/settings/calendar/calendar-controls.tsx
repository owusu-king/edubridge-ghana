"use client";

import { CalendarPlus } from "lucide-react";
import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
const idle = { status: "idle" } as const;

/** Closes its dialog when the action succeeds. */
function useClosingAction(action: Action, onDone: () => void) {
  return useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result.status === "success") onDone();
    return result;
  }, idle);
}

export function AddYearDialog({ action, suggestedName }: { action: Action; suggestedName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlus aria-hidden="true" />
        Add academic year
      </Button>
      {open && (
        <Dialog
          open
          onOpenChange={setOpen}
          title="Add academic year"
          description="Enter the dates for each term. Leave a row empty if your school has fewer terms."
        >
          <AddYearForm action={action} suggestedName={suggestedName} onDone={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}

function AddYearForm({
  action,
  suggestedName,
  onDone,
}: {
  action: Action;
  suggestedName: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useClosingAction(action, onDone);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status === "error" && <Alert tone="critical">{errors.terms ?? state.message}</Alert>}
      <Field label="Academic year" description="For example 2026/2027." error={errors.name}>
        {(p) => <Input {...p} name="name" defaultValue={state.values?.name ?? suggestedName} required />}
      </Field>
      <div className="space-y-3">
        {[1, 2, 3].map((n) => (
          <fieldset key={n} className="grid grid-cols-[5.5rem_1fr_1fr] items-end gap-2">
            <legend className="sr-only">Term {n}</legend>
            <Field label="Name">{(p) => <Input {...p} name="termName" defaultValue={`Term ${n}`} />}</Field>
            <Field label="Starts">{(p) => <Input {...p} name="termStart" type="date" />}</Field>
            <Field label="Ends">{(p) => <Input {...p} name="termEnd" type="date" />}</Field>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Add year
        </Button>
      </div>
    </form>
  );
}

export function TermActions({
  term,
  update,
  makeCurrent,
}: {
  term: { name: string; startsOn: string; endsOn: string; isCurrent: boolean };
  update: Action;
  makeCurrent: Action;
}) {
  const [editing, setEditing] = useState(false);
  const [state, currentAction, pending] = useActionState<FormState, FormData>(makeCurrent, idle);
  return (
    <div className="flex items-center justify-end gap-1">
      {state.status === "error" && <span className="text-sm text-critical">{state.message}</span>}
      {!term.isCurrent && (
        <form action={currentAction}>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            pending={pending}
            aria-label={`Make ${term.name} the current term`}
          >
            Make current
          </Button>
        </form>
      )}
      <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${term.name}`}>
        Edit
      </Button>
      {editing && (
        <Dialog open onOpenChange={setEditing} title={`Edit ${term.name}`}>
          <EditTermForm term={term} action={update} onDone={() => setEditing(false)} />
        </Dialog>
      )}
    </div>
  );
}

function EditTermForm({
  term,
  action,
  onDone,
}: {
  term: { name: string; startsOn: string; endsOn: string };
  action: Action;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useClosingAction(action, onDone);
  const v = state.values;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors && <Alert tone="critical">{state.message}</Alert>}
      <Field label="Name" error={state.fieldErrors?.name}>
        {(p) => <Input {...p} name="name" defaultValue={v?.name ?? term.name} required />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" error={state.fieldErrors?.startsOn}>
          {(p) => (
            <Input {...p} name="startsOn" type="date" defaultValue={v?.startsOn ?? term.startsOn} required />
          )}
        </Field>
        <Field label="Ends" error={state.fieldErrors?.endsOn}>
          {(p) => <Input {...p} name="endsOn" type="date" defaultValue={v?.endsOn ?? term.endsOn} required />}
        </Field>
      </div>
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
