"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  BILLING_PERIOD_LABELS,
  BILLING_PERIODS,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUSES,
  type BillingPeriod,
  type SubscriptionStatus,
} from "@/lib/plan";
import type { FormState } from "@/web/forms";
import { currencySymbol } from "@/lib/money";
import { ModuleChoices } from "@/components/billing/module-choices";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <FormMessage state={state} />;
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
      {errors.features && <p className="text-sm text-critical">{errors.features}</p>}
      <ModuleChoices chosen={chosen} describe />
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
  /** "" for the deployment's default. */
  mobileMoneyProvider: string;
  notes: string | null;
  discountPercent: string;
  discountLabel: string;
  discountUntil: string;
}

/** The subscription record (PLT-03): status, how often the school pays, price and dates. */
export function SubscriptionForm({
  currency,
  action,
  defaults,
  providerOptions,
}: {
  currency: string;
  action: Action;
  defaults: SubscriptionDefaults;
  /** Mobile Money providers platform staff can choose for this school. */
  providerOptions: { value: string; label: string }[];
}) {
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
        <Field
          label={`Agreed price per period (${currencySymbol(currency)})`}
          description="Empty: priced by the plan for the school's size."
          error={errors.price}
        >
          {(p) => <Input {...p} name="price" inputMode="decimal" defaultValue={v?.price ?? defaults.price} />}
        </Field>
        <Field
          label={`SMS price (${currencySymbol(currency)} per message)`}
          description={
            defaults.platformSmsPrice
              ? `Empty uses the platform price, GH₵${defaults.platformSmsPrice} (schools billed in cedis only).`
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
          label="Mobile Money provider"
          description="Prompts this school sends from now on. Prompts already sent are still checked with the provider that sent them."
          error={errors.mobileMoneyProvider}
        >
          {(p) => (
            <Select
              {...p}
              name="mobileMoneyProvider"
              defaultValue={v?.mobileMoneyProvider ?? defaults.mobileMoneyProvider}
            >
              {providerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
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
          label="Discount (%)"
          description="On the plan and add-ons. Empty for none."
          error={errors.discountPercent}
        >
          {(p) => (
            <Input
              {...p}
              name="discountPercent"
              inputMode="decimal"
              defaultValue={v?.discountPercent ?? defaults.discountPercent}
            />
          )}
        </Field>
        <Field
          label="Discount name"
          description="On invoices, like “Founding school”."
          error={errors.discountLabel}
        >
          {(p) => (
            <Input
              {...p}
              name="discountLabel"
              maxLength={60}
              defaultValue={v?.discountLabel ?? defaults.discountLabel}
            />
          )}
        </Field>
        <Field label="Discount until" description="Empty: until removed." error={errors.discountUntil}>
          {(p) => (
            <Input
              {...p}
              name="discountUntil"
              type="date"
              defaultValue={v?.discountUntil ?? defaults.discountUntil}
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
  currency,
  action,
  suggestion,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
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
                Lines: description, quantity, unit price ({currencySymbol(currency)})
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

/** Sets the school's plan from one of EduBridge's plans (SUB-01): modules, limits, and price in its currency. */
export function ApplyPresetForm({
  action,
  presets,
  current,
}: {
  action: Action;
  presets: { id: string; name: string }[];
  current: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" });
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <Message state={state} />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Set from a plan" error={state.fieldErrors?.presetId} className="min-w-56">
          {(p) => (
            <Select {...p} name="presetId" defaultValue={current ?? ""}>
              <option value="" disabled>
                Choose a plan
              </option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary" pending={pending}>
          Set plan
        </Button>
      </div>
    </form>
  );
}

/** Extra SMS for this month, charged on the school's next invoice. */
export function SmsTopUpDialog({ action, currency }: { action: Action; currency: string }) {
  return (
    <FormDialog
      trigger="Add SMS for this month"
      triggerSize="sm"
      title="Add SMS for this month"
      description="Raises this month's allowance at once; the price is charged on the school's next invoice."
      submitLabel="Add SMS"
      action={action}
    >
      {(state) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Messages" error={state.fieldErrors?.messages}>
            {(p) => (
              <Input
                {...p}
                name="messages"
                type="number"
                inputMode="numeric"
                min={1}
                defaultValue={state.values?.messages ?? "500"}
                required
              />
            )}
          </Field>
          <Field label={`Price (${currencySymbol(currency)})`} error={state.fieldErrors?.price}>
            {(p) => (
              <Input {...p} name="price" inputMode="decimal" defaultValue={state.values?.price} required />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}
