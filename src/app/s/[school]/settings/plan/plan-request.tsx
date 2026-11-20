"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormError } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

/** Asking EduBridge to add a module to the plan, or to cancel an add-on (SUB-08). */
export function ModuleRequestDialog({
  action,
  kind,
  moduleName,
  priceNote,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  kind: "add_module" | "cancel_module";
  moduleName: string;
  /** The catalogue price, when EduBridge has set one. */
  priceNote?: string | null;
}) {
  const adding = kind === "add_module";
  return (
    <FormDialog
      trigger={adding ? "Ask to add" : "Ask to cancel"}
      triggerSize="sm"
      triggerLabel={`${adding ? "Ask to add" : "Ask to cancel"} ${moduleName}`}
      title={adding ? `Add ${moduleName}` : `Cancel ${moduleName}`}
      description={
        adding
          ? `EduBridge confirms the price with you before it is charged.${priceNote ? ` Usual price: ${priceNote}.` : ""} You keep your plan.`
          : "It stays until the end of the period you have paid for. Nothing your school recorded with it is deleted."
      }
      submitLabel="Send request"
      action={action}
    >
      {(state) => (
        <Field label="Anything EduBridge should know" optional error={state.fieldErrors?.message}>
          {(p) => (
            <Textarea {...p} name="message" rows={3} maxLength={500} defaultValue={state.values?.message} />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export interface PlanChoice {
  id: string;
  name: string;
  description: string | null;
  summary: string;
  current: boolean;
}

/** Asking EduBridge for another plan, or for something particular (SUB-02). EduBridge confirms the price. */
export function PlanRequestForm({
  action,
  plans,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  plans: PlanChoice[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  const errors = state.fieldErrors ?? {};
  const chosen = state.values?.presetId ?? plans.find((p) => !p.current)?.id ?? "";
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormError state={state} />
      {plans.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Plan</legend>
          {errors.presetId && <p className="text-sm text-critical">{errors.presetId}</p>}
          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            {plans.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-subtle">
                <input
                  type="radio"
                  name="presetId"
                  value={p.id}
                  defaultChecked={chosen === p.id}
                  disabled={p.current}
                  className="mt-1 size-4 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block text-base font-medium text-ink">
                    {p.name}
                    {p.current && <span className="ml-2 text-sm font-normal text-ink-3">Your plan now</span>}
                  </span>
                  {p.description && <span className="block text-sm text-ink-2">{p.description}</span>}
                  <span className="block text-sm text-ink-3">{p.summary}</span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-subtle">
              <input
                type="radio"
                name="presetId"
                value=""
                defaultChecked={chosen === ""}
                className="mt-1 size-4 accent-accent"
              />
              <span className="text-base text-ink">Something else (say what below)</span>
            </label>
          </div>
        </fieldset>
      )}
      <Field
        label={plans.length ? "Anything EduBridge should know (optional)" : "What you need"}
        description="For example more students, another campus, or a module."
        error={errors.message}
      >
        {(p) => (
          <Textarea {...p} name="message" rows={3} maxLength={500} defaultValue={state.values?.message} />
        )}
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        Ask EduBridge
      </Button>
    </form>
  );
}
