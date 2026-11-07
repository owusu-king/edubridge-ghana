"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>;
}

/** Who may void receipts. The Proprietor decides (Settings, Security). */
export function VoidPolicyForm({
  action,
  accountantsCanVoid,
}: {
  action: Action;
  accountantsCanVoid: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const value = state.values?.accountantsCanVoid ?? (accountantsCanVoid ? "yes" : "no");
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <Message state={state} />
      <fieldset className="space-y-2">
        <legend className="sr-only">Who may void receipts</legend>
        {[
          {
            v: "no",
            label: "Only the Proprietor",
            note: "Recommended: an accountant cannot erase a payment they took.",
          },
          {
            v: "yes",
            label: "The Proprietor and Accountants",
            note: "Every void still needs a reason and is in the audit log.",
          },
        ].map((o) => (
          <label key={o.v} className="flex items-start gap-3 text-base text-ink">
            <input
              type="radio"
              name="accountantsCanVoid"
              value={o.v}
              defaultChecked={value === o.v}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              {o.label}
              <span className="block text-sm text-ink-3">{o.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}

/** How the overview's collection rate and attendance follow-up are worked out. */
export function OverviewPreferencesForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: {
    collectionRateBasis: "due" | "billed";
    attendanceConcernPercent: number;
    attendanceConcernMinDays: number;
  };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const basis = v?.collectionRateBasis ?? defaults.collectionRateBasis;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Message state={state} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Collection rate</legend>
        {[
          {
            v: "due",
            label: "Collected ÷ (owed when the term began + the term's fees)",
            note: "Counts old debts as part of what is due.",
          },
          {
            v: "billed",
            label: "Collected ÷ the term's fees",
            note: "Only this term's fees. Can go above 100% when families pay off old debts.",
          },
        ].map((o) => (
          <label key={o.v} className="flex items-start gap-3 text-base text-ink">
            <input
              type="radio"
              name="collectionRateBasis"
              value={o.v}
              defaultChecked={basis === o.v}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              {o.label}
              <span className="block text-sm text-ink-3">{o.note}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Follow up attendance below (%)" error={errors.attendanceConcernPercent}>
          {(p) => (
            <Input
              {...p}
              name="attendanceConcernPercent"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              defaultValue={v?.attendanceConcernPercent ?? defaults.attendanceConcernPercent}
              required
            />
          )}
        </Field>
        <Field
          label="Once on at least (registers)"
          description="Fewer would flag one bad week."
          error={errors.attendanceConcernMinDays}
        >
          {(p) => (
            <Input
              {...p}
              name="attendanceConcernMinDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              defaultValue={v?.attendanceConcernMinDays ?? defaults.attendanceConcernMinDays}
              required
            />
          )}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** How families reach the school, shown in the parent view (PRT-06). */
export function SchoolContactsForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: { contactPhone: string; contactWhatsapp: string; contactEmail: string; officeHours: string };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone" error={errors.contactPhone}>
          {(p) => (
            <Input
              {...p}
              name="contactPhone"
              type="tel"
              defaultValue={v?.contactPhone ?? defaults.contactPhone}
            />
          )}
        </Field>
        <Field label="WhatsApp number" error={errors.contactWhatsapp}>
          {(p) => (
            <Input
              {...p}
              name="contactWhatsapp"
              type="tel"
              defaultValue={v?.contactWhatsapp ?? defaults.contactWhatsapp}
            />
          )}
        </Field>
        <Field label="Email" error={errors.contactEmail}>
          {(p) => (
            <Input
              {...p}
              name="contactEmail"
              type="email"
              defaultValue={v?.contactEmail ?? defaults.contactEmail}
            />
          )}
        </Field>
        <Field
          label="Office hours"
          description="For example: Mon to Fri, 7:30 to 16:00"
          error={errors.officeHours}
        >
          {(p) => (
            <Input
              {...p}
              name="officeHours"
              maxLength={120}
              defaultValue={v?.officeHours ?? defaults.officeHours}
            />
          )}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
