"use client";

import { ActionButton } from "@/components/ui/action-forms";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { BILLING_PERIOD_LABELS, BILLING_PERIODS, type Feature } from "@/lib/plan";
import { GENERAL_PLAN_CHOICES, ModuleChoices } from "@/components/billing/module-choices";
import { SIZE_BANDS } from "@/lib/pricing";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface PresetValues {
  name: string;
  description: string | null;
  features: Feature[];
  maxCampuses: number;
  maxStudents: number | null;
  maxSmsPerMonth: number | null;
  billingPeriod: string;
  currencyCode: string;
  /** Termly price for each size band, smallest first (empty: agreed per school). */
  band0: string;
  band1: string;
  band2: string;
  band3: string;
}

function PresetFields({
  state,
  values,
  currencies,
}: {
  state: FormState;
  values?: PresetValues;
  currencies: readonly string[];
}) {
  const errors = state.fieldErrors ?? {};
  const v = (k: keyof PresetValues, fallback = "") => String(state.values?.[k] ?? values?.[k] ?? fallback);
  const chosen: string[] = state.values
    ? (state.values.features ?? "").split(",")
    : (values?.features ?? [...GENERAL_PLAN_CHOICES]);
  return (
    <div className="space-y-5">
      <Field label="Plan name" error={errors.name}>
        {(p) => <Input {...p} name="name" maxLength={60} defaultValue={v("name")} required />}
      </Field>
      <Field
        label="Description"
        optional
        description="Shown to schools choosing a plan."
        error={errors.description}
      >
        {(p) => (
          <Textarea {...p} name="description" rows={2} maxLength={300} defaultValue={v("description")} />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Campus limit" error={errors.maxCampuses}>
          {(p) => (
            <Input
              {...p}
              name="maxCampuses"
              type="number"
              min={1}
              max={1000}
              defaultValue={v("maxCampuses", "1")}
              required
            />
          )}
        </Field>
        <Field label="Student limit" description="Empty: no limit." error={errors.maxStudents}>
          {(p) => <Input {...p} name="maxStudents" type="number" min={1} defaultValue={v("maxStudents")} />}
        </Field>
        <Field label="SMS per month" description="Empty: no limit." error={errors.maxSmsPerMonth}>
          {(p) => (
            <Input {...p} name="maxSmsPerMonth" type="number" min={0} defaultValue={v("maxSmsPerMonth")} />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Billed"
          description="How often a school on it usually pays."
          error={errors.billingPeriod}
        >
          {(p) => (
            <Select {...p} name="billingPeriod" defaultValue={v("billingPeriod", "termly")}>
              {BILLING_PERIODS.map((b) => (
                <option key={b} value={b}>
                  {BILLING_PERIOD_LABELS[b]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Currency" error={errors.currencyCode}>
          {(p) => (
            <Select {...p} name="currencyCode" defaultValue={v("currencyCode", "GHS")}>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Price per term, by school size</legend>
        <p className="text-sm text-ink-3">
          Active students counted on the census day. Paying yearly or monthly is worked out from these
          (Billing). Leave all empty to agree a price with each school.
        </p>
        <div className="grid gap-4 sm:grid-cols-4">
          {SIZE_BANDS.map((upTo, i) => (
            <Field
              key={upTo}
              label={
                i === 0 ? `Up to ${upTo}` : `${SIZE_BANDS[i - 1]! + 1} to ${upTo.toLocaleString("en-GH")}`
              }
              error={errors[`band${i}`]}
            >
              {(p) => (
                <Input
                  {...p}
                  name={`band${i}`}
                  inputMode="decimal"
                  defaultValue={v(`band${i}` as keyof PresetValues)}
                />
              )}
            </Field>
          ))}
        </div>
        <p className="text-sm text-ink-3">
          Schools with more than {SIZE_BANDS[SIZE_BANDS.length - 1]!.toLocaleString("en-GH")} students get an
          agreed price.
        </p>
      </fieldset>
      <ModuleChoices chosen={chosen} />
    </div>
  );
}

export function NewPresetDialog({ action, currencies }: { action: Action; currencies: readonly string[] }) {
  return (
    <FormDialog
      trigger="New plan"
      triggerVariant="primary"
      title="New plan"
      description="Schools can ask for it, and new schools can start on it."
      submitLabel="Add plan"
      size="lg"
      action={action}
    >
      {(state) => <PresetFields state={state} currencies={currencies} />}
    </FormDialog>
  );
}

export function EditPresetDialog({
  action,
  values,
  currencies,
}: {
  action: Action;
  values: PresetValues;
  currencies: readonly string[];
}) {
  return (
    <FormDialog
      trigger="Edit"
      triggerSize="sm"
      triggerLabel={`Edit ${values.name}`}
      title={`Edit ${values.name}`}
      description="Schools already on this plan keep what they have; set them again from it to change them."
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => <PresetFields state={state} values={values} currencies={currencies} />}
    </FormDialog>
  );
}

export function ArchiveButton({
  action,
  archived,
  name,
}: {
  action: (prev: FormState) => Promise<FormState>;
  archived: boolean;
  name: string;
}) {
  return (
    <ActionButton
      action={action}
      label={archived ? "Offer again" : "Archive"}
      variant={archived ? "secondary" : "danger-outline"}
      ariaLabel={`${archived ? "Offer again" : "Archive"} ${name}`}
    />
  );
}

export function DecideDialogs({
  approve,
  decline,
  school,
  what,
}: {
  approve: Action;
  decline: Action;
  school: string;
  what: string;
}) {
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      <FormDialog
        trigger="Approve"
        triggerSize="sm"
        triggerVariant="primary"
        triggerLabel={`Approve the request from ${school}`}
        title={`Approve the request from ${school}?`}
        description={what}
        submitLabel="Approve"
        action={approve}
      >
        {(state) => (
          <Field label="Note for the school" optional error={state.fieldErrors?.note}>
            {(p) => (
              <Textarea {...p} name="note" rows={2} maxLength={300} defaultValue={state.values?.note} />
            )}
          </Field>
        )}
      </FormDialog>
      <FormDialog
        trigger="Decline"
        triggerSize="sm"
        triggerVariant="ghost"
        triggerLabel={`Decline the request from ${school}`}
        title={`Decline the request from ${school}?`}
        description="The Proprietor is emailed your note."
        submitLabel="Decline"
        danger
        action={decline}
      >
        {(state) => (
          <Field label="Why" error={state.fieldErrors?.note}>
            {(p) => (
              <Textarea
                {...p}
                name="note"
                rows={3}
                maxLength={300}
                defaultValue={state.values?.note}
                required
              />
            )}
          </Field>
        )}
      </FormDialog>
    </div>
  );
}
