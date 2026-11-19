"use client";

import type { Route } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { STATUS_CHANGES, STUDENT_STATUS_LABELS, type StudentStatus } from "@/lib/students";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Disclosure } from "@/components/ui/disclosure";
import { FormDialog } from "@/components/ui/form-dialog";
import type { ReactNode } from "react";
import type { FormState } from "@/web/forms";
import type { RegisterState } from "./actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
export interface ClassOption {
  id: string;
  name: string;
}
interface StudentDefaults {
  firstName?: string;
  otherNames?: string | null;
  preferredName?: string | null;
  lastName?: string;
  sex?: string;
  dateOfBirth?: string | null;
  admissionNumber?: string;
}

/**
 * A student's own details, two to a row: names, then sex and date of birth, then (for a new student) the
 * class this term and the admission number. `classSelect` sits beside the admission number when given.
 */
function StudentFields({
  state,
  defaults = {},
  autoNumber,
  classSelect,
}: {
  state: FormState<unknown>;
  defaults?: StudentDefaults;
  autoNumber: boolean;
  classSelect?: ReactNode;
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
        <Field label="Other names" optional error={e.otherNames}>
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
        <Field label="Known as" optional error={e.preferredName}>
          {(p) => (
            <Input
              {...p}
              name="preferredName"
              defaultValue={v.preferredName ?? defaults.preferredName ?? ""}
              placeholder="If different"
              maxLength={60}
              autoComplete="off"
            />
          )}
        </Field>
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
        <Field label="Date of birth" optional error={e.dateOfBirth}>
          {(p) => (
            <Input
              {...p}
              name="dateOfBirth"
              type="date"
              defaultValue={v.dateOfBirth ?? defaults.dateOfBirth ?? ""}
            />
          )}
        </Field>
        {classSelect}
        <Field
          label="Admission number"
          optional={autoNumber}
          error={e.admissionNumber}
          className={classSelect ? undefined : "sm:col-span-2"}
        >
          {(p) => (
            <Input
              {...p}
              name="admissionNumber"
              defaultValue={v.admissionNumber ?? defaults.admissionNumber ?? ""}
              placeholder={autoNumber ? "Automatic" : undefined}
              maxLength={30}
              autoComplete="off"
            />
          )}
        </Field>
      </div>
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
  state: FormState<unknown>;
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
  state: FormState<unknown>;
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

/** The guardian section has something typed in it, or an error to show. */
function guardianInUse(state: FormState<unknown>): boolean {
  const typed = ["guardianFullName", "guardianPhone"].some((k) => state.values?.[k]?.trim());
  return typed || Object.keys(state.fieldErrors ?? {}).some((k) => k.startsWith("guardian"));
}

/**
 * Adding one student from the students list: their details, a class and an optional first guardian. A
 * possible duplicate comes back to be confirmed; registering several children, or offline, has its own page.
 */
export function AddStudentDialog({
  action,
  classes,
  defaultClassId,
  registerHref,
}: {
  action: (prev: RegisterState, formData: FormData) => Promise<RegisterState>;
  classes: ClassOption[];
  /** Preselected when the list is showing one class. */
  defaultClassId?: string;
  /** The registration page that also works offline. */
  registerHref: string;
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
      title="Add a student"
      submitLabel="Add student"
      size="lg"
      action={action}
    >
      {(state) => (
        <>
          {state.data?.duplicates.length ? (
            <div className="space-y-3 rounded-lg border border-caution/25 bg-caution-soft px-4 py-3">
              <p className="text-sm text-ink">
                <strong className="font-semibold">This child may already be on record:</strong>
              </p>
              <ul className="space-y-0.5 text-sm text-ink-2">
                {state.data.duplicates.map((d) => (
                  <li key={d.id}>
                    {d.name}, {d.admissionNumber}
                    {d.dateOfBirth ? `, born ${d.dateOfBirth}` : ""}
                    {d.status !== "active" ? ` (${STUDENT_STATUS_LABELS[d.status]})` : ""}
                  </li>
                ))}
              </ul>
              <label className="flex items-start gap-2.5 text-sm text-ink">
                <input type="checkbox" name="confirmDuplicate" className="mt-0.5 size-4 accent-accent" />
                This is a different child. Add them anyway.
              </label>
            </div>
          ) : null}
          <StudentFields
            state={state}
            autoNumber
            classSelect={
              <ClassSelect classes={classes} state={state} defaultValue={defaultClassId} allowNone />
            }
          />
          {/* Open when the guardian has values or errors coming back, so nothing is hidden. */}
          <Disclosure title="Add a guardian" open={guardianInUse(state)}>
            <GuardianFields state={state} prefix="guardian" />
          </Disclosure>
          <p className="text-sm text-ink-3">
            Several children, or a weak connection?{" "}
            <Link href={registerHref as Route} className="font-medium text-accent hover:underline">
              Use the registration page
            </Link>
            , which works offline.
          </p>
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
  status: StudentStatus;
  name: string;
}) {
  const choices = STATUS_CHANGES[status];
  return (
    <FormDialog
      trigger={status === "active" ? "Change status" : "Reactivate or change"}
      triggerVariant="ghost"
      title={`Change the status of ${name}`}
      description="Suspended students stay in their class. Students who leave (withdrawn, transferred, graduated) leave this term's class; their records are kept."
      submitLabel="Change status"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="New status" error={state.fieldErrors?.status}>
            {(p) => (
              <Select {...p} name="status" defaultValue={state.values?.status ?? choices[0]}>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {STUDENT_STATUS_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Reason"
            description="Required, except when reactivating."
            error={state.fieldErrors?.reason}
          >
            {(p) => (
              <Textarea {...p} name="reason" rows={2} maxLength={200} defaultValue={state.values?.reason} />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}
