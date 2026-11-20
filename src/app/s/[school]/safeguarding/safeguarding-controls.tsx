"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { besideField, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  CONCERN_CATEGORIES,
  CONCERN_CATEGORY_LABELS,
  ENTRY_KIND_LABELS,
  WRITTEN_ENTRY_KINDS,
} from "@/lib/safeguarding";
import type { FormState } from "@/web/forms";
import { FormError, SuccessToast } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Reporting a concern (SFG-01a): written once, read only by the school's leads. */
export function ReportForm({
  action,
  students,
  today,
}: {
  action: Action;
  students: { id: string; name: string; className: string | null }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = state.fieldErrors ?? {};
  const v = state.status === "error" ? (state.values ?? {}) : {};
  const classes = [...new Set(students.map((s) => s.className ?? "Not in a class"))];
  return (
    <form
      action={formAction}
      className="space-y-5"
      noValidate
      key={state.status === "success" ? state.message : "form"}
    >
      <SuccessToast state={state} />
      <FormError state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Child" error={e.studentId}>
          {(p) => (
            <Select {...p} name="studentId" defaultValue={v.studentId ?? ""} required>
              <option value="" disabled>
                Choose the child
              </option>
              {classes.map((c) => (
                <optgroup key={c} label={c}>
                  {students
                    .filter((s) => (s.className ?? "Not in a class") === c)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What it is about" error={e.category}>
          {(p) => (
            <Select {...p} name="category" defaultValue={v.category ?? ""} required>
              <option value="" disabled>
                Choose
              </option>
              {CONCERN_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CONCERN_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field
        label="What you saw or were told"
        description="In the child's own words where you can. Facts, not opinions. It cannot be changed after you send it."
        error={e.description}
      >
        {(p) => (
          <Textarea
            {...p}
            name="description"
            rows={5}
            maxLength={4000}
            defaultValue={v.description}
            required
          />
        )}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="When it happened" error={e.occurredOn}>
          {(p) => (
            <Input {...p} name="occurredOn" type="date" max={today} defaultValue={v.occurredOn ?? today} />
          )}
        </Field>
        <Field label="Where" optional error={e.location}>
          {(p) => <Input {...p} name="location" maxLength={200} defaultValue={v.location} />}
        </Field>
      </div>
      <Field label="Anything you did at once" optional error={e.immediateAction}>
        {(p) => (
          <Textarea
            {...p}
            name="immediateAction"
            rows={2}
            maxLength={2000}
            defaultValue={v.immediateAction}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" pending={pending}>
        Send to the safeguarding leads
      </Button>
    </form>
  );
}

export function EntryDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Record"
      triggerVariant="primary"
      title="Record on this case"
      description="Kept in the case history for good: it cannot be edited or removed."
      submitLabel="Record"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="What" error={e.kind}>
              {(p) => (
                <Select {...p} name="kind" defaultValue={v.kind ?? "note"}>
                  {WRITTEN_ENTRY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ENTRY_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Due (actions only)" error={e.dueOn}>
              {(p) => <Input {...p} name="dueOn" type="date" defaultValue={v.dueOn} />}
            </Field>
            <Field label="Details" error={e.body} className="sm:col-span-2">
              {(p) => (
                <Textarea {...p} name="body" rows={4} maxLength={4000} defaultValue={v.body} required />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

const STATUS_COPY = {
  monitoring: {
    trigger: "Move to monitoring",
    title: "Move to monitoring",
    submit: "Move to monitoring",
    needs: false,
  },
  closed: { trigger: "Close case", title: "Close this case", submit: "Close case", needs: true },
  open: { trigger: "Reopen", title: "Reopen this case", submit: "Reopen", needs: false },
} as const;

export function StatusDialog({ action, status }: { action: Action; status: keyof typeof STATUS_COPY }) {
  const copy = STATUS_COPY[status];
  return (
    <FormDialog trigger={copy.trigger} title={copy.title} submitLabel={copy.submit} action={action}>
      {(state) => (
        <Field label={copy.needs ? "Why it is closed" : "Note (optional)"} error={state.fieldErrors?.note}>
          {(p) => <Textarea {...p} name="note" rows={3} maxLength={2000} required={copy.needs} />}
        </Field>
      )}
    </FormDialog>
  );
}

export function AssignLeadForm({
  action,
  leads,
  current,
}: {
  action: Action;
  leads: { membershipId: string; name: string }[];
  current: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
      <Field label="Lead responsible" error={state.fieldErrors?.membershipId}>
        {(p) => (
          <Select {...p} name="membershipId" defaultValue={current ?? ""}>
            <option value="">Not assigned</option>
            {leads.map((l) => (
              <option key={l.membershipId} value={l.membershipId}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" variant="secondary" className={besideField} pending={pending}>
        Save
      </Button>
    </form>
  );
}

export function AppointLeadForm({
  action,
  members,
}: {
  action: Action;
  members: { id: string; name: string; email: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  if (!members.length)
    return <p className="text-base text-ink-3">Every active member of staff is already a lead.</p>;
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-3" noValidate>
      <Field
        label="Appoint a lead"
        error={state.fieldErrors?.membershipId}
        className="min-w-0 grow basis-64 sm:max-w-sm"
      >
        {(p) => (
          <Select {...p} name="membershipId" defaultValue="" required>
            <option value="" disabled>
              Choose a member of staff
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" variant="secondary" className={besideField} pending={pending}>
        Appoint
      </Button>
    </form>
  );
}
