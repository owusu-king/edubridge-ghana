"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { BILLING_PERIOD_LABELS, BILLING_PERIODS } from "@/lib/plan";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Sets the catalogue price of a plan or a module for one billing period and currency (SUB-07). */
export function SetPriceDialog({
  action,
  targets,
  currencies,
}: {
  action: Action;
  /** value "plan:<id>" or "module:<id>", with a label. */
  targets: { value: string; label: string; group: "Plans" | "Modules" }[];
  currencies: readonly string[];
}) {
  return (
    <FormDialog
      trigger="Set a price"
      title="Set a catalogue price"
      description="What EduBridge usually charges. A school's agreed price is set on its own page; changing this does not change schools already charged. A price replaced here is kept in the history."
      submitLabel="Save price"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="For" error={e.module ?? e.presetId} className="sm:col-span-2">
              {(p) => (
                <Select {...p} name="for" defaultValue={v.for ?? ""} required>
                  <option value="" disabled>
                    Choose a plan or module
                  </option>
                  {(["Plans", "Modules"] as const).map((group) => (
                    <optgroup key={group} label={group}>
                      {targets
                        .filter((t) => t.group === group)
                        .map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Charged" error={e.billingPeriod}>
              {(p) => (
                <Select {...p} name="billingPeriod" defaultValue={v.billingPeriod ?? "termly"}>
                  {BILLING_PERIODS.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_PERIOD_LABELS[b]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Currency" error={e.currencyCode}>
              {(p) => (
                <Select {...p} name="currencyCode" defaultValue={v.currencyCode ?? "GHS"}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Price" error={e.price}>
              {(p) => <Input {...p} name="price" inputMode="decimal" defaultValue={v.price ?? ""} required />}
            </Field>
            <Field label="Price counts" error={e.unit}>
              {(p) => (
                <Select {...p} name="unit" defaultValue={v.unit ?? "flat"}>
                  <option value="flat">Once for the school</option>
                  <option value="per_student">Per active student</option>
                </Select>
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** How long a module stays read-only after an add-on, trial or promotion ends (ENT-08). */
export function ReadOnlyDaysForm({ action, days }: { action: Action; days: number }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state.status !== "idle" && state.message && !state.fieldErrors && <FormMessage state={state} />}
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Days read-only after a module ends"
          description="The school's records stay viewable and exportable, but cannot change. 0 turns the module off at once. Applies to modules from R4 on."
          error={state.fieldErrors?.days}
          className="max-w-sm grow"
        >
          {(p) => (
            <Input
              {...p}
              name="days"
              type="number"
              inputMode="numeric"
              min={0}
              max={365}
              defaultValue={state.values?.days ?? days}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" pending={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
