"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
interface Option {
  value: string;
  label: string;
}

/**
 * One teacher, one subject, the classes they teach it in. Only classes whose level takes the subject are
 * offered; a class that already has a teacher for it says who, and moves to this teacher when ticked.
 */
export function AssignSubjectTeacherForm({
  action,
  teachers,
  subjects,
  classes,
  taken,
}: {
  action: Action;
  teachers: Option[];
  subjects: Option[];
  classes: (Option & { subjectIds: string[] })[];
  taken: { classId: string; subjectId: string; teacher: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [subjectId, setSubjectId] = useState(state.values?.subjectId ?? subjects[0]?.value ?? "");
  const offered = classes.filter((c) => c.subjectIds.includes(subjectId));
  const errors = state.fieldErrors ?? {};
  if (teachers.length === 0 || subjects.length === 0) return null;
  return (
    <form action={formAction} className="max-w-3xl space-y-4 rounded-lg border border-line bg-surface p-5">
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Teacher" error={errors.membershipId}>
          {(p) => (
            <Select {...p} name="membershipId" defaultValue={state.values?.membershipId ?? ""} required>
              <option value="" disabled>
                Choose a teacher
              </option>
              {teachers.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Subject" error={errors.subjectId}>
          {(p) => (
            <Select {...p} name="subjectId" value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">Classes</legend>
        {offered.length === 0 ? (
          <p className="text-sm text-ink-3">
            No class takes this subject. Add it to a level under Assessment, Setup.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            {offered.map((c) => {
              const current = taken.find((t) => t.classId === c.value && t.subjectId === subjectId);
              return (
                <label key={c.value} className="flex items-start gap-2 text-base text-ink">
                  <input
                    type="checkbox"
                    name="classIds"
                    value={c.value}
                    className="mt-1 size-4 accent-accent"
                  />
                  <span>
                    {c.label}
                    {current && <span className="block text-sm text-ink-3">Now: {current.teacher}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        {errors.classIds && <p className="text-sm text-critical">{errors.classIds}</p>}
      </fieldset>
      <Button type="submit" variant="secondary" pending={pending}>
        Assign
      </Button>
    </form>
  );
}
