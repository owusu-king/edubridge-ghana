"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { FormMessage } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { besideField, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Disclosure } from "@/components/ui/disclosure";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  STAFF_ATTENDANCE_LABELS,
  STAFF_ATTENDANCE_MARKS,
  type StaffAttendanceMark,
} from "@/lib/staff";
import type { FormState } from "@/web/forms";
import type { StaffDaySaved } from "./actions";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
export interface Option {
  value: string;
  label: string;
}

export interface DetailValues {
  firstName: string;
  lastName: string;
  otherNames: string | null;
  sex: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  qualifications: string | null;
  emergencyName: string | null;
  emergencyRelationship: string | null;
  emergencyPhone: string | null;
}

const EXTRA_FIELDS = [
  "address",
  "qualifications",
  "emergencyName",
  "emergencyRelationship",
  "emergencyPhone",
];

/**
 * A staff member's personal details. With `foldExtras` (adding someone), the address, qualifications and
 * emergency contact sit behind "More details", opened when any of them has a value or an error.
 */
function DetailFields({
  state,
  values,
  foldExtras = false,
}: {
  state: FormState;
  values?: DetailValues;
  foldExtras?: boolean;
}) {
  const e = state.fieldErrors ?? {};
  const v = (k: keyof DetailValues) => state.values?.[k] ?? values?.[k] ?? "";
  const extrasInUse = EXTRA_FIELDS.some((k) => state.values?.[k]?.trim() || e[k]);
  const core = (
    <div className="grid gap-5 sm:grid-cols-3">
      <Field label="First name" error={e.firstName}>
        {(p) => <Input {...p} name="firstName" maxLength={80} defaultValue={v("firstName")} required />}
      </Field>
      <Field label="Other names" error={e.otherNames}>
        {(p) => <Input {...p} name="otherNames" maxLength={80} defaultValue={v("otherNames")} />}
      </Field>
      <Field label="Surname" error={e.lastName}>
        {(p) => <Input {...p} name="lastName" maxLength={80} defaultValue={v("lastName")} required />}
      </Field>
      <Field label="Sex" error={e.sex}>
        {(p) => (
          <Select {...p} name="sex" defaultValue={v("sex")}>
            <option value="">Not given</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </Select>
        )}
      </Field>
      <Field label="Date of birth" error={e.dateOfBirth}>
        {(p) => <Input {...p} name="dateOfBirth" type="date" defaultValue={v("dateOfBirth")} />}
      </Field>
      <Field label="Phone" error={e.phone}>
        {(p) => <Input {...p} name="phone" type="tel" inputMode="tel" defaultValue={v("phone")} />}
      </Field>
      <Field label="Email" error={e.email} className="sm:col-span-2">
        {(p) => <Input {...p} name="email" type="email" defaultValue={v("email")} />}
      </Field>
    </div>
  );
  const extrasBody = (
    <>
      <Field label="Address" error={e.address}>
        {(p) => <Input {...p} name="address" maxLength={300} defaultValue={v("address")} />}
      </Field>
      <Field
        label="Qualifications"
        description="For example certificates and teaching licence."
        error={e.qualifications}
      >
        {(p) => (
          <Textarea
            {...p}
            name="qualifications"
            rows={2}
            maxLength={500}
            defaultValue={v("qualifications")}
          />
        )}
      </Field>
      <fieldset className="grid gap-5 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium text-ink">Emergency contact</legend>
        <Field label="Name" error={e.emergencyName}>
          {(p) => <Input {...p} name="emergencyName" maxLength={120} defaultValue={v("emergencyName")} />}
        </Field>
        <Field label="Relationship" error={e.emergencyRelationship}>
          {(p) => (
            <Input
              {...p}
              name="emergencyRelationship"
              maxLength={60}
              defaultValue={v("emergencyRelationship")}
            />
          )}
        </Field>
        <Field label="Phone" error={e.emergencyPhone}>
          {(p) => (
            <Input
              {...p}
              name="emergencyPhone"
              type="tel"
              inputMode="tel"
              defaultValue={v("emergencyPhone")}
            />
          )}
        </Field>
      </fieldset>
    </>
  );
  return (
    <>
      {core}
      {foldExtras ? (
        <Disclosure title="More details" open={extrasInUse}>
          {extrasBody}
        </Disclosure>
      ) : (
        extrasBody
      )}
    </>
  );
}

