"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { besideField, Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  COMPONENT_BASES,
  COMPONENT_BASIS_LABELS,
  COMPONENT_KIND_LABELS,
  COMPONENT_KINDS,
  type ComponentBasis,
  type ComponentKind,
} from "@/lib/payroll";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Prepares (or reopens) a month's payroll as a draft. */
export function PrepareForm({ action, month }: { action: Action; month: string }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-3" noValidate>
      <Field
        label="Month"
        error={state.fieldErrors?.month ?? (state.status === "error" ? state.message : undefined)}
      >
        {(p) => (
          <Input
            {...p}
            name="month"
            type="month"
            max={month}
            defaultValue={state.values?.month ?? month}
            required
          />
        )}
      </Field>
      <Button type="submit" variant="primary" className={besideField} pending={pending}>
        Prepare payroll
      </Button>
    </form>
  );
}

export interface SalaryComponentField {
  id: string;
  name: string;
  kind: ComponentKind;
  basis: ComponentBasis;
  /** The value in the current salary, as typed (amount or percentage). */
  current: string;
}

export function SetSalaryDialog({
  action,
  components,
  month,
  basic,
  currencySymbol,
}: {
  action: Action;
  components: SalaryComponentField[];
  month: string;
  basic: string;
  currencySymbol: string;
}) {
  return (
    <FormDialog
      trigger={basic ? "Change salary" : "Set salary"}
      triggerVariant={basic ? "secondary" : "primary"}
      title="Salary from a month"
      description="A new salary from the month you choose; earlier months keep the salary they were paid. Leave a component empty if it does not apply."
      submitLabel="Save salary"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="From" error={e.effectiveMonth}>
                {(p) => (
                  <Input
                    {...p}
                    name="effectiveMonth"
                    type="month"
                    defaultValue={v.effectiveMonth ?? month}
                    required
                  />
                )}
              </Field>
              <Field label={`Basic salary a month (${currencySymbol})`} error={e.basic}>
                {(p) => (
                  <Input {...p} name="basic" inputMode="decimal" defaultValue={v.basic ?? basic} required />
                )}
              </Field>
            </div>
            {e.components && <p className="text-sm text-critical">{e.components}</p>}
            {components.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {components.map((c) => (
                  <Field
                    key={c.id}
                    label={`${c.name}${c.basis === "fixed" ? ` (${currencySymbol})` : " (%)"}`}
                    description={`${COMPONENT_KIND_LABELS[c.kind]}, ${COMPONENT_BASIS_LABELS[c.basis].toLowerCase()}`}
                  >
                    {(p) => (
                      <Input
                        {...p}
                        name={`component-${c.id}`}
                        inputMode="decimal"
                        defaultValue={v[`component-${c.id}`] ?? c.current}
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}
            <Field label="Note" optional error={e.note}>
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

export function AdjustmentDialog({
  action,
  month,
  currencySymbol,
}: {
  action: Action;
  month: string;
  currencySymbol: string;
}) {
  return (
    <FormDialog
      trigger="Add adjustment"
      title="Add an adjustment"
      description="An amount paid or taken once, such as overtime, a correction for a paid month, or an advance. It goes into the first payroll approved for its month or later."
      submitLabel="Add adjustment"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="What it is"
              description="Shown on the payslip."
              error={e.description}
              className="sm:col-span-2"
            >
              {(p) => (
                <Input {...p} name="description" maxLength={120} defaultValue={v.description} required />
              )}
            </Field>
            <Field label="Kind" error={e.kind}>
              {(p) => (
                <Select {...p} name="kind" defaultValue={v.kind ?? "earning"}>
                  <option value="earning">Paid to them</option>
                  <option value="deduction">Taken from their pay</option>
                </Select>
              )}
            </Field>
            <Field label={`Amount (${currencySymbol})`} error={e.amount}>
              {(p) => <Input {...p} name="amount" inputMode="decimal" defaultValue={v.amount} required />}
            </Field>
            <Field label="Month" error={e.month}>
              {(p) => <Input {...p} name="month" type="month" defaultValue={v.month ?? month} required />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

export function ComponentDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Add a component"
      title="Add a pay component"
      description="Its kind and how it is worked out cannot change later. Each person's amount or percentage is set on their salary."
      submitLabel="Add component"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name} className="sm:col-span-2">
              {(p) => <Input {...p} name="name" maxLength={60} defaultValue={v.name} required />}
            </Field>
            <Field label="Kind" error={e.kind}>
              {(p) => (
                <Select {...p} name="kind" defaultValue={v.kind ?? "earning"}>
                  {COMPONENT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {COMPONENT_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Worked out as" error={e.basis}>
              {(p) => (
                <Select {...p} name="basis" defaultValue={v.basis ?? "fixed"}>
                  {COMPONENT_BASES.map((b) => (
                    <option key={b} value={b}>
                      {COMPONENT_BASIS_LABELS[b]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}
