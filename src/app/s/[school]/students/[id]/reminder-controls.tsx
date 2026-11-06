"use client";

import { MessageSquareText } from "lucide-react";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Confirms before sending: each reminder is an SMS the school pays for. */
export function SmsReminderDialog({
  action,
  contactName,
  phone,
  preview,
}: {
  action: Action;
  contactName: string;
  phone: string;
  preview: string;
}) {
  return (
    <FormDialog
      trigger={
        <>
          <MessageSquareText aria-hidden="true" />
          Send SMS reminder
        </>
      }
      triggerVariant="ghost"
      triggerSize="sm"
      title="Send an SMS reminder?"
      description={`To ${contactName}, ${phone}. One reminder a day at most.`}
      submitLabel="Send reminder"
      action={action}
    >
      {() => (
        <figure className="rounded-lg border border-line bg-subtle px-4 py-3">
          <figcaption className="mb-1 text-sm text-ink-3">They will receive</figcaption>
          <p className="text-base break-words text-ink">{preview}</p>
          <p className="mt-2 text-sm text-ink-3">
            The link shows the balance, without signing in, for 7 days.
          </p>
        </figure>
      )}
    </FormDialog>
  );
}
