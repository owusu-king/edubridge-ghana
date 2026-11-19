"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

/** The platform's SMS price and grace period. A school's own SMS price, set on its page, wins. */
export function PlatformSettingsForm({
  action,
  defaults,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: { smsPrice: string; whatsappPrice: string; graceDays: number };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <div className="grid gap-5 sm:grid-cols-3 sm:items-end lg:max-w-3xl">
        <Field
          label="SMS price for schools billed in cedis (GH₵ per message)"
          description="Used where a school has no price of its own."
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
          label="WhatsApp price for schools billed in cedis (GH₵ per message)"
          description="For schools whose plan includes WhatsApp."
          error={errors.whatsappPrice}
        >
          {(p) => (
            <Input
              {...p}
              name="whatsappPrice"
              inputMode="decimal"
              defaultValue={v?.whatsappPrice ?? defaults.whatsappPrice}
            />
          )}
        </Field>
        <Field
          label="Grace days"
          description="After an invoice falls due, before SMS pause."
          error={errors.graceDays}
        >
          {(p) => (
            <Input
              {...p}
              name="graceDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={60}
              defaultValue={v?.graceDays ?? defaults.graceDays}
              required
            />
          )}
        </Field>
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Save settings
      </Button>
    </form>
  );
}

/** EduBridge as printed on its invoices, and how schools pay them (SUB-03). */
export function InvoiceDetailsForm({
  action,
  defaults,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: { issuer: string; paymentInstructions: string };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="EduBridge on invoices"
          description="Legal name, address and tax number, as they should print."
          error={errors.issuer}
        >
          {(p) => (
            <Textarea
              {...p}
              name="issuer"
              rows={4}
              maxLength={500}
              defaultValue={v?.issuer ?? defaults.issuer}
            />
          )}
        </Field>
        <Field
          label="How to pay"
          description="Bank or Mobile Money details printed on unpaid invoices."
          error={errors.paymentInstructions}
        >
          {(p) => (
            <Textarea
              {...p}
              name="paymentInstructions"
              rows={4}
              maxLength={500}
              defaultValue={v?.paymentInstructions ?? defaults.paymentInstructions}
            />
          )}
        </Field>
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Save invoice details
      </Button>
    </form>
  );
}

export interface InvoicingDefaults {
  autoInvoicing: boolean;
  censusDays: number;
  invoiceDueDays: number;
  /** Percentages, like "12". */
  annualDiscount: string;
  monthlySurcharge: string;
}

/**
 * Automatic invoices (founder, 2026-11-18): on or off, when students are counted, how long schools have to pay,
 * and how yearly and monthly prices follow from the termly price.
 */
export function InvoicingSettingsForm({
  action,
  defaults,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  defaults: InvoicingDefaults;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const on = v ? v.autoInvoicing === "on" : defaults.autoInvoicing;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <label className="flex items-start gap-3 text-base text-ink lg:max-w-3xl">
        <input type="checkbox" name="autoInvoicing" defaultChecked={on} className="mt-1 size-4 accent-ink" />
        <span>
          Issue invoices automatically
          <span className="block text-sm text-ink-3">
            Each school on its census day (termly and yearly) or on the first of the month (monthly), and the
            Proprietors are emailed. Leave off until the plans&apos; prices are final.
          </span>
        </span>
      </label>
      <div className="grid gap-5 sm:grid-cols-2 sm:items-end lg:max-w-3xl lg:grid-cols-4">
        <Field
          label="Census day"
          description="Days after a term starts that students are counted."
          error={errors.censusDays}
        >
          {(p) => (
            <Input
              {...p}
              name="censusDays"
              type="number"
              inputMode="numeric"
              min={0}
              max={60}
              defaultValue={v?.censusDays ?? defaults.censusDays}
              required
            />
          )}
        </Field>
        <Field label="Days to pay" description="From the invoice date." error={errors.invoiceDueDays}>
          {(p) => (
            <Input
              {...p}
              name="invoiceDueDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              defaultValue={v?.invoiceDueDays ?? defaults.invoiceDueDays}
              required
            />
          )}
        </Field>
        <Field
          label="Yearly discount (%)"
          description="Off the terms paid for at once."
          error={errors.annualDiscount}
        >
          {(p) => (
            <Input
              {...p}
              name="annualDiscount"
              inputMode="decimal"
              defaultValue={v?.annualDiscount ?? defaults.annualDiscount}
              required
            />
          )}
        </Field>
        <Field
          label="Monthly premium (%)"
          description="On a month's share of the year."
          error={errors.monthlySurcharge}
        >
          {(p) => (
            <Input
              {...p}
              name="monthlySurcharge"
              inputMode="decimal"
              defaultValue={v?.monthlySurcharge ?? defaults.monthlySurcharge}
              required
            />
          )}
        </Field>
      </div>
      <div className="flex justify-start">
        <Button type="submit" variant="secondary" pending={pending}>
          Save invoicing settings
        </Button>
      </div>
    </form>
  );
}
