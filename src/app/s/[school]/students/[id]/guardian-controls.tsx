"use client";

import { Plus } from "lucide-react";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { GuardianFields } from "../student-forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function AddGuardianDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger={
        <>
          <Plus aria-hidden="true" />
          Add guardian
        </>
      }
      triggerVariant="ghost"
      triggerSize="sm"
      title="Add guardian"
      description="If the school already has this phone number, the student is linked to that guardian."
      submitLabel="Add guardian"
      action={action}
    >
      {(state) => (
        <>
          <GuardianFields state={state} withEmail />
          <label className="flex items-center gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              name="isPrimary"
              className="size-4 accent-ink"
              defaultChecked={state.values?.isPrimary === "on"}
            />
            Make this the primary contact
          </label>
        </>
      )}
    </FormDialog>
  );
}

export function EditGuardianDialog({
  action,
  guardian,
}: {
  action: Action;
  guardian: { fullName: string; phone: string | null; email: string | null };
}) {
  return (
    <FormDialog
      trigger="Edit"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Edit ${guardian.fullName}`}
      title={`Edit ${guardian.fullName}`}
      description="Changes apply to every student this guardian is linked to."
      submitLabel="Save"
      action={action}
    >
      {(state) => <GuardianFields state={state} defaults={guardian} withRelationship={false} withEmail />}
    </FormDialog>
  );
}

export function MakePrimaryButton({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Make primary"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Make ${name} the primary contact`}
      title={`Make ${name} the primary contact?`}
      description="Fee reminders and messages about this student will go to them."
      submitLabel="Make primary"
      action={action}
    />
  );
}

export function RemoveGuardianButton({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Remove"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Remove ${name}`}
      title={`Remove ${name} from this student?`}
      description="Their details stay with any other children they are linked to."
      submitLabel="Remove"
      danger
      action={action}
    />
  );
}
