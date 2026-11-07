"use client";

import { useState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

export interface AudienceChoice {
  value: string;
  label: string;
  families: number;
}

/** Writing an announcement, choosing who it is for, and (optionally) sending it by SMS. */
export function NewAnnouncementDialog({
  action,
  audiences,
  smsPricePesewas,
  smsPaused,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  audiences: AudienceChoice[];
  smsPricePesewas: number | null;
  /** True while SMS are paused for an overdue EduBridge invoice. */
  smsPaused: boolean;
}) {
  return (
    <FormDialog
      trigger="New announcement"
      triggerVariant="primary"
      title="New announcement"
      description="Families see it in the parent view. Announcements cannot be edited once posted."
      submitLabel="Post announcement"
      size="lg"
      action={action}
    >
      {(state) => <Fields state={state} audiences={audiences} price={smsPricePesewas} paused={smsPaused} />}
    </FormDialog>
  );
}

function Fields({
  state,
  audiences,
  price,
  paused,
}: {
  state: FormState;
  audiences: AudienceChoice[];
  price: number | null;
  paused: boolean;
}) {
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const [audience, setAudience] = useState(v?.audience ?? audiences[0]?.value ?? "school:");
  const families = audiences.find((a) => a.value === audience)?.families ?? 0;
  const cost = price === null ? null : (price * families) / 100;
  return (
    <div className="space-y-5">
      <Field label="Title" error={errors.title}>
        {(p) => <Input {...p} name="title" maxLength={100} defaultValue={v?.title} required />}
      </Field>
      <Field label="Message" error={errors.body}>
        {(p) => <Textarea {...p} name="body" rows={6} maxLength={2000} defaultValue={v?.body} required />}
      </Field>
      <Field label="For" error={errors.audience}>
        {(p) => (
          <Select {...p} name="audience" value={audience} onChange={(e) => setAudience(e.target.value)}>
            {audiences.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label} ({a.families} {a.families === 1 ? "family" : "families"})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="sms"
          disabled={paused || families === 0}
          defaultChecked={v?.sms === "on"}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          Also send by SMS
          <span className="block text-sm text-ink-3">
            {paused
              ? "SMS are paused while an EduBridge invoice is overdue."
              : `One SMS to each of ${families} ${families === 1 ? "family" : "families"}, with the title and a link to read it${
                  cost !== null ? `: about GH₵${cost.toFixed(2)}` : ""
                }.`}
          </span>
        </span>
      </label>
    </div>
  );
}
