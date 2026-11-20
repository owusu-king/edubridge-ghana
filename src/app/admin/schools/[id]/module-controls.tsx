"use client";

import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { ActionButton } from "@/components/ui/action-forms";
import { ENTITLEMENT_SOURCE_LABELS, ENTITLEMENT_SOURCES, MODULES, PLAN_CHOICES } from "@/lib/modules";
import { BILLING_PERIOD_LABELS, BILLING_PERIODS, type BillingPeriod } from "@/lib/plan";
import { currencySymbol } from "@/lib/money";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Bare = (prev: FormState) => Promise<FormState>;

/** Adds a module beyond the school's plan: an add-on, a trial, a promotion or part of an agreement (SUB-06). */
export function GrantModuleDialog({
  action,
  currency,
  today,
  billingPeriod,
  exclude,
}: {
  action: Action;
  currency: string;
  today: string;
  billingPeriod: BillingPeriod;
  /** Modules the school already has through its plan. */
  exclude: readonly string[];
}) {
  const choices = PLAN_CHOICES.filter((id) => !exclude.includes(id));
  return (
    <FormDialog
      trigger="Add a module"
      title="Add a module for this school"
      description="On top of its plan. A trial or promotion usually has an end date and no price; the module is read-only for a while after it ends (R4 modules), then off. Records are always kept."
      submitLabel="Add module"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Module" error={e.module} className="sm:col-span-2">
              {(p) => (
                <Select {...p} name="module" defaultValue={v.module ?? ""} required>
                  <option value="" disabled>
                    Choose a module
                  </option>
                  {choices.map((id) => (
                    <option key={id} value={id}>
                      {MODULES[id].name}
                      {MODULES[id].requires.length
                        ? ` (needs ${MODULES[id].requires.map((r) => MODULES[r].name).join(", ")})`
                        : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Why the school has it" error={e.source}>
              {(p) => (
                <Select {...p} name="source" defaultValue={v.source ?? "addon"}>
                  {ENTITLEMENT_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {ENTITLEMENT_SOURCE_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Note" optional description="For EduBridge staff." error={e.note}>
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note ?? ""} />}
            </Field>
            <Field label="First day" error={e.startsOn}>
              {(p) => <Input {...p} name="startsOn" type="date" defaultValue={v.startsOn ?? today} />}
            </Field>
            <Field label="Last day" description="Empty: until ended. A trial needs one." error={e.endsOn}>
              {(p) => <Input {...p} name="endsOn" type="date" defaultValue={v.endsOn ?? ""} />}
            </Field>
            <Field
              label={`Agreed price (${currencySymbol(currency)})`}
              description="Empty: no charge. The catalogue price is a starting point."
              error={e.price}
            >
              {(p) => <Input {...p} name="price" inputMode="decimal" defaultValue={v.price ?? ""} />}
            </Field>
            <Field label="Charged" error={e.billingPeriod}>
              {(p) => (
                <Select {...p} name="billingPeriod" defaultValue={v.billingPeriod ?? billingPeriod}>
                  {BILLING_PERIODS.map((b) => (
                    <option key={b} value={b}>
                      {BILLING_PERIOD_LABELS[b]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Price counts" error={e.priceUnit}>
              {(p) => (
                <Select {...p} name="priceUnit" defaultValue={v.priceUnit ?? "flat"}>
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

export function ScheduleEndDialog({
  action,
  moduleName,
  today,
}: {
  action: Action;
  moduleName: string;
  today: string;
}) {
  return (
    <FormDialog
      trigger="Set end date"
      triggerSize="sm"
      triggerLabel={`Set an end date for ${moduleName}`}
      title={`End ${moduleName} on a date`}
      description="The last day the school has it. This can be set once; to end it sooner, end it now."
      submitLabel="Set end date"
      action={action}
    >
      {(state) => (
        <Field label="Last day" error={state.fieldErrors?.endsOn}>
          {(p) => <Input {...p} name="endsOn" type="date" min={today} defaultValue={today} required />}
        </Field>
      )}
    </FormDialog>
  );
}

export function EndModuleDialog({ action, moduleName }: { action: Action; moduleName: string }) {
  return (
    <FormDialog
      trigger="End now"
      triggerSize="sm"
      triggerVariant="secondary"
      triggerLabel={`End ${moduleName} now`}
      title={`End ${moduleName} now`}
      description="From today the school can no longer use it (R4 modules stay read-only for a while). Nothing the school recorded is deleted, and it comes back if the module is added again."
      submitLabel="End now"
      danger
      action={action}
    >
      {(state) => (
        <Field label="Reason" description="Kept in the school's audit log." error={state.fieldErrors?.reason}>
          {(p) => <Textarea {...p} name="reason" rows={2} maxLength={300} required />}
        </Field>
      )}
    </FormDialog>
  );
}

export function ReleaseAccessButton({
  action,
  on,
  moduleName,
}: {
  action: Bare;
  on: boolean;
  moduleName: string;
}) {
  return (
    <ActionButton
      action={action}
      label={on ? "Give release access" : "End release access"}
      variant={on ? "secondary" : "danger-outline"}
      ariaLabel={`${on ? "Give" : "End"} release access to ${moduleName}`}
    />
  );
}
