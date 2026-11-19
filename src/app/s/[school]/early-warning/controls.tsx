"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FormMessage } from "@/components/ui/toast";
import { SETTING_RANGES, type EarlyWarningSettings, type ReviewOutcome } from "@/lib/early-warning";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** A support plan's fields: what it is for, what will be done, who, and when it is reviewed. */
function PlanFields({ state, today }: { state: FormState; today: string }) {
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <>
      <Field label="Goal" error={errors.goal}>
        {(p) => (
          <Input
            {...p}
            name="goal"
            defaultValue={v.goal}
            placeholder="e.g. Attends every day"
            maxLength={300}
          />
        )}
      </Field>
      <Field label="What will be done" error={errors.actions}>
        {(p) => (
          <Textarea
            {...p}
            name="actions"
            rows={3}
            defaultValue={v.actions}
            placeholder="e.g. Call home after any absence; a weekly check-in with the class teacher."
            maxLength={1000}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who is responsible" error={errors.responsible}>
          {(p) => (
            <Input
              {...p}
              name="responsible"
              defaultValue={v.responsible}
              placeholder="e.g. Class teacher"
              maxLength={120}
            />
          )}
        </Field>
        <Field label="Review on" error={errors.reviewOn}>
          {(p) => <Input {...p} type="date" name="reviewOn" min={today} defaultValue={v.reviewOn} />}
        </Field>
      </div>
    </>
  );
}

const OUTCOMES: { value: ReviewOutcome; label: string; note: string }[] = [
  { value: "no_action", label: "No action needed", note: "You know why, and it needs nothing more." },
  {
    value: "support_plan",
    label: "Open a support plan",
    note: "Set out what the school will do, and when to review it.",
  },
  {
    value: "referred",
    label: "Refer to the Head teacher",
    note: "The Head teacher sees it and can open a plan.",
  },
];

/** Reviews an indicator once: what happens next, with a reason (EWS-02a). */
export function ReviewIndicatorDialog({
  action,
  summary,
  today,
  canRefer,
}: {
  action: Action;
  summary: string;
  today: string;
  /** Teachers refer to the Head teacher; the Head teacher does not refer to themself. */
  canRefer: boolean;
}) {
  const [outcome, setOutcome] = useState<ReviewOutcome>("no_action");
  return (
    <FormDialog
      trigger="Review"
      triggerSize="sm"
      triggerLabel={`Review: ${summary}`}
      title="Review this indicator"
      description={`${summary}. What the records show is not a judgement: say what you know and what happens next. The review is kept and cannot be changed.`}
      submitLabel="Save review"
      size="lg"
      action={action}
    >
      {(state) => (
        <>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-ink">What happens next</legend>
            {OUTCOMES.filter((o) => canRefer || o.value !== "referred").map((o) => (
              <label key={o.value} className="flex items-start gap-3 text-base text-ink">
                <input
                  type="radio"
                  name="outcome"
                  value={o.value}
                  checked={outcome === o.value}
                  onChange={() => setOutcome(o.value)}
                  className="mt-1 size-4 accent-accent"
                />
                <span>
                  {o.label}
                  <span className="block text-sm text-ink-3">{o.note}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Reason" error={state.fieldErrors?.reason}>
            {(p) => (
              <Textarea
                {...p}
                name="reason"
                rows={3}
                defaultValue={state.values?.reason}
                placeholder="e.g. Her mother called: she was in hospital for three days."
                required
                minLength={3}
                maxLength={500}
              />
            )}
          </Field>
          {outcome === "support_plan" && <PlanFields state={state} today={today} />}
        </>
      )}
    </FormDialog>
  );
}

/** Opens a support plan for a student (e.g. after a referral). */
export function OpenPlanDialog({
  action,
  studentName,
  today,
}: {
  action: Action;
  studentName: string;
  today: string;
}) {
  return (
    <FormDialog
      trigger="Open a support plan"
      triggerSize="sm"
      triggerLabel={`Open a support plan for ${studentName}`}
      title={`Support plan for ${studentName}`}
      description="What the school will do, who is responsible, and when it is reviewed. Updates are added later; the plan itself is not edited."
      submitLabel="Open plan"
      size="lg"
      action={action}
    >
      {(state) => <PlanFields state={state} today={today} />}
    </FormDialog>
  );
}

/** Adds an update to a plan, with an optional new review date. */
export function PlanUpdateDialog({ action, today }: { action: Action; today: string }) {
  return (
    <FormDialog
      trigger="Add an update"
      title="Add an update"
      description="What has happened since. Updates are kept as written."
      submitLabel="Add update"
      action={action}
    >
      {(state) => (
        <>
          <Field label="Update" error={state.fieldErrors?.note}>
            {(p) => (
              <Textarea
                {...p}
                name="note"
                rows={3}
                defaultValue={state.values?.note}
                required
                minLength={3}
                maxLength={1000}
              />
            )}
          </Field>
          <Field label="New review date" optional error={state.fieldErrors?.reviewOn}>
            {(p) => (
              <Input {...p} type="date" name="reviewOn" min={today} defaultValue={state.values?.reviewOn} />
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

/** Closes a plan, once, with its outcome. */
export function ClosePlanDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Close the plan"
      title="Close the plan"
      description="How it went. A closed plan stays in the student's history and cannot be reopened."
      submitLabel="Close plan"
      action={action}
    >
      {(state) => (
        <Field label="Outcome" error={state.fieldErrors?.outcome}>
          {(p) => (
            <Textarea
              {...p}
              name="outcome"
              rows={3}
              defaultValue={state.values?.outcome}
              required
              minLength={3}
              maxLength={500}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

function NumberField({
  name,
  label,
  value,
  error,
  suffix,
}: {
  name: keyof typeof SETTING_RANGES;
  label: string;
  value: number | string;
  error?: string;
  suffix?: string;
}) {
  return (
    <Field label={label} description={suffix} error={error}>
      {(p) => (
        <Input
          {...p}
          type="number"
          name={name}
          min={SETTING_RANGES[name].min}
          max={SETTING_RANGES[name].max}
          defaultValue={value}
          className="w-28"
        />
      )}
    </Field>
  );
}

/** The school's rules: each on or off, with its thresholds (EWS-01a). */
export function RulesForm({ action, settings }: { action: Action; settings: EarlyWarningSettings }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = (k: keyof EarlyWarningSettings) => state.values?.[k] ?? String(settings[k]);
  const checked = (k: keyof EarlyWarningSettings) =>
    state.values ? state.values[k] === "on" : (settings[k] as boolean);
  const rule = (k: keyof EarlyWarningSettings, title: string, children: React.ReactNode) => (
    <fieldset className="space-y-3 border-t border-line pt-5 first:border-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <label className="flex items-center gap-3 text-base font-medium text-ink">
        <input type="checkbox" name={k} defaultChecked={checked(k)} className="size-4 accent-accent" />
        {title}
      </label>
      <div className="flex flex-wrap gap-4 pl-7">{children}</div>
    </fieldset>
  );
  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      {rule(
        "attendanceOn",
        "Attendance below a level",
        <>
          <NumberField
            name="attendancePercent"
            label="Below (%)"
            value={v("attendancePercent")}
            error={errors.attendancePercent}
          />
          <NumberField
            name="attendanceDays"
            label="Over the last (days)"
            value={v("attendanceDays")}
            error={errors.attendanceDays}
            suffix="At least 5 registers"
          />
        </>,
      )}
      {rule(
        "absencesOn",
        "Absent several days in a row",
        <NumberField
          name="absencesInARow"
          label="Absences in a row"
          value={v("absencesInARow")}
          error={errors.absencesInARow}
          suffix="Without a reason"
        />,
      )}
      {rule(
        "averageOn",
        "Report-card average down",
        <NumberField
          name="averageDrop"
          label="Down by (points)"
          value={v("averageDrop")}
          error={errors.averageDrop}
          suffix="From the previous published card"
        />,
      )}
      {rule(
        "subjectsOn",
        "Subjects below the pass mark",
        <>
          <NumberField
            name="subjectsCount"
            label="Subjects"
            value={v("subjectsCount")}
            error={errors.subjectsCount}
          />
          <NumberField name="passMark" label="Below (mark)" value={v("passMark")} error={errors.passMark} />
        </>,
      )}
      <Button type="submit" pending={pending}>
        Save rules
      </Button>
    </form>
  );
}
