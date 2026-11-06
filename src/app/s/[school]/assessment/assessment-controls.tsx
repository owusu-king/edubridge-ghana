"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { useFormAction } from "@/components/ui/use-form-action";
import type { AssessmentComponent, GradeBand } from "@/lib/assessment";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export function PublishDialog({
  action,
  title,
  trigger = "Publish report cards",
  ready,
  incomplete,
}: {
  action: Action;
  title: string;
  trigger?: string;
  ready: number;
  incomplete: number;
}) {
  const total = ready + incomplete;
  return (
    <FormDialog
      trigger={trigger}
      triggerVariant="primary"
      title={title}
      description={`Families see published report cards in the parent view, and the marks behind them lock. ${total} ${total === 1 ? "report card" : "report cards"} will be published.`}
      submitLabel="Publish"
      action={action}
    >
      {() =>
        incomplete > 0 ? (
          <Alert tone="critical">
            {incomplete === 1 && total === 1
              ? "Some subjects are missing marks"
              : `${incomplete} ${incomplete === 1 ? "student is" : "students are"} missing marks`}
            . Those subjects will show as &ldquo;Not graded&rdquo;. To fix this first, cancel and complete the
            score sheets.
          </Alert>
        ) : (
          <p className="text-base text-ink-2">
            {total === 1
              ? "Every subject has a mark for every part."
              : "Every student has a mark for every part of every subject."}
          </p>
        )
      }
    </FormDialog>
  );
}

export function PrintDialog({ action, label, count }: { action: Action; label: string; count: number }) {
  return (
    <FormDialog
      trigger="Print report cards"
      title={`Print ${label}`}
      description={`${count} published ${count === 1 ? "report card goes" : "report cards go"} into a PDF, one page each. It is prepared in the background; you can leave the page.`}
      submitLabel="Prepare PDF"
      action={action}
    />
  );
}

export function WithdrawDialog({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Withdraw"
      triggerVariant="secondary"
      title={`Withdraw ${name}'s report card`}
      description="It becomes a draft again: families no longer see it and its marks can be corrected. Publish it again when it is ready."
      submitLabel="Withdraw"
      danger
      action={action}
    >
      {(state) => (
        <Field label="Reason" description="Kept in the audit log." error={state.fieldErrors?.reason}>
          {(p) => <Input {...p} name="reason" defaultValue={state.values?.reason} required maxLength={300} />}
        </Field>
      )}
    </FormDialog>
  );
}

interface LevelOption {
  id: string;
  name: string;
}

function LevelChecks({ levels, checked }: { levels: LevelOption[]; checked: string[] }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-ink">Levels that take it</legend>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {levels.map((level) => (
          <label key={level.id} className="flex items-center gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              name="levelIds"
              value={level.id}
              defaultChecked={checked.includes(level.id)}
              className="size-4 accent-ink"
            />
            {level.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SubjectDialog({
  action,
  levels,
  subject,
}: {
  action: Action;
  levels: LevelOption[];
  subject?: { name: string; levelIds: string[] };
}) {
  return (
    <FormDialog
      trigger={subject ? "Edit" : "Add subject"}
      triggerVariant={subject ? "ghost" : "secondary"}
      triggerSize={subject ? "sm" : "md"}
      triggerLabel={subject ? `Edit ${subject.name}` : undefined}
      title={subject ? `Edit ${subject.name}` : "Add subject"}
      description={
        subject
          ? "Taking a subject off a level keeps its marks; it no longer shows on that level's score sheets and draft report cards."
          : undefined
      }
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => (
        <>
          <Field label="Name" error={state.fieldErrors?.name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                defaultValue={state.values?.name ?? subject?.name}
                required
                maxLength={60}
              />
            )}
          </Field>
          <LevelChecks levels={levels} checked={subject?.levelIds ?? levels.map((l) => l.id)} />
        </>
      )}
    </FormDialog>
  );
}

type ComponentRow = { key?: string; name: string; weight: string; outOf: string; id: number };

