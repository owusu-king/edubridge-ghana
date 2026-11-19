"use client";

import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { VISIT_PURPOSES, VISIT_PURPOSE_LABELS } from "@/lib/visitors";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Signing a visitor in (VIS-01a). The time is the server's. */
export function SignInDialog({
  action,
  hosts,
  campuses,
}: {
  action: Action;
  hosts: { id: string; name: string }[];
  campuses: { id: string; name: string }[];
}) {
  return (
    <FormDialog
      trigger="Sign in a visitor"
      triggerVariant="primary"
      title="Sign in a visitor"
      description="Signed in now. Sign them out when they leave."
      submitLabel="Sign in"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.fullName}>
              {(p) => <Input {...p} name="fullName" maxLength={120} defaultValue={v.fullName} required />}
            </Field>
            <Field label="Phone" optional error={e.phone}>
              {(p) => <Input {...p} name="phone" type="tel" inputMode="tel" defaultValue={v.phone} />}
            </Field>
            <Field label="Purpose" error={e.purpose}>
              {(p) => (
                <Select {...p} name="purpose" defaultValue={v.purpose ?? ""} required>
                  <option value="" disabled>
                    Choose
                  </option>
                  {VISIT_PURPOSES.map((k) => (
                    <option key={k} value={k}>
                      {VISIT_PURPOSE_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Organisation" optional error={e.organisation}>
              {(p) => <Input {...p} name="organisation" maxLength={120} defaultValue={v.organisation} />}
            </Field>
            <Field label="Visiting" error={e.hostMembershipId}>
              {(p) => (
                <Select {...p} name="hostMembershipId" defaultValue={v.hostMembershipId ?? ""}>
                  <option value="">Nobody in particular, or written below</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Or write who" optional error={e.hostName}>
              {(p) => <Input {...p} name="hostName" maxLength={120} defaultValue={v.hostName} />}
            </Field>
            {campuses.length > 0 && (
              <Field label="Campus" error={e.campusId}>
                {(p) => (
                  <Select
                    {...p}
                    name="campusId"
                    defaultValue={v.campusId ?? (campuses.length === 1 ? campuses[0]!.id : "")}
                    required
                  >
                    <option value="" disabled>
                      Choose
                    </option>
                    {campuses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Badge number" optional error={e.badge}>
              {(p) => <Input {...p} name="badge" maxLength={20} defaultValue={v.badge} />}
            </Field>
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Textarea {...p} name="note" rows={2} maxLength={500} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}
