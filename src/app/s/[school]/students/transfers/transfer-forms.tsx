"use client";

import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
interface Option {
  id: string;
  name: string;
}

/** The receiving school asks another school for a child's records. */
export function RequestTransferDialog({ action, schools }: { action: Action; schools: Option[] }) {
  return (
    <FormDialog
      trigger="Request a child's records"
      triggerVariant="primary"
      title="Request a child's records"
      description="For a child joining from another school on EduBridge. The family confirms in the parent view, using the number the other school has for them; then that school decides. You are not told whether the child was found until then."
      submitLabel="Send request"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values;
        return (
          <div className="space-y-5">
            <Field label="School the child is leaving" error={e.fromSchoolId}>
              {(p) => (
                <Select {...p} name="fromSchoolId" defaultValue={v?.fromSchoolId ?? ""} required>
                  <option value="" disabled>
                    Choose a school
                  </option>
                  {schools.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Child's first name" error={e.firstName}>
                {(p) => <Input {...p} name="firstName" maxLength={60} defaultValue={v?.firstName} required />}
              </Field>
              <Field label="Surname" error={e.lastName}>
                {(p) => <Input {...p} name="lastName" maxLength={60} defaultValue={v?.lastName} required />}
              </Field>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Date of birth (optional)" error={e.dateOfBirth}>
                {(p) => <Input {...p} name="dateOfBirth" type="date" defaultValue={v?.dateOfBirth} />}
              </Field>
              <Field label="Guardian's mobile number" error={e.guardianPhone}>
                {(p) => (
                  <Input
                    {...p}
                    name="guardianPhone"
                    inputMode="tel"
                    defaultValue={v?.guardianPhone}
                    required
                  />
                )}
              </Field>
            </div>
          </div>
        );
      }}
    </FormDialog>
  );
}

export function ApproveTransferDialog({
  action,
  child,
  balance,
}: {
  action: Action;
  child: string;
  balance: string | null;
}) {
  return (
    <FormDialog
      trigger="Approve"
      triggerSize="sm"
      triggerLabel={`Approve the transfer of ${child}`}
      title={`Approve the transfer of ${child}?`}
      description="A signed learner record (classes, published report cards, attendance and guardians) is sent to the new school, and the student is marked as transferred here. Their records stay at your school."
      submitLabel="Approve and send record"
      action={action}
    >
      {() =>
        balance ? (
          <p className="text-base text-ink-2">
            The family owes <strong>{balance}</strong>. Approving does not change the balance; it stays on the
            student&apos;s account.
          </p>
        ) : (
          <p className="text-base text-ink-2">The family owes nothing.</p>
        )
      }
    </FormDialog>
  );
}

export function DeclineTransferDialog({ action, child }: { action: Action; child: string }) {
  return (
    <FormDialog
      trigger="Decline"
      triggerSize="sm"
      triggerLabel={`Decline the transfer of ${child}`}
      title={`Decline the transfer of ${child}?`}
      description="The new school sees your reason."
      submitLabel="Decline"
      danger
      action={action}
    >
      {(state) => (
        <Field label="Reason" error={state.fieldErrors?.reason}>
          {(p) => (
            <Textarea
              {...p}
              name="reason"
              rows={3}
              maxLength={300}
              defaultValue={state.values?.reason}
              required
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function AcceptTransferDialog({
  action,
  child,
  classes,
}: {
  action: Action;
  child: string;
  classes: Option[];
}) {
  return (
    <FormDialog
      trigger="Enrol"
      triggerVariant="primary"
      triggerSize="sm"
      triggerLabel={`Enrol ${child}`}
      title={`Enrol ${child}`}
      description="The record's signature is checked first. The child is added with their guardians, their learner identity and the record from their previous school."
      submitLabel="Enrol"
      action={action}
    >
      {(state) => (
        <Field label="Class this term (optional)" error={state.fieldErrors?.classId}>
          {(p) => (
            <Select {...p} name="classId" defaultValue={state.values?.classId ?? ""}>
              <option value="">Not yet</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function CancelTransferDialog({ action, child }: { action: Action; child: string }) {
  return (
    <FormDialog
      trigger="Withdraw"
      triggerSize="sm"
      triggerLabel={`Withdraw the request for ${child}`}
      title={`Withdraw the request for ${child}?`}
      submitLabel="Withdraw request"
      danger
      action={action}
    >
      {() => <p className="text-base text-ink-2">The other school and the family will no longer see it.</p>}
    </FormDialog>
  );
}

/** Importing a learner record file (from a school on EduBridge or elsewhere). */
export function ImportRecordDialog({ action, classes }: { action: Action; classes: Option[] }) {
  return (
    <FormDialog
      trigger="Import a record file"
      title="Import a learner record"
      description="A record downloaded from another school. Records signed by EduBridge are checked and marked verified; files without a signature are kept as unverified; changed files are refused. A new student is created from it."
      submitLabel="Import"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="Record file (.json)" error={state.fieldErrors?.file}>
            {(p) => <Input {...p} name="file" type="file" accept="application/json,.json" required />}
          </Field>
          <Field label="Class this term (optional)" error={state.fieldErrors?.classId}>
            {(p) => (
              <Select {...p} name="classId" defaultValue="">
                <option value="">Not yet</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}
