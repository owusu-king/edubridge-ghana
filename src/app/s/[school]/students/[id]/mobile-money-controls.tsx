"use client";

import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/toast";
import { FormDialog } from "@/components/ui/form-dialog";
import { useFormAction } from "@/components/ui/use-form-action";
import { MobileMoneyFields, type PayerPhone } from "@/components/fees/mobile-money-fields";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export type { PayerPhone } from "@/components/fees/mobile-money-fields";

export function MobileMoneyDialog({
  currency,
  action,
  studentName,
  defaultAmount,
  phones,
  testMode,
  testHint,
  networks,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  action: Action;
  studentName: string;
  defaultAmount: string;
  /** Guardians' phone numbers, primary contact first. */
  phones: PayerPhone[];
  testMode: boolean;
  testHint?: string | null;
  networks: { id: string; label: string }[];
}) {
  return (
    <FormDialog
      trigger={
        <>
          <Smartphone aria-hidden="true" />
          Request Mobile Money
        </>
      }
      triggerSize="sm"
      title="Request Mobile Money"
      description={`The payer approves the payment for ${studentName} on their phone with their PIN. The receipt is issued once the network confirms it.`}
      submitLabel="Send prompt"
      action={action}
    >
      {(state) => (
        <MobileMoneyFields
          state={state}
          defaultAmount={defaultAmount}
          phones={phones}
          testMode={testMode}
          testHint={testHint}
          networks={networks}
          currency={currency}
        />
      )}
    </FormDialog>
  );
}

/** Asks the network for a prompt's outcome. A confirmed payment opens its receipt. */
export function CheckStatusButton({ action, label }: { action: Action; label: string }) {
  const { state, pending, onSubmit } = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="flex flex-col items-end gap-1">
      <Button type="submit" variant="secondary" size="sm" pending={pending} aria-label={label}>
        Check status
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
