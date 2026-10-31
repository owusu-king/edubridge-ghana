"use client";

import { Plus } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
export interface ClassOption {
  id: string;
  name: string;
}
interface StudentDefaults {
  firstName?: string;
  otherNames?: string | null;
  lastName?: string;
  sex?: string;
  dateOfBirth?: string | null;
  admissionNumber?: string;
}

function StudentFields({
  state,
  defaults = {},
  autoNumber,
}: {
  state: FormState;
  defaults?: StudentDefaults;
  autoNumber: boolean;
}) {
  const v = state.values ?? {};
  const e = state.fieldErrors ?? {};
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" error={e.firstName}>
          {(p) => (
            <Input
              {...p}
              name="firstName"
              defaultValue={v.firstName ?? defaults.firstName}
              required
              maxLength={60}
              autoComplete="off"
            />
          )}
        </Field>
        <Field label="Surname" error={e.lastName}>
          {(p) => (
            <Input
              {...p}
              name="lastName"
              defaultValue={v.lastName ?? defaults.lastName}
              required
              maxLength={60}
              autoComplete="off"
            />
          )}
        </Field>
      </div>
      <Field label="Other names" description="Optional." error={e.otherNames}>
        {(p) => (
          <Input
            {...p}
            name="otherNames"
            defaultValue={v.otherNames ?? defaults.otherNames ?? ""}
            maxLength={60}
            autoComplete="off"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sex" error={e.sex}>
          {(p) => (
            <Select {...p} name="sex" defaultValue={v.sex ?? defaults.sex ?? ""} required>
              <option value="" disabled>
                Choose
              </option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </Select>
          )}
        </Field>
        <Field label="Date of birth" description="Optional." error={e.dateOfBirth}>
          {(p) => (
            <Input
              {...p}
              name="dateOfBirth"
              type="date"
              defaultValue={v.dateOfBirth ?? defaults.dateOfBirth ?? ""}
            />
          )}
        </Field>
      </div>
      <Field
        label="Admission number"
        description={autoNumber ? "Leave empty to number automatically." : undefined}
        error={e.admissionNumber}
      >
        {(p) => (
          <Input
            {...p}
            name="admissionNumber"
            defaultValue={v.admissionNumber ?? defaults.admissionNumber ?? ""}
            maxLength={30}
            autoComplete="off"
          />
        )}
      </Field>
    </>
  );
}

function ClassSelect({
  classes,
  state,
  defaultValue,
  allowNone,
}: {
  classes: ClassOption[];
  state: FormState;
  defaultValue?: string;
  allowNone: boolean;
}) {
  return (
    <Field label="Class this term" error={state.fieldErrors?.classId}>
      {(p) => (
        <Select {...p} name="classId" defaultValue={state.values?.classId ?? defaultValue ?? ""}>
          {allowNone && <option value="">Not in a class yet</option>}
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

const RELATIONSHIPS = [
  ["mother", "Mother"],
  ["father", "Father"],
  ["guardian", "Guardian"],
  ["grandparent", "Grandparent"],
  ["sibling", "Older sibling"],
  ["other", "Other"],
] as const;

/** Guardian name, phone and relationship. `prefix` namespaces the field names (e.g. guardianFullName). */
export function GuardianFields({
  state,
  prefix = "",
  legend,
  defaults = {},
  withRelationship = true,
  withEmail = false,
}: {
  state: FormState;
  prefix?: string;
  legend?: string;
  defaults?: { fullName?: string; phone?: string | null; email?: string | null };
  withRelationship?: boolean;
  withEmail?: boolean;
}) {
  const name = (field: string) => (prefix ? `${prefix}${field[0]!.toUpperCase()}${field.slice(1)}` : field);
  const v = state.values ?? {};
  const e = state.fieldErrors ?? {};
  const fields = (
    <>
      <Field label="Full name" error={e[name("fullName")]}>
        {(p) => (
          <Input
            {...p}
            name={name("fullName")}
            defaultValue={v[name("fullName")] ?? defaults.fullName ?? ""}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone number" description="For example 024 123 4567." error={e[name("phone")]}>
          {(p) => (
            <Input
              {...p}
              name={name("phone")}
              type="tel"
              inputMode="tel"
              defaultValue={v[name("phone")] ?? defaults.phone ?? ""}
              autoComplete="off"
            />
          )}
        </Field>
        {withRelationship && (
          <Field label="Relationship" error={e[name("relationship")]}>
            {(p) => (
              <Select {...p} name={name("relationship")} defaultValue={v[name("relationship")] ?? "mother"}>
                {RELATIONSHIPS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      {withEmail && (
        <Field label="Email" description="Optional." error={e[name("email")]}>
          {(p) => (
            <Input
              {...p}
              name={name("email")}
              type="email"
              defaultValue={v[name("email")] ?? defaults.email ?? ""}
              autoComplete="off"
            />
          )}
        </Field>
      )}
    </>
  );
  if (!legend) return fields;
  return (
    <fieldset className="space-y-4 border-t border-line pt-5">
      <legend className="pr-2 text-sm font-medium text-ink">{legend}</legend>
      {fields}
    </fieldset>
  );
}

export function AddStudentDialog({
  action,
  classes,
  defaultClassId,
}: {
  action: Action;
  classes: ClassOption[];
  defaultClassId?: string;
}) {
  return (
    <FormDialog
      trigger={
        <>
          <Plus aria-hidden="true" />
          Add student
        </>
      }
      triggerVariant="primary"
      title="Add student"
      submitLabel="Add student"
      action={action}
    >
      {(state) => (
        <>
          <StudentFields state={state} autoNumber />
          <ClassSelect classes={classes} state={state} defaultValue={defaultClassId} allowNone />
          <GuardianFields state={state} prefix="guardian" legend="Primary contact (optional)" />
        </>
      )}
    </FormDialog>
  );
}

export function EditStudentDialog({ action, defaults }: { action: Action; defaults: StudentDefaults }) {
  return (
    <FormDialog trigger="Edit details" title="Edit details" submitLabel="Save" action={action}>
      {(state) => <StudentFields state={state} defaults={defaults} autoNumber={false} />}
    </FormDialog>
  );
}

export function ChangeClassDialog({
  action,
  classes,
  currentClassId,
}: {
  action: Action;
  classes: ClassOption[];
  currentClassId?: string;
}) {
  return (
    <FormDialog
      trigger={currentClassId ? "Change class" : "Place in a class"}
      title={currentClassId ? "Change class" : "Place in a class"}
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <ClassSelect
          classes={classes}
          state={state}
          defaultValue={currentClassId ?? classes[0]?.id}
          allowNone={false}
        />
      )}
    </FormDialog>
  );
}

export function StatusDialog({
  action,
  status,
  name,
}: {
  action: Action;
  status: "active" | "withdrawn" | "graduated";
  name: string;
}) {
  if (status !== "active") {
    return (
      <FormDialog
        trigger="Reactivate"
        title={`Reactivate ${name}?`}
        description="They return to the active student list. Place them in a class afterwards."
        submitLabel="Reactivate"
        action={action}
      />
    );
  }
  return (
    <FormDialog
      trigger="Withdraw"
      triggerVariant="ghost"
      title={`Withdraw ${name}?`}
      description="Use this when a student leaves the school. Their records are kept and they leave this term's class."
      submitLabel="Withdraw student"
      danger
      action={action}
    />
  );
}
