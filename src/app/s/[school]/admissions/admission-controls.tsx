"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { FormMessage } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { useFormAction } from "@/components/ui/use-form-action";
import { APPLICATION_SOURCE_LABELS, APPLICATION_SOURCES } from "@/lib/admissions";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
interface Option {
  id: string;
  name: string;
}

const RELATIONSHIPS = [
  ["mother", "Mother"],
  ["father", "Father"],
  ["guardian", "Guardian"],
  ["grandparent", "Grandparent"],
  ["sibling", "Brother or sister"],
  ["other", "Other"],
] as const;

export interface ApplicantValues {
  childFirstName?: string | null;
  childOtherNames?: string | null;
  childLastName?: string | null;
  sex?: string | null;
  dateOfBirth?: string | null;
  previousSchool?: string | null;
  levelId?: string | null;
  entryTermId?: string | null;
  guardianName?: string | null;
  guardianPhone?: string | null;
  guardianEmail?: string | null;
  guardianRelationship?: string | null;
  notes?: string | null;
}

function ApplicantFields({
  state,
  values,
  levels,
  terms,
}: {
  state: FormState;
  values: ApplicantValues;
  levels: Option[];
  terms: Option[];
}) {
  const errors = state.fieldErrors ?? {};
  const v = (k: keyof ApplicantValues) => state.values?.[k] ?? values[k] ?? "";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Child's first name" error={errors.childFirstName}>
        {(p) => (
          <Input {...p} name="childFirstName" maxLength={60} defaultValue={v("childFirstName")} required />
        )}
      </Field>
      <Field label="Surname" error={errors.childLastName}>
        {(p) => (
          <Input {...p} name="childLastName" maxLength={60} defaultValue={v("childLastName")} required />
        )}
      </Field>
      <Field label="Other names" optional error={errors.childOtherNames}>
        {(p) => <Input {...p} name="childOtherNames" maxLength={60} defaultValue={v("childOtherNames")} />}
      </Field>
      <Field label="Sex" description="Needed before enrolling." error={errors.sex}>
        {(p) => (
          <Select {...p} name="sex" defaultValue={v("sex")}>
            <option value="">Not recorded yet</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </Select>
        )}
      </Field>
      <Field label="Date of birth" optional error={errors.dateOfBirth}>
        {(p) => <Input {...p} name="dateOfBirth" type="date" defaultValue={v("dateOfBirth")} />}
      </Field>
      <Field label="Previous school" optional error={errors.previousSchool}>
        {(p) => <Input {...p} name="previousSchool" maxLength={120} defaultValue={v("previousSchool")} />}
      </Field>
      <Field label="Level applying for" error={errors.levelId}>
        {(p) => (
          <Select {...p} name="levelId" defaultValue={v("levelId")} required>
            <option value="" disabled>
              Choose
            </option>
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Starting term" optional error={errors.entryTermId}>
        {(p) => (
          <Select {...p} name="entryTermId" defaultValue={v("entryTermId")}>
            <option value="">Not decided</option>
            {terms.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Parent or guardian" error={errors.guardianName}>
        {(p) => (
          <Input {...p} name="guardianName" maxLength={120} defaultValue={v("guardianName")} required />
        )}
      </Field>
      <Field label="Relationship" error={errors.guardianRelationship}>
        {(p) => (
          <Select {...p} name="guardianRelationship" defaultValue={v("guardianRelationship") || "mother"}>
            {RELATIONSHIPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Phone" error={errors.guardianPhone}>
        {(p) => <Input {...p} name="guardianPhone" type="tel" defaultValue={v("guardianPhone")} required />}
      </Field>
      <Field label="Email" optional error={errors.guardianEmail}>
        {(p) => <Input {...p} name="guardianEmail" type="email" defaultValue={v("guardianEmail")} />}
      </Field>
      <Field label="Notes" optional error={errors.notes} className="sm:col-span-2">
        {(p) => <Textarea {...p} name="notes" rows={3} maxLength={1000} defaultValue={v("notes")} />}
      </Field>
    </div>
  );
}

/** Records an inquiry or an application taken at the office or by phone. */
export function NewApplicationDialog({
  action,
  levels,
  terms,
}: {
  action: Action;
  levels: Option[];
  terms: Option[];
}) {
  return (
    <FormDialog
      trigger="New inquiry or application"
      triggerVariant="primary"
      title="New inquiry or application"
      description="An inquiry is a family asking about a place; an application is a request for one."
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => {
        const errors = state.fieldErrors ?? {};
        return (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="This is" error={errors.status}>
                {(p) => (
                  <Select {...p} name="status" defaultValue={state.values?.status ?? "inquiry"}>
                    <option value="inquiry">An inquiry</option>
                    <option value="applied">An application</option>
                  </Select>
                )}
              </Field>
              <Field label="How they came to the school" error={errors.source}>
                {(p) => (
                  <Select {...p} name="source" defaultValue={state.values?.source ?? "walk_in"}>
                    {APPLICATION_SOURCES.filter((s) => s !== "online").map((s) => (
                      <option key={s} value={s}>
                        {APPLICATION_SOURCE_LABELS[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <ApplicantFields state={state} values={{}} levels={levels} terms={terms} />
          </div>
        );
      }}
    </FormDialog>
  );
}

export function EditApplicationDialog({
  action,
  values,
  levels,
  terms,
}: {
  action: Action;
  values: ApplicantValues;
  levels: Option[];
  terms: Option[];
}) {
  return (
    <FormDialog
      trigger="Edit details"
      title="Edit the application"
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => <ApplicantFields state={state} values={values} levels={levels} terms={terms} />}
    </FormDialog>
  );
}

/** A step that needs only a note (required for declining and withdrawing). */
export function NoteDialog({
  action,
  trigger,
  title,
  description,
  submitLabel,
  required,
  danger = false,
}: {
  action: Action;
  trigger: string;
  title: string;
  description: string;
  submitLabel: string;
  required: boolean;
  danger?: boolean;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerVariant={danger ? "ghost" : "secondary"}
      title={title}
      description={description}
      submitLabel={submitLabel}
      danger={danger}
      action={action}
    >
      {(state) => (
        <Field label={required ? "Reason" : "Note (optional)"} error={state.fieldErrors?.note}>
          {(p) => (
            <Textarea
              {...p}
              name="note"
              rows={3}
              maxLength={500}
              defaultValue={state.values?.note}
              required={required}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function AssessmentDialog({
  action,
  at,
  note,
  rescheduling,
}: {
  action: Action;
  at: string;
  note: string;
  rescheduling: boolean;
}) {
  return (
    <FormDialog
      trigger={rescheduling ? "Update assessment" : "Schedule an assessment"}
      title={rescheduling ? "Assessment or interview" : "Schedule an assessment or interview"}
      description="The school's local time. Add how it went afterwards."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <div className="space-y-4">
          <Field label="Day and time" error={state.fieldErrors?.at}>
            {(p) => (
              <Input {...p} name="at" type="datetime-local" defaultValue={state.values?.at ?? at} required />
            )}
          </Field>
          <Field label="Note or outcome" optional error={state.fieldErrors?.note}>
            {(p) => (
              <Textarea
                {...p}
                name="note"
                rows={3}
                maxLength={500}
                defaultValue={state.values?.note ?? note}
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function OfferDialog({
  action,
  terms,
  classes,
  entryTermId,
  fees,
}: {
  action: Action;
  terms: Option[];
  classes: Option[];
  entryTermId: string;
  /** The admission fees the offer will carry, already formatted. */
  fees: string[];
}) {
  return (
    <FormDialog
      trigger="Make an offer"
      title="Offer a place"
      description="The offer keeps today's admission fees; they are charged when the child is enrolled."
      submitLabel="Make the offer"
      action={action}
    >
      {(state) => {
        const errors = state.fieldErrors ?? {};
        return (
          <div className="space-y-4">
            <Field label="Starts in" error={errors.entryTermId}>
              {(p) => (
                <Select
                  {...p}
                  name="entryTermId"
                  defaultValue={state.values?.entryTermId ?? entryTermId}
                  required
                >
                  <option value="" disabled>
                    Choose a term
                  </option>
                  {terms.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Class"
              optional
              description="It can still be chosen when enrolling."
              error={errors.classId}
            >
              {(p) => (
                <Select {...p} name="classId" defaultValue={state.values?.classId ?? ""}>
                  <option value="">Decide later</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reply by" optional error={errors.respondBy}>
              {(p) => <Input {...p} name="respondBy" type="date" defaultValue={state.values?.respondBy} />}
            </Field>
            <div className="rounded-md bg-subtle px-3 py-2 text-sm text-ink-2">
              {fees.length ? (
                <>
                  Admission fees on enrolment: <span className="text-ink">{fees.join(" · ")}</span>
                </>
              ) : (
                "No admission fees are set. The Accountant or Proprietor sets them under Admissions, Settings."
              )}
            </div>
          </div>
        );
      }}
    </FormDialog>
  );
}

export function EnrolDialog({
  action,
  classes,
  classId,
  fees,
}: {
  action: Action;
  classes: Option[];
  classId: string;
  fees: string[];
}) {
  return (
    <FormDialog
      trigger="Enrol"
      triggerVariant="primary"
      title="The family accepted: enrol the child"
      description="Creates the student with the next admission number, links the parent, places the child in the class for the starting term and charges the offer's admission fees. This cannot be undone here."
      submitLabel="Enrol"
      action={action}
    >
      {(state) => (
        <div className="space-y-4">
          <Field label="Class" error={state.fieldErrors?.classId}>
            {(p) => (
              <Select {...p} name="classId" defaultValue={state.values?.classId ?? classId} required>
                <option value="" disabled>
                  Choose a class
                </option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <p className="text-sm text-ink-2">
            {fees.length ? `Charged on enrolment: ${fees.join(" · ")}.` : "No admission fees in this offer."}
          </p>
        </div>
      )}
    </FormDialog>
  );
}

/** The admission fee schedule (finance staff): charged on enrolment, frozen into each offer. */
export function AdmissionFeesForm({
  action,
  fees,
  currencySymbol,
}: {
  action: Action;
  fees: { description: string; amount: string }[];
  currencySymbol: string;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  const [rows, setRows] = useState(() => fees.map((f, i) => ({ ...f, id: i })));
  const next = () => Math.max(0, ...rows.map((r) => r.id)) + 1;
  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-3" noValidate aria-label="Admission fees">
      <FormMessage state={state} />
      {rows.length > 0 && (
        <div className="grid grid-cols-[1fr_8rem_2.5rem] gap-3 text-sm font-medium text-ink-3">
          <span>Fee</span>
          <span>Amount ({currencySymbol})</span>
          <span className="sr-only">Remove</span>
        </div>
      )}
      {rows.map((row, i) => (
        <div key={row.id} className="grid grid-cols-[1fr_8rem_2.5rem] items-center gap-3">
          <Input
            name="description"
            aria-label={`Fee ${i + 1}`}
            defaultValue={row.description}
            maxLength={80}
            placeholder="Admission fee"
          />
          <Input
            name="amount"
            aria-label={`Fee ${i + 1} amount`}
            defaultValue={row.amount}
            inputMode="decimal"
            className="tabular-nums"
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove fee ${i + 1}`}
            onClick={() => setRows((r) => r.filter((x) => x.id !== row.id))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRows((r) => [...r, { description: "", amount: "", id: next() }])}
          disabled={rows.length >= 8}
        >
          <Plus aria-hidden="true" />
          Add a fee
        </Button>
        <Button type="submit" size="sm" variant="secondary" pending={pending}>
          Save admission fees
        </Button>
      </div>
    </form>
  );
}