/** The parts of a term's assessment, edited as rows; the weights must add up to 100%. */
export function SchemeForm({
  action,
  components,
  showPositions,
  locked,
}: {
  action: Action;
  components: AssessmentComponent[];
  showPositions: boolean;
  locked: boolean;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  const toRows = () =>
    components.map((c, i) => ({
      key: c.key,
      name: c.name,
      weight: String(c.weight),
      outOf: String(c.outOf),
      id: i,
    }));
  const [rows, setRows] = useState<ComponentRow[]>(toRows);
  // After a save the server's parts (with the keys given to new ones) replace the rows being edited.
  const version = JSON.stringify(components);
  const [shown, setShown] = useState(version);
  if (shown !== version) {
    setShown(version);
    setRows(toRows());
  }
  const total = rows.reduce((sum, r) => sum + (Number(r.weight) || 0), 0);
  const update = (id: number, patch: Partial<ComponentRow>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate aria-label="Assessment parts">
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "error" ? "critical" : "positive"}>{state.message}</Alert>
      )}
      <fieldset disabled={locked} className="space-y-3">
        <div className="hidden grid-cols-[1fr_6rem_6rem_2.5rem] gap-3 text-sm font-medium text-ink-3 sm:grid">
          <span>Part</span>
          <span>Weight (%)</span>
          <span>Marked out of</span>
          <span className="sr-only">Remove</span>
        </div>
        {rows.map((row, i) => (
          <div
            key={row.id}
            className="grid grid-cols-[1fr_5rem_5rem_2.5rem] items-center gap-3 sm:grid-cols-[1fr_6rem_6rem_2.5rem]"
          >
            <input type="hidden" name="key" value={row.key ?? ""} />
            <Input
              name="name"
              aria-label={`Part ${i + 1} name`}
              value={row.name}
              onChange={(e) => update(row.id, { name: e.target.value })}
              maxLength={30}
            />
            <Input
              name="weight"
              aria-label={`Part ${i + 1} weight (%)`}
              inputMode="numeric"
              value={row.weight}
              onChange={(e) => update(row.id, { weight: e.target.value })}
              className="tabular-nums"
            />
            <Input
              name="outOf"
              aria-label={`Part ${i + 1} marked out of`}
              inputMode="numeric"
              value={row.outOf}
              onChange={(e) => update(row.id, { outOf: e.target.value })}
              className="tabular-nums"
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove part ${i + 1}`}
              onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
              disabled={rows.length <= 1}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setRows((current) => [
                ...current,
                { name: "", weight: "", outOf: "100", id: Math.max(0, ...current.map((r) => r.id)) + 1 },
              ])
            }
            disabled={rows.length >= 6}
          >
            <Plus aria-hidden="true" />
            Add part
          </Button>
          <p className={total === 100 ? "text-sm text-ink-3" : "text-sm font-medium text-critical"}>
            Weights add up to {total}%
          </p>
        </div>
        <label className="flex items-start gap-2.5 text-base text-ink">
          <input
            type="checkbox"
            name="showPositions"
            defaultChecked={showPositions}
            className="mt-1 size-4 accent-ink"
          />
          <span>
            Show class positions on report cards
            <span className="block text-sm text-ink-3">
              GES guidance for the Standards-Based Curriculum discourages ranking pupils, so this is off by
              default.
            </span>
          </span>
        </label>
        <div>
          <Button type="submit" pending={pending}>
            Save assessment
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

type BandRow = { grade: string; min: string; remark: string; id: number };

/** A stage's grade bands, edited as rows: the lowest mark for each grade. */
export function ScaleForm({
  action,
  resetAction,
  stageLabel,
  bands,
  custom,
}: {
  action: Action;
  resetAction: Action;
  stageLabel: string;
  bands: GradeBand[];
  custom: boolean;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  const toRows = () => bands.map((b, i) => ({ grade: b.grade, min: String(b.min), remark: b.remark, id: i }));
  const [rows, setRows] = useState<BandRow[]>(toRows);
  // After a save or a reset the stored bands (sorted) replace the rows being edited.
  const version = JSON.stringify(bands);
  const [shown, setShown] = useState(version);
  if (shown !== version) {
    setShown(version);
    setRows(toRows());
  }
  const update = (id: number, patch: Partial<BandRow>) =>
    setRows((current) => current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label={`${stageLabel} grades`}>
        {state.status !== "idle" && state.message && (
          <Alert tone={state.status === "error" ? "critical" : "positive"}>{state.message}</Alert>
        )}
        <div className="grid grid-cols-[4rem_5rem_1fr_2.5rem] gap-3 text-sm font-medium text-ink-3">
          <span>Grade</span>
          <span>From mark</span>
          <span>Remark</span>
          <span className="sr-only">Remove</span>
        </div>
        {rows.map((row, i) => (
          <div key={row.id} className="grid grid-cols-[4rem_5rem_1fr_2.5rem] items-center gap-3">
            <Input
              name="grade"
              aria-label={`Grade ${i + 1}`}
              value={row.grade}
              onChange={(e) => update(row.id, { grade: e.target.value })}
              maxLength={4}
            />
            <Input
              name="min"
              aria-label={`Grade ${i + 1} from mark`}
              inputMode="numeric"
              value={row.min}
              onChange={(e) => update(row.id, { min: e.target.value })}
              className="tabular-nums"
            />
            <Input
              name="remark"
              aria-label={`Grade ${i + 1} remark`}
              value={row.remark}
              onChange={(e) => update(row.id, { remark: e.target.value })}
              maxLength={40}
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove grade ${i + 1}`}
              onClick={() => setRows((current) => current.filter((r) => r.id !== row.id))}
              disabled={rows.length <= 1}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setRows((current) => [
                ...current,
                { grade: "", min: "", remark: "", id: Math.max(0, ...current.map((r) => r.id)) + 1 },
              ])
            }
            disabled={rows.length >= 12}
          >
            <Plus aria-hidden="true" />
            Add grade
          </Button>
          <Button type="submit" size="sm" variant="secondary" pending={pending}>
            Save {stageLabel} grades
          </Button>
        </div>
      </form>
      {custom && (
        <FormDialog
          trigger="Restore defaults"
          triggerVariant="ghost"
          triggerSize="sm"
          triggerLabel={`Restore default ${stageLabel} grades`}
          title={`Restore default ${stageLabel} grades`}
          description="Report cards already published keep the grades they were published with."
          submitLabel="Restore defaults"
          action={resetAction}
        />
      )}
    </div>
  );
}

