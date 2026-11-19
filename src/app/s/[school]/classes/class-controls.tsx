"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
interface Option {
  value: string;
  label: string;
}

/** A starter template, as offered when setting up levels (see src/lib/curricula.ts). */
export interface TemplateChoice {
  id: string;
  name: string;
  description: string;
  stages: { value: string; label: string; levels: string[] }[];
}

export function SetupLevelsDialog({
  action,
  templates,
  defaultTemplate,
}: {
  action: Action;
  templates: TemplateChoice[];
  /** The school's country's template, chosen unless the school picks another. */
  defaultTemplate: string;
}) {
  return (
    <FormDialog
      trigger="Set up levels"
      triggerVariant="primary"
      title="Set up levels"
      description="Choose a starting point and the stages your school runs. The template also suggests subjects and grade bands. You can rename or add levels afterwards."
      submitLabel="Create levels"
      action={action}
    >
      {(state) => <SetupLevelsFields state={state} templates={templates} defaultTemplate={defaultTemplate} />}
    </FormDialog>
  );
}

function SetupLevelsFields({
  state,
  templates,
  defaultTemplate,
}: {
  state: FormState;
  templates: TemplateChoice[];
  defaultTemplate: string;
}) {
  const [templateId, setTemplateId] = useState(state.values?.template ?? defaultTemplate);
  const template = templates.find((t) => t.id === templateId) ?? templates[0]!;
  return (
    <div className="space-y-5">
      <Field label="Starting point" description={template.description} error={state.fieldErrors?.template}>
        {(p) => (
          <Select {...p} name="template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Stages</legend>
        {template.stages.map((stage) => (
          <label key={stage.value} className="flex items-start gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              name="stages"
              value={stage.value}
              defaultChecked
              className="mt-1 size-4 accent-ink"
            />
            <span>
              {stage.label}
              <span className="block text-sm text-ink-3">{stage.levels.join(", ")}</span>
            </span>
          </label>
        ))}
        {state.fieldErrors?.stages && <p className="text-sm text-critical">{state.fieldErrors.stages}</p>}
      </fieldset>
    </div>
  );
}

export function AddLevelDialog({ action, stages }: { action: Action; stages: Option[] }) {
  return (
    <FormDialog trigger="Add level" title="Add level" submitLabel="Add level" action={action}>
      {(state) => (
        <>
          <Field label="Name" description="For example Nursery 3 or Basic 7." error={state.fieldErrors?.name}>
            {(p) => <Input {...p} name="name" defaultValue={state.values?.name} required maxLength={40} />}
          </Field>
          <Field label="Stage" error={state.fieldErrors?.stage}>
            {(p) => (
              <Select {...p} name="stage" defaultValue={state.values?.stage ?? "primary"}>
                {stages.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}

export function RenameLevelDialog({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Rename"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Rename ${name}`}
      title={`Rename ${name}`}
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <Field label="Name" error={state.fieldErrors?.name}>
          {(p) => (
            <Input {...p} name="name" defaultValue={state.values?.name ?? name} required maxLength={40} />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

function TeacherSelect({
  teachers,
  defaultValue,
  error,
}: {
  teachers: Option[];
  defaultValue?: string;
  error?: string;
}) {
  return (
    <Field label="Class teacher" optional error={error}>
      {(p) => (
        <Select {...p} name="classTeacherMembershipId" defaultValue={defaultValue ?? ""}>
          <option value="">No class teacher yet</option>
          {teachers.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function AddClassDialog({
  action,
  levels,
  campuses,
  teachers,
  levelId,
  trigger = "Add class",
}: {
  action: Action;
  levels: Option[];
  campuses: Option[];
  teachers: Option[];
  levelId?: string;
  trigger?: string;
}) {
  return (
    <FormDialog
      trigger={
        <>
          <Plus aria-hidden="true" />
          {trigger}
        </>
      }
      triggerVariant={levelId ? "ghost" : "primary"}
      triggerSize={levelId ? "sm" : "md"}
      triggerLabel={levelId ? `Add class to ${levels.find((l) => l.value === levelId)?.label}` : undefined}
      title="Add class"
      submitLabel="Add class"
      action={action}
    >
      {(state) => (
        <ClassFields
          state={state}
          levels={levels}
          campuses={campuses}
          teachers={teachers}
          levelId={levelId}
        />
      )}
    </FormDialog>
  );
}

function ClassFields({
  state,
  levels,
  campuses,
  teachers,
  levelId,
}: {
  state: FormState;
  levels: Option[];
  campuses: Option[];
  teachers: Option[];
  levelId?: string;
}) {
  const initialLevel = state.values?.levelId ?? levelId ?? levels[0]?.value ?? "";
  const [name, setName] = useState(
    state.values?.name ?? levels.find((l) => l.value === initialLevel)?.label ?? "",
  );
  return (
    <>
      <Field label="Level" error={state.fieldErrors?.levelId}>
        {(p) => (
          <Select
            {...p}
            name="levelId"
            defaultValue={initialLevel}
            onChange={(e) => setName(levels.find((l) => l.value === e.target.value)?.label ?? "")}
          >
            {levels.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Class name"
        description="Add a letter or name if the level has more than one class, e.g. Basic 4A."
        error={state.fieldErrors?.name}
      >
        {(p) => (
          <Input
            {...p}
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={40}
          />
        )}
      </Field>
      {campuses.length > 1 ? (
        <Field label="Campus" error={state.fieldErrors?.campusId}>
          {(p) => (
            <Select {...p} name="campusId" defaultValue={state.values?.campusId ?? campuses[0]?.value}>
              {campuses.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      ) : (
        <input type="hidden" name="campusId" value={campuses[0]?.value ?? ""} />
      )}
      <TeacherSelect
        teachers={teachers}
        defaultValue={state.values?.classTeacherMembershipId}
        error={state.fieldErrors?.classTeacherMembershipId}
      />
    </>
  );
}

export function EditClassDialog({
  action,
  name,
  teacherId,
  teachers,
}: {
  action: Action;
  name: string;
  teacherId?: string;
  teachers: Option[];
}) {
  return (
    <FormDialog
      trigger="Edit"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Edit ${name}`}
      title={`Edit ${name}`}
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <>
          <Field label="Class name" error={state.fieldErrors?.name}>
            {(p) => (
              <Input {...p} name="name" defaultValue={state.values?.name ?? name} required maxLength={40} />
            )}
          </Field>
          <TeacherSelect
            teachers={teachers}
            defaultValue={state.values?.classTeacherMembershipId ?? teacherId}
            error={state.fieldErrors?.classTeacherMembershipId}
          />
        </>
      )}
    </FormDialog>
  );
}

export function ClassStatusDialog({
  action,
  name,
  archived,
}: {
  action: Action;
  name: string;
  archived: boolean;
}) {
  return (
    <FormDialog
      trigger={archived ? "Restore" : "Archive"}
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`${archived ? "Restore" : "Archive"} ${name}`}
      title={archived ? `Restore ${name}?` : `Archive ${name}?`}
      description={
        archived
          ? "The class becomes available again."
          : "Archived classes are hidden from day-to-day work. Nothing is deleted."
      }
      submitLabel={archived ? "Restore class" : "Archive class"}
      danger={!archived}
      action={action}
    />
  );
}
