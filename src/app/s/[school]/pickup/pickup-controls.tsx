"use client";

import { Field, Input, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface CollectorChoice {
  key: string;
  name: string;
  relationship: string;
  kind: "guardian" | "collector";
  /** The photo's address, when the collector has one. */
  photoUrl: string | null;
}

/** Releasing a child to someone on their list (VIS-02b). Anyone else is refused by the server. */
export function ReleaseDialog({
  action,
  child,
  collectors,
}: {
  action: Action;
  child: string;
  collectors: CollectorChoice[];
}) {
  return (
    <FormDialog
      trigger="Release"
      triggerVariant="primary"
      triggerSize="sm"
      triggerLabel={`Release ${child}`}
      title={`Release ${child}`}
      description="Only to someone on this list. Check their face against the photo where there is one."
      submitLabel="Release"
      action={action}
    >
      {(state) => {
        const chosen = state.values?.collector;
        return (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-ink">Who is collecting</legend>
            {collectors.map((c, i) => (
              <label
                key={c.key}
                className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5 text-base text-ink has-[:checked]:border-ink"
              >
                <input
                  type="radio"
                  name="collector"
                  value={c.key}
                  defaultChecked={chosen ? chosen === c.key : i === 0 && collectors.length === 1}
                  className="size-4 accent-accent"
                />
                {c.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
                  <img
                    src={c.photoUrl}
                    alt={`Photo of ${c.name}`}
                    className="size-14 shrink-0 rounded-md border border-line object-cover"
                  />
                ) : null}
                <span>
                  {c.name}
                  <span className="block text-sm text-ink-3">
                    {c.relationship}
                    {c.kind === "guardian" ? " · guardian" : ""}
                  </span>
                </span>
              </label>
            ))}
            {state.fieldErrors?.collector && (
              <p className="text-sm text-critical">{state.fieldErrors.collector}</p>
            )}
            <Field label="Note" optional error={state.fieldErrors?.note}>
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={state.values?.note} />}
            </Field>
          </fieldset>
        );
      }}
    </FormDialog>
  );
}

/** Someone not on the list came for the child (VIS-02c). */
export function RefuseDialog({ action, child }: { action: Action; child: string }) {
  return (
    <FormDialog
      trigger="Refuse"
      triggerSize="sm"
      triggerLabel={`Record a refusal for ${child}`}
      title={`Record a refusal for ${child}`}
      description="The child stays at school. Tell the office or the head teacher, and contact a guardian."
      submitLabel="Record refusal"
      danger
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Their name" error={e.personName}>
              {(p) => <Input {...p} name="personName" maxLength={120} defaultValue={v.personName} required />}
            </Field>
            <Field label="Who they said they are" optional error={e.relationship}>
              {(p) => <Input {...p} name="relationship" maxLength={60} defaultValue={v.relationship} />}
            </Field>
            <Field label="Why the child was not released" error={e.reason} className="sm:col-span-2">
              {(p) => (
                <Textarea
                  {...p}
                  name="reason"
                  rows={2}
                  maxLength={500}
                  defaultValue={v.reason ?? "Not on the child's list of people who may collect them."}
                  required
                />
              )}
            </Field>
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Cancelling a record made by mistake, or ending a collector: once, with a reason, kept on record. */
export function ReasonDialog({
  action,
  trigger,
  triggerLabel,
  title,
  description,
  submitLabel,
  label,
}: {
  action: Action;
  trigger: string;
  triggerLabel: string;
  title: string;
  description: string;
  submitLabel: string;
  label: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerSize="sm"
      triggerLabel={triggerLabel}
      title={title}
      description={description}
      submitLabel={submitLabel}
      danger
      action={action}
    >
      {(state) => (
        <Field label={label} error={state.fieldErrors?.reason}>
          {(p) => (
            <Textarea
              {...p}
              name="reason"
              rows={2}
              maxLength={300}
              defaultValue={state.values?.reason}
              required
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

/** Naming someone other than a guardian who may collect the child (VIS-02a). */
export function AddCollectorDialog({ action, today }: { action: Action; today: string }) {
  return (
    <FormDialog
      trigger="Add a collector"
      triggerVariant="primary"
      title="Add someone who may collect this child"
      description="For a driver, relative or family friend. Guardians are allowed on the student record. For one day only, set the last day to today."
      submitLabel="Add"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Full name" error={e.fullName}>
              {(p) => <Input {...p} name="fullName" maxLength={120} defaultValue={v.fullName} required />}
            </Field>
            <Field label="Who they are to the child" error={e.relationship}>
              {(p) => (
                <Input
                  {...p}
                  name="relationship"
                  maxLength={60}
                  placeholder="e.g. Aunt, driver"
                  defaultValue={v.relationship}
                  required
                />
              )}
            </Field>
            <Field label="Phone" optional error={e.phone}>
              {(p) => <Input {...p} name="phone" type="tel" inputMode="tel" defaultValue={v.phone} />}
            </Field>
            <Field label="Last day" optional error={e.validUntil}>
              {(p) => <Input {...p} name="validUntil" type="date" min={today} defaultValue={v.validUntil} />}
            </Field>
            <Field
              label="Photo"
              optional
              description="A PNG, JPEG or WebP image up to 500 KB, shown to staff at the gate."
              error={e.photo}
              className="sm:col-span-2"
            >
              {(p) => <Input {...p} name="photo" type="file" accept="image/png,image/jpeg,image/webp" />}
            </Field>
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}