/** Remarks on a draft report card. The head teacher's remark appears only for those who publish. */
export function RemarksForm({
  action,
  values,
  canWriteHeadRemark,
}: {
  action: Action;
  values: Record<string, string>;
  canWriteHeadRemark: boolean;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  const v = (name: string) => state.values?.[name] ?? values[name] ?? "";
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate aria-label="Report card remarks">
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "error" ? "critical" : "positive"}>{state.message}</Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        {(["attitude", "conduct", "interest"] as const).map((name) => (
          <Field key={name} label={name[0]!.toUpperCase() + name.slice(1)} error={state.fieldErrors?.[name]}>
            {(p) => <Input {...p} name={name} defaultValue={v(name)} maxLength={60} />}
          </Field>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Days present" error={state.fieldErrors?.daysPresent}>
          {(p) => (
            <Input
              {...p}
              name="daysPresent"
              inputMode="numeric"
              defaultValue={v("daysPresent")}
              className="tabular-nums"
            />
          )}
        </Field>
        <Field label="Days school was open" error={state.fieldErrors?.daysOpen}>
          {(p) => (
            <Input
              {...p}
              name="daysOpen"
              inputMode="numeric"
              defaultValue={v("daysOpen")}
              className="tabular-nums"
            />
          )}
        </Field>
      </div>
      <Field label="Class teacher's remark" error={state.fieldErrors?.classTeacherRemark}>
        {(p) => (
          <Textarea
            {...p}
            name="classTeacherRemark"
            rows={3}
            maxLength={500}
            defaultValue={v("classTeacherRemark")}
          />
        )}
      </Field>
      {canWriteHeadRemark && (
        <Field label="Head teacher's remark" error={state.fieldErrors?.headTeacherRemark}>
          {(p) => (
            <Textarea
              {...p}
              name="headTeacherRemark"
              rows={3}
              maxLength={500}
              defaultValue={v("headTeacherRemark")}
            />
          )}
        </Field>
      )}
      <Button type="submit" pending={pending}>
        Save report card
      </Button>
    </form>
  );
}
