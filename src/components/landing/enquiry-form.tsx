"use client";

import { CircleCheck } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormError } from "@/components/ui/toast";
import { ENQUIRY_ROLES, ENQUIRY_SIZES } from "@/lib/enquiries";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** "Book a demo". Once sent, the form gives way to a short confirmation (it is the step's outcome, not a notice). */
export function EnquiryForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  if (state.status === "success")
    return (
      <div className="flex gap-3 rounded-xl border border-positive/40 bg-surface p-6" role="status">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-positive" />
        <div>
          <p className="text-md font-medium text-ink">Request received</p>
          <p className="mt-1 text-base text-ink-2">{state.message}</p>
        </div>
      </div>
    );
  const e = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form
      action={formAction}
      noValidate
      aria-label="Book a demo"
      className="relative space-y-5 rounded-xl border border-line bg-surface p-5 shadow-raised sm:p-7"
    >
      <FormError state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Your name" error={e.name}>
          {(p) => <Input {...p} name="name" autoComplete="name" maxLength={120} defaultValue={v.name} />}
        </Field>
        <Field label="Your role" error={e.role}>
          {(p) => (
            <Select {...p} name="role" defaultValue={v.role ?? ""}>
              <option value="" disabled>
                Choose
              </option>
              {ENQUIRY_ROLES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="School" error={e.schoolName}>
          {(p) => (
            <Input
              {...p}
              name="schoolName"
              autoComplete="organization"
              maxLength={160}
              defaultValue={v.schoolName}
            />
          )}
        </Field>
        <Field label="Town or area" error={e.town}>
          {(p) => <Input {...p} name="town" maxLength={120} defaultValue={v.town} />}
        </Field>
        <Field label="Mobile number" error={e.phone}>
          {(p) => (
            <Input
              {...p}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="024 123 4567"
              defaultValue={v.phone}
            />
          )}
        </Field>
        <Field label="Email" optional error={e.email}>
          {(p) => <Input {...p} name="email" type="email" autoComplete="email" defaultValue={v.email} />}
        </Field>
      </div>
      <Field label="Number of students" error={e.students}>
        {(p) => (
          <Select {...p} name="students" defaultValue={v.students ?? ""}>
            <option value="" disabled>
              Choose
            </option>
            {ENQUIRY_SIZES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Anything we should know" optional error={e.message}>
        {(p) => <Textarea {...p} name="message" rows={3} maxLength={1000} defaultValue={v.message} />}
      </Field>
      {/* Left empty by people (they never see it); robots fill it in. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label>
          Website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-ink-3">We use these details only to arrange your demo.</p>
        <Button type="submit" pending={pending}>
          Request a demo
        </Button>
      </div>
    </form>
  );
}
