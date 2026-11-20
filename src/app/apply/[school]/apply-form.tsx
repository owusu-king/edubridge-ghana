"use client";

import { CheckCircle2 } from "lucide-react";
import { useActionState } from "react";
import { FormError } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import type { ApplyState } from "./actions";

type Action = (prev: ApplyState, formData: FormData) => Promise<ApplyState>;

const RELATIONSHIPS = [
  ["mother", "Mother"],
  ["father", "Father"],
  ["guardian", "Guardian"],
  ["grandparent", "Grandparent"],
  ["sibling", "Brother or sister"],
  ["other", "Other"],
] as const;

/**
 * The public application: the child, the level and term, and the parent's details; then the code texted
 * to that phone. Short and plain, for a phone screen.
 */
export function ApplyForm({
  schoolName,
  levels,
  terms,
  start,
  confirm,
}: {
  schoolName: string;
  levels: { id: string; name: string }[];
  terms: { id: string; name: string }[];
  start: Action;
  confirm: Action;
}) {
  const [state, formAction, pending] = useActionState(start, { status: "idle" } as ApplyState);
  const verificationId = state.status === "success" ? state.data?.verificationId : undefined;
  if (verificationId)
    return <ConfirmStep schoolName={schoolName} action={confirm} verificationId={verificationId} />;
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={formAction} className="space-y-8" noValidate>
      <FormError state={state} />
      <fieldset className="space-y-5">
        <legend className="mb-1 text-md font-semibold text-ink">The child</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="First name" error={errors.childFirstName}>
            {(p) => (
              <Input
                {...p}
                name="childFirstName"
                autoComplete="off"
                maxLength={60}
                defaultValue={v.childFirstName}
                required
              />
            )}
          </Field>
          <Field label="Surname" error={errors.childLastName}>
            {(p) => (
              <Input
                {...p}
                name="childLastName"
                autoComplete="off"
                maxLength={60}
                defaultValue={v.childLastName}
                required
              />
            )}
          </Field>
          <Field label="Other names" optional error={errors.childOtherNames}>
            {(p) => (
              <Input
                {...p}
                name="childOtherNames"
                autoComplete="off"
                maxLength={60}
                defaultValue={v.childOtherNames}
              />
            )}
          </Field>
          <Field label="Sex" error={errors.sex}>
            {(p) => (
              <Select {...p} name="sex" defaultValue={v.sex ?? ""} required>
                <option value="" disabled>
                  Choose
                </option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            )}
          </Field>
          <Field label="Date of birth" error={errors.dateOfBirth}>
            {(p) => <Input {...p} name="dateOfBirth" type="date" defaultValue={v.dateOfBirth} required />}
          </Field>
          <Field label="Current or last school" optional error={errors.previousSchool}>
            {(p) => <Input {...p} name="previousSchool" maxLength={120} defaultValue={v.previousSchool} />}
          </Field>
          <Field label="Class applying for" error={errors.levelId}>
            {(p) => (
              <Select {...p} name="levelId" defaultValue={v.levelId ?? ""} required>
                <option value="" disabled>
                  Choose
                </option>
                {levels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {terms.length > 0 && (
            <Field label="Starting" optional error={errors.entryTermId}>
              {(p) => (
                <Select {...p} name="entryTermId" defaultValue={v.entryTermId ?? ""}>
                  <option value="">As soon as possible</option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      </fieldset>
      <fieldset className="space-y-5">
        <legend className="mb-1 text-md font-semibold text-ink">You</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Your full name" error={errors.guardianName}>
            {(p) => (
              <Input
                {...p}
                name="guardianName"
                autoComplete="name"
                maxLength={120}
                defaultValue={v.guardianName}
                required
              />
            )}
          </Field>
          <Field label="You are the child's" error={errors.guardianRelationship}>
            {(p) => (
              <Select {...p} name="guardianRelationship" defaultValue={v.guardianRelationship ?? "mother"}>
                {RELATIONSHIPS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Mobile number"
            description="We text a code to this number to confirm it is yours."
            error={errors.guardianPhone}
          >
            {(p) => (
              <Input
                {...p}
                name="guardianPhone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                defaultValue={v.guardianPhone}
                required
              />
            )}
          </Field>
          <Field label="Email" optional error={errors.guardianEmail}>
            {(p) => (
              <Input
                {...p}
                name="guardianEmail"
                type="email"
                autoComplete="email"
                defaultValue={v.guardianEmail}
              />
            )}
          </Field>
        </div>
        <Field label="Anything the school should know" optional error={errors.notes}>
          {(p) => <Textarea {...p} name="notes" rows={3} maxLength={1000} defaultValue={v.notes} />}
        </Field>
      </fieldset>
      {/* Hidden from people; bots fill it in. */}
      <div aria-hidden="true" className="hidden">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <p className="text-sm text-ink-3">
        {schoolName} uses these details only for your child&apos;s application. If the application does not go
        ahead, they are removed after 12 months.
      </p>
      <Button type="submit" pending={pending} className="w-full sm:w-auto">
        Send the code to my phone
      </Button>
    </form>
  );
}

function ConfirmStep({
  schoolName,
  action,
  verificationId,
}: {
  schoolName: string;
  action: Action;
  verificationId: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as ApplyState);
  if (state.status === "success" && state.data?.reference)
    return (
      <div className="space-y-3 rounded-lg border border-line bg-surface px-5 py-6" role="status">
        <CheckCircle2 aria-hidden="true" className="size-6 text-positive" />
        <h2 className="text-md font-semibold text-ink">Application sent</h2>
        <p className="text-base text-ink-2">
          Your reference is <strong className="font-semibold text-ink">{state.data.reference}</strong>.{" "}
          {schoolName} will contact you on the number you gave.
        </p>
      </div>
    );
  return (
    <form action={formAction} className="max-w-sm space-y-5" noValidate>
      <input type="hidden" name="verificationId" value={verificationId} />
      <p className="text-base text-ink-2">
        We sent a 6-digit code by SMS. Enter it to send your application.
      </p>
      <FormError state={state} />
      <Field label="Code" error={state.fieldErrors?.code}>
        {(p) => (
          <Input
            {...p}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className="tracking-widest tabular-nums"
            required
          />
        )}
      </Field>
      <Button type="submit" pending={pending}>
        Send application
      </Button>
    </form>
  );
}