export interface EmploymentOptions {
  departments: Option[];
  positions: Option[];
  campuses: Option[];
}

function EmploymentFields({
  state,
  options,
  values,
}: {
  state: FormState;
  options: EmploymentOptions;
  values?: {
    employmentType: string;
    departmentId: string | null;
    positionId: string | null;
    campusId: string | null;
  };
}) {
  const e = state.fieldErrors ?? {};
  const v = (k: "employmentType" | "departmentId" | "positionId" | "campusId") =>
    state.values?.[k] ?? values?.[k] ?? "";
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Employment" error={e.employmentType}>
        {(p) => (
          <Select {...p} name="employmentType" defaultValue={v("employmentType") || "permanent"}>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Position" error={e.positionId}>
        {(p) => (
          <Select {...p} name="positionId" defaultValue={v("positionId")}>
            <option value="">None</option>
            {options.positions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Department" error={e.departmentId}>
        {(p) => (
          <Select {...p} name="departmentId" defaultValue={v("departmentId")}>
            <option value="">None</option>
            {options.departments.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {options.campuses.length > 1 && (
        <Field label="Campus" error={e.campusId}>
          {(p) => (
            <Select {...p} name="campusId" defaultValue={v("campusId")}>
              <option value="">Not one campus</option>
              {options.campuses.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}

export function AddStaffDialog({
  action,
  options,
  today,
}: {
  action: Action;
  options: EmploymentOptions;
  today: string;
}) {
  return (
    <FormDialog
      trigger="Add staff"
      triggerVariant="primary"
      title="Add a staff member"
      description="Anyone who works at the school, with or without an EduBridge account. A staff number is given."
      submitLabel="Add staff member"
      size="lg"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <DetailFields state={state} foldExtras />
          <EmploymentFields state={state} options={options} />
          <Field label="Started" error={state.fieldErrors?.startedOn}>
            {(p) => (
              <Input
                {...p}
                name="startedOn"
                type="date"
                defaultValue={state.values?.startedOn ?? today}
                required
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function EditDetailsDialog({ action, values }: { action: Action; values: DetailValues }) {
  return (
    <FormDialog
      trigger="Edit details"
      title="Personal details"
      submitLabel="Save details"
      size="lg"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <DetailFields state={state} values={values} />
        </div>
      )}
    </FormDialog>
  );
}

const EMPLOYMENT_COPY = {
  changed: {
    trigger: "Change employment",
    title: "Change employment",
    description:
      "A new position, department, campus or type of employment, from a date. The history is kept.",
    submit: "Save change",
  },
  left: {
    trigger: "Record leaving",
    title: "Record leaving",
    description: "The last working day and why. Their records are kept, and they can return later.",
    submit: "Record leaving",
  },
  returned: {
    trigger: "Record return",
    title: "Record their return",
    description: "The first working day back and their employment from then.",
    submit: "Record return",
  },
} as const;

export function EmploymentDialog({
  action,
  kind,
  options,
  values,
  today,
}: {
  action: Action;
  kind: "changed" | "left" | "returned";
  options: EmploymentOptions;
  values: {
    employmentType: string;
    departmentId: string | null;
    positionId: string | null;
    campusId: string | null;
  };
  today: string;
}) {
  const copy = EMPLOYMENT_COPY[kind];
  return (
    <FormDialog
      trigger={copy.trigger}
      title={copy.title}
      description={copy.description}
      submitLabel={copy.submit}
      danger={kind === "left"}
      size="lg"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          {kind === "left" ? (
            <input type="hidden" name="employmentType" value={values.employmentType} />
          ) : (
            <EmploymentFields state={state} options={options} values={values} />
          )}
          <Field label={kind === "left" ? "Last working day" : "From"} error={state.fieldErrors?.effectiveOn}>
            {(p) => (
              <Input
                {...p}
                name="effectiveOn"
                type="date"
                defaultValue={state.values?.effectiveOn ?? today}
                required
              />
            )}
          </Field>
          <Field
            label={kind === "left" ? "Why they left" : "Note (optional)"}
            error={state.fieldErrors?.note}
          >
            {(p) => (
              <Textarea {...p} name="note" rows={2} maxLength={300} defaultValue={state.values?.note} />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function LinkMemberDialog({
  action,
  members,
  current,
}: {
  action: Action;
  members: Option[];
  current: string | null;
}) {
  return (
    <FormDialog
      trigger={current ? "Change account" : "Link an account"}
      title="EduBridge account"
      description="The member's account at this school, so they can ask for their own leave. One staff record per member."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <Field label="Member" error={state.fieldErrors?.membershipId}>
          {(p) => (
            <Select {...p} name="membershipId" defaultValue={current ?? ""}>
              <option value="">No account</option>
              {members.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function RecordLeaveDialog({
  action,
  types,
  today,
}: {
  action: Action;
  types: Option[];
  today: string;
}) {
  return (
    <FormDialog
      trigger="Record leave"
      title="Record leave"
      description="Approved as you record it. Days are working days, Monday to Friday, less the school's holidays."
      submitLabel="Record leave"
      action={action}
    >
      {(state) => <LeaveFields state={state} types={types} today={today} confirm />}
    </FormDialog>
  );
}

export function LeaveFields({
  state,
  types,
  today,
  confirm = false,
}: {
  state: FormState;
  types: Option[];
  today: string;
  confirm?: boolean;
}) {
  const e = state.fieldErrors ?? {};
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Leave" error={e.leaveTypeId} className="sm:col-span-2">
        {(p) => (
          <Select {...p} name="leaveTypeId" defaultValue={state.values?.leaveTypeId ?? ""} required>
            <option value="" disabled>
              Choose
            </option>
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="First day" error={e.startsOn}>
        {(p) => (
          <Input {...p} name="startsOn" type="date" defaultValue={state.values?.startsOn ?? today} required />
        )}
      </Field>
      <Field label="Last day" error={e.endsOn}>
        {(p) => (
          <Input {...p} name="endsOn" type="date" defaultValue={state.values?.endsOn ?? today} required />
        )}
      </Field>
      <Field label="Reason" optional error={e.reason} className="sm:col-span-2">
        {(p) => (
          <Textarea {...p} name="reason" rows={2} maxLength={300} defaultValue={state.values?.reason} />
        )}
      </Field>
      {confirm && e.confirmOverBalance && (
        <label className="flex items-start gap-2 text-base text-ink sm:col-span-2">
          <input type="checkbox" name="confirmOverBalance" className="mt-1 size-4 accent-accent" />
          <span>Record it beyond the year&apos;s allowance</span>
        </label>
      )}
    </div>
  );
}

/** Adds a department or position by name. */
export function AddNameForm({ action, label }: { action: Action; label: string }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-3" noValidate>
      <Field label={label} error={state.fieldErrors?.name} className="min-w-0 grow basis-56 sm:max-w-xs">
        {(p) => (
          <Input
            {...p}
            name="name"
            maxLength={80}
            required
            defaultValue={state.status === "error" ? state.values?.name : undefined}
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" className={besideField} pending={pending}>
        Add
      </Button>
    </form>
  );
}

export function LeaveTypeDialog({
  action,
  values,
}: {
  action: Action;
  values?: { name: string; daysPerYear: number | null; paid: boolean };
}) {
  return (
    <FormDialog
      trigger={values ? "Edit" : "Add a leave type"}
      triggerSize={values ? "sm" : "md"}
      triggerLabel={values ? `Edit ${values.name}` : undefined}
      title={values ? `Edit ${values.name}` : "Add a leave type"}
      description="Changing the days a year changes balances from now on; leave already approved stays as it is."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name" error={state.fieldErrors?.name} className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                name="name"
                maxLength={60}
                defaultValue={state.values?.name ?? values?.name}
                required
              />
            )}
          </Field>
          <Field
            label="Working days a year"
            description="Empty for no limit."
            error={state.fieldErrors?.daysPerYear}
          >
            {(p) => (
              <Input
                {...p}
                name="daysPerYear"
                type="number"
                inputMode="numeric"
                min={0}
                max={366}
                defaultValue={state.values?.daysPerYear ?? values?.daysPerYear ?? ""}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-base text-ink">
            <input
              type="checkbox"
              name="paid"
              defaultChecked={values?.paid ?? true}
              className="size-4 accent-accent"
            />
            Paid leave
          </label>
        </div>
      )}
    </FormDialog>
  );
}

// ——— Staff attendance sheet (HR-04) ———

export interface SheetRow {
  staffId: string;
  staffNumber: string;
  name: string;
  position: string | null;
  onLeave: string | null;
  mark: { status: StaffAttendanceMark; note: string | null; version: number; by: string } | null;
}

export function StaffAttendanceSheet({
  date,
  rows,
  save,
}: {
  date: string;
  rows: SheetRow[];
  save: (
    date: string,
    marks: { staffId: string; status: string; note: string; version: number }[],
  ) => Promise<FormState<StaffDaySaved>>;
}) {
  const [marks, setMarks] = useState<Record<string, StaffAttendanceMark | undefined>>(() =>
    Object.fromEntries(rows.map((r) => [r.staffId, r.mark?.status])),
  );
  const [result, setResult] = useState<FormState<StaffDaySaved> | null>(null);
  const [pending, start] = useTransition();
  const changed = rows.filter((r) => !r.onLeave && marks[r.staffId] && marks[r.staffId] !== r.mark?.status);
  const unmarked = rows.filter((r) => !r.onLeave && !marks[r.staffId]).length;

  const submit = () =>
    start(async () => {
      setResult(
        await save(
          date,
          changed.map((r) => ({
            staffId: r.staffId,
            status: marks[r.staffId]!,
            note: r.mark?.note ?? "",
            version: r.mark?.version ?? 0,
          })),
        ),
      );
    });
  const markAll = () =>
    setMarks((m) =>
      Object.fromEntries(rows.map((r) => [r.staffId, r.onLeave ? undefined : (m[r.staffId] ?? "present")])),
    );

  return (
    <div className="space-y-4">
      {/* A plain save or an error is a toast; marks changed meanwhile stay here to be reviewed. */}
      {result && !result.data?.conflicts.length && <FormMessage state={result} />}
      {result?.data?.conflicts.length ? <Alert tone="info">{result.message}</Alert> : null}
      {result?.data?.conflicts.length ? (
        <ul className="space-y-1 text-sm text-ink-2" aria-label="Changed meanwhile">
          {result.data.conflicts.map((c) => (
            <li key={c.staffId}>
              {c.name}: {c.theirs.by} marked {STAFF_ATTENDANCE_LABELS[c.theirs.status].toLowerCase()}; you
              chose {STAFF_ATTENDANCE_LABELS[c.yours].toLowerCase()}. Their mark is shown; change it again if
              needed.
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          {unmarked ? `${unmarked} not marked yet.` : "Everyone is marked."} {changed.length} to save.
        </p>
        <div className="flex gap-2">
          {unmarked > 0 && (
            <Button variant="secondary" onClick={markAll}>
              Mark the rest present
            </Button>
          )}
          <Button variant="primary" onClick={submit} pending={pending} disabled={!changed.length}>
            Save
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((r) => (
          <li
            key={r.staffId}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="text-base text-ink">{r.name}</p>
              <p className="text-sm text-ink-3">
                {[r.staffNumber, r.position].filter(Boolean).join(" · ")}
                {r.mark && !r.onLeave ? ` · marked by ${r.mark.by}` : ""}
              </p>
            </div>
            {r.onLeave ? (
              <p className="text-sm text-ink-2">On leave: {r.onLeave}</p>
            ) : (
              <fieldset className="grid grid-cols-4 gap-1.5 sm:w-96">
                <legend className="sr-only">{r.name}</legend>
                {STAFF_ATTENDANCE_MARKS.map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex h-11 cursor-pointer items-center justify-center rounded-md border text-sm font-medium transition-colors select-none",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent/40",
                      marks[r.staffId] === m
                        ? m === "present"
                          ? "border-positive bg-positive-soft text-positive"
                          : m === "late"
                            ? "border-caution bg-caution-soft text-caution"
                            : m === "absent"
                              ? "border-critical bg-critical-soft text-critical"
                              : "border-accent bg-accent-soft text-accent"
                        : "border-line-strong bg-surface text-ink-2 hover:bg-subtle",
                    )}
                  >
                    <input
                      type="radio"
                      name={`mark-${r.staffId}`}
                      value={m}
                      checked={marks[r.staffId] === m}
                      onChange={() => setMarks((all) => ({ ...all, [r.staffId]: m }))}
                      aria-label={`${r.name}: ${STAFF_ATTENDANCE_LABELS[m]}`}
                      className="sr-only"
                    />
                    {STAFF_ATTENDANCE_LABELS[m]}
                  </label>
                ))}
              </fieldset>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
