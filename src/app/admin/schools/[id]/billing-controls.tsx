"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  BILLING_PERIOD_LABELS,
  BILLING_PERIODS,
  FEATURE_LABELS,
  FEATURES,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUSES,
  type BillingPeriod,
  type SubscriptionStatus,
} from "@/lib/plan";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>;
}

export interface EntitlementDefaults {
  planName: string;
  maxCampuses: number;
  maxStudents: number | null;
  maxSmsPerMonth: number | null;
  features: string[];
}

/** The plan: name, limits and the modules it includes (TEN-05). */
export function EntitlementsForm({ action, defaults }: { action: Action; defaults: EntitlementDefaults }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const chosen = v ? (v.features ?? "").split(",") : defaults.features;
  return (
    <form action={formAction} className="space-y-6" noValidate>
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Plan name" error={errors.planName}>
          {(p) => (
            <Input
              {...p}
              name="planName"
              defaultValue={v?.planName ?? defaults.planName}
              required
              maxLength={60}
            />
          )}
        </Field>
        <Field label="Campus limit" error={errors.maxCampuses}>
          {(p) => (
            <Input
              {...p}
              name="maxCampuses"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              defaultValue={v?.maxCampuses ?? defaults.maxCampuses}
              required
            />
          )}
        </Field>
        <Field label="Active student limit" description="Empty for no limit." error={errors.maxStudents}>
          {(p) => (
            <Input
              {...p}
              name="maxStudents"
              type="number"
              inputMode="numeric"
              min={1}
              defaultValue={v?.maxStudents ?? defaults.maxStudents ?? ""}
            />
          )}
        </Field>
        <Field
          label="SMS per month"
          description="Reminders and absence SMS. Empty for no limit."
          error={errors.maxSmsPerMonth}
        >
          {(p) => (
            <Input
              {...p}
              name="maxSmsPerMonth"
              type="number"
              inputMode="numeric"
              min={0}
              defaultValue={v?.maxSmsPerMonth ?? defaults.maxSmsPerMonth ?? ""}
            />
          )}
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Included</legend>
        <p className="text-sm text-ink-3">
          Students, classes, fees, payments and receipts are always included.
        </p>
        {errors.features && <p className="text-sm text-critical">{errors.features}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <label key={feature} className="flex items-start gap-2 text-base text-ink">
              <input
                type="checkbox"
                name="features"
                value={feature}
                defaultChecked={chosen.includes(feature)}
                className="mt-1 size-4 accent-accent"
              />
              <span>
                {FEATURE_LABELS[feature].name}
                <span className="block text-sm text-ink-3">{FEATURE_LABELS[feature].description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save plan
        </Button>
      </div>
    </form>
  );
}

export interface SubscriptionDefaults {
  status: SubscriptionStatus;
  billingPeriod: BillingPeriod;
  trialEndsOn: string | null;
  paidUntil: string | null;
  price: string;
  smsPrice: string;
  /** The platform's SMS price, shown as the default. */
  platformSmsPrice: string;
  settlementAccount: string;
  notes: string | null;
}

/** The subscription record (PLT-03): status, how often the school pays, price and dates. */
export function SubscriptionForm({ action, defaults }: { action: Action; defaults: SubscriptionDefaults }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Status" error={errors.status}>
          {(p) => (
            <Select {...p} name="status" defaultValue={v?.status ?? defaults.status}>
              {SUBSCRIPTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {SUBSCRIPTION_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Billed" error={errors.billingPeriod}>
          {(p) => (
            <Select {...p} name="billingPeriod" defaultValue={v?.billingPeriod ?? defaults.billingPeriod}>
              {BILLING_PERIODS.map((b) => (
                <option key={b} value={b}>
                  {BILLING_PERIOD_LABELS[b]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Price per period (GH₵)" description="Empty when not agreed yet." error={errors.price}>
          {(p) => <Input {...p} name="price" inputMode="decimal" defaultValue={v?.price ?? defaults.price} />}
        </Field>
        <Field
          label="SMS price (GH₵ per message)"
          description={
            defaults.platformSmsPrice
              ? `Empty uses the platform price, GH₵${defaults.platformSmsPrice}.`
              : "Empty uses the platform price (not set yet)."
          }
          error={errors.smsPrice}
        >
          {(p) => (
            <Input
              {...p}
              name="smsPrice"
              inputMode="decimal"
              defaultValue={v?.smsPrice ?? defaults.smsPrice}
            />
          )}
        </Field>
        <Field
          label="Paystack subaccount"
          description="Where this school's Mobile Money payments settle (ACCT_…). Required before live payments."
          error={errors.settlementAccount}
        >
          {(p) => (
            <Input
              {...p}
              name="settlementAccount"
              className="font-mono"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={v?.settlementAccount ?? defaults.settlementAccount}
            />
          )}
        </Field>
        <Field label="Trial ends" error={errors.trialEndsOn}>
          {(p) => (
            <Input
              {...p}
              name="trialEndsOn"
              type="date"
              defaultValue={v?.trialEndsOn ?? defaults.trialEndsOn ?? ""}
            />
          )}
        </Field>
        <Field label="Paid until" error={errors.paidUntil}>
          {(p) => (
            <Input
              {...p}
              name="paidUntil"
              type="date"
              defaultValue={v?.paidUntil ?? defaults.paidUntil ?? ""}
            />
          )}
        </Field>
        <Field
          label="Notes"
          description="Seen by EduBridge staff only."
          error={errors.notes}
          className="sm:col-span-2"
        >
          {(p) => (
            <Textarea
              {...p}
              name="notes"
              rows={2}
              maxLength={500}
              defaultValue={v?.notes ?? defaults.notes ?? ""}
            />
          )}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save subscription
        </Button>
      </div>
    </form>
  );
}

export interface InvoiceSuggestion {
  periodStartsOn: string;
  periodEndsOn: string;
  dueOn: string;
  lines: { description: string; quantity: string; unitPrice: string }[];
}

const BLANK_LINE = { description: "", quantity: "", unitPrice: "" };

/** Issues an invoice. Lines are prefilled from the plan and last month's SMS; blank rows are ignored. */
export function IssueInvoiceDialog({
  action,
  suggestion,
}: {
  action: Action;
  suggestion: InvoiceSuggestion;
}) {
  const lines = [...suggestion.lines, BLANK_LINE, BLANK_LINE, BLANK_LINE].slice(
    0,
    Math.max(4, suggestion.lines.length + 1),
  );
  return (
    <FormDialog
      trigger="Issue invoice"
      triggerVariant="primary"
      title="Issue an invoice"
      description="Once issued, an invoice cannot be changed: it can only be marked paid, or voided with a reason. Each line is quantity × unit price."
      submitLabel="Issue invoice"
      size="lg"
      action={action}
    >
      {(state) => {
        const errors = state.fieldErrors ?? {};
        const v = state.values;
        return (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Period from" error={errors.periodStartsOn}>
                {(p) => (
                  <Input
                    {...p}
                    name="periodStartsOn"
                    type="date"
                    defaultValue={v?.periodStartsOn ?? suggestion.periodStartsOn}
                    required
                  />
                )}
              </Field>
              <Field label="Period to" error={errors.periodEndsOn}>
                {(p) => (
                  <Input
                    {...p}
                    name="periodEndsOn"
                    type="date"
                    defaultValue={v?.periodEndsOn ?? suggestion.periodEndsOn}
                    required
                  />
                )}
              </Field>
              <Field label="Due on" error={errors.dueOn}>
                {(p) => (
                  <Input
                    {...p}
                    name="dueOn"
                    type="date"
                    defaultValue={v?.dueOn ?? suggestion.dueOn}
                    required
                  />
                )}
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-ink">
                Lines: description, quantity, unit price (GH₵)
              </legend>
              {errors.lines && <p className="text-sm text-critical">{errors.lines}</p>}
              {lines.map((line, i) => (
                <div key={i} className="grid grid-cols-[1fr_5rem_7rem] gap-2">
                  <Input
                    name="lineDescription"
                    aria-label={`Line ${i + 1}: description`}
                    defaultValue={line.description}
                    maxLength={120}
                  />
                  <Input
                    name="lineQuantity"
                    aria-label={`Line ${i + 1}: quantity`}
                    inputMode="numeric"
                    defaultValue={line.quantity}
                  />
                  <Input
                    name="lineUnitPrice"
                    aria-label={`Line ${i + 1}: unit price`}
                    inputMode="decimal"
                    defaultValue={line.unitPrice}
                  />
                </div>
              ))}
            </fieldset>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Settling an invoice: recording the school's payment, or voiding it. Each happens once. */
export function InvoiceActions({
  invoiceNumber,
  markPaid,
  markVoid,
  today,
}: {
  invoiceNumber: string;
  markPaid: Action;
  markVoid: Action;
  today: string;
}) {
  return (
    <div className="flex justify-end gap-1">
      <FormDialog
        trigger="Record payment"
        triggerSize="sm"
        triggerLabel={`Record payment of ${invoiceNumber}`}
        title={`Record payment of ${invoiceNumber}`}
        submitLabel="Record payment"
        action={markPaid}
      >
        {(state) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paid on" error={state.fieldErrors?.paidOn}>
              {(p) => (
                <Input
                  {...p}
                  name="paidOn"
                  type="date"
                  max={today}
                  defaultValue={state.values?.paidOn ?? today}
                  required
                />
              )}
            </Field>
            <Field
              label="Reference"
              description="Bank, Mobile Money or cheque."
              error={state.fieldErrors?.reference}
            >
              {(p) => (
                <Input
                  {...p}
                  name="reference"
                  maxLength={60}
                  defaultValue={state.values?.reference}
                  required
                />
              )}
            </Field>
          </div>
        )}
      </FormDialog>
      <FormDialog
        trigger="Void"
        triggerSize="sm"
        triggerVariant="ghost"
        triggerLabel={`Void ${invoiceNumber}`}
        title={`Void ${invoiceNumber}?`}
        description="The invoice stays on record, marked void. This cannot be undone."
        submitLabel="Void invoice"
        danger
        action={markVoid}
      >
        {(state) => (
          <Field label="Reason" error={state.fieldErrors?.reason}>
            {(p) => (
              <Input {...p} name="reason" maxLength={200} defaultValue={state.values?.reason} required />
            )}
          </Field>
        )}
      </FormDialog>
    </div>
  );
}
