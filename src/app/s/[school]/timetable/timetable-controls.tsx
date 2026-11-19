"use client";

import { Plus } from "lucide-react";
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { LessonText, TimetableGrid, type GridPeriod } from "@/components/timetable/timetable-grid";
import { cn } from "@/lib/cn";
import { WEEKDAY_NAMES } from "@/lib/timetable";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/** Adds a period to the school day, or changes one. */
export function PeriodDialog({ action, period }: { action: Action; period?: GridPeriod }) {
  return (
    <FormDialog
      trigger={period ? "Edit" : "Add period"}
      triggerVariant={period ? "ghost" : "secondary"}
      triggerSize="sm"
      triggerLabel={period ? `Edit ${period.name}` : undefined}
      title={period ? `Edit ${period.name}` : "Add a period"}
      description="Times are the school's local time. Periods may not overlap."
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const errors = state.fieldErrors ?? {};
        const v = (name: keyof GridPeriod) => state.values?.[name] ?? period?.[name] ?? "";
        return (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" error={errors.name} className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={40}
                  defaultValue={v("name")}
                  placeholder="Period 1"
                  required
                />
              )}
            </Field>
            <Field label="Starts" error={errors.startsAt}>
              {(p) => <Input {...p} name="startsAt" type="time" defaultValue={v("startsAt")} required />}
            </Field>
            <Field label="Ends" error={errors.endsAt}>
              {(p) => <Input {...p} name="endsAt" type="time" defaultValue={v("endsAt")} required />}
            </Field>
            <Field label="Kind" error={errors.kind} className="sm:col-span-2">
              {(p) => (
                <Select {...p} name="kind" defaultValue={v("kind") || "lesson"}>
                  <option value="lesson">Lesson</option>
                  <option value="break">Break (no lessons)</option>
                </Select>
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Copies another term's timetables into this term (classes already planned are left alone). */
export function CopyTimetableForm({
  action,
  terms,
}: {
  action: Action;
  terms: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-2xl space-y-3">
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Copy from" error={state.fieldErrors?.fromTermId}>
          {(p) => (
            <Select {...p} name="fromTermId" defaultValue={terms[0]?.id} className="min-w-56">
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary" pending={pending}>
          Copy timetables
        </Button>
      </div>
    </form>
  );
}

export interface EditorLesson {
  weekday: number;
  periodId: string;
  subjectId: string;
  subjectName: string;
  membershipId: string | null;
  teacherName: string | null;
}

/**
 * A class's timetable that academic staff edit in place: each slot opens one dialog to choose the subject
 * and teacher (suggested from the subject or class teacher), or to clear it.
 */
export function ClassTimetableEditor({
  action,
  termId,
  classId,
  className,
  periods,
  lessons,
  subjects,
  teachers,
}: {
  action: Action;
  termId: string;
  classId: string;
  className: string;
  periods: GridPeriod[];
  lessons: EditorLesson[];
  subjects: { id: string; name: string; suggestedTeacher: string | null }[];
  teachers: { membershipId: string; name: string }[];
}) {
  const [slot, setSlot] = useState<{ weekday: number; period: GridPeriod } | null>(null);
  const find = (weekday: number, periodId: string) =>
    lessons.find((l) => l.weekday === weekday && l.periodId === periodId);
  return (
    <>
      <TimetableGrid
        periods={periods}
        caption={`${className} timetable`}
        cell={(weekday, period) => {
          const lesson = find(weekday, period.id);
          return (
            <button
              type="button"
              onClick={() => setSlot({ weekday, period })}
              aria-label={`${WEEKDAY_NAMES[weekday]}, ${period.name}: ${lesson ? `${lesson.subjectName}, change` : "add a lesson"}`}
              className={cn(
                "block min-h-12 w-full rounded-md text-left transition-colors hover:bg-accent-soft focus-visible:outline-2 focus-visible:outline-accent/40",
                !lesson && "border border-dashed border-line-strong",
              )}
            >
              {lesson ? (
                <LessonText title={lesson.subjectName} detail={lesson.teacherName ?? "No teacher yet"} />
              ) : (
                <span className="flex h-12 items-center justify-center text-ink-3">
                  <Plus aria-hidden="true" className="size-4" />
                </span>
              )}
            </button>
          );
        }}
      />
      {slot && (
        <Dialog
          open
          onOpenChange={(open) => !open && setSlot(null)}
          title={`${WEEKDAY_NAMES[slot.weekday]}, ${slot.period.name}`}
          description={`${className}, ${slot.period.startsAt}–${slot.period.endsAt}`}
        >
          <LessonForm
            action={action}
            hidden={{ termId, classId, weekday: String(slot.weekday), periodId: slot.period.id }}
            lesson={find(slot.weekday, slot.period.id)}
            subjects={subjects}
            teachers={teachers}
            onDone={() => setSlot(null)}
          />
        </Dialog>
      )}
    </>
  );
}

function LessonForm({
  action,
  hidden,
  lesson,
  subjects,
  teachers,
  onDone,
}: {
  action: Action;
  hidden: Record<string, string>;
  lesson: EditorLesson | undefined;
  subjects: { id: string; name: string; suggestedTeacher: string | null }[];
  teachers: { membershipId: string; name: string }[];
  onDone: () => void;
}) {
  const [state, dispatch, pending] = useActionState(
    async (prev: FormState, formData: FormData) => {
      const result = await action(prev, formData);
      if (result.status === "success") onDone();
      return result;
    },
    { status: "idle" } as FormState,
  );
  // Built by hand so the button pressed (save or clear) goes with the form.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const formData = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(formData));
  }
  const [subjectId, setSubjectId] = useState(lesson?.subjectId ?? subjects[0]?.id ?? "");
  const [teacherId, setTeacherId] = useState(
    lesson ? (lesson.membershipId ?? "") : (subjects.find((s) => s.id === subjectId)?.suggestedTeacher ?? ""),
  );
  const errors = state.fieldErrors ?? {};
  if (subjects.length === 0)
    return (
      <p className="text-base text-ink-2">
        This class&apos;s level takes no subjects yet. Choose them under Assessment, Setup.
      </p>
    );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {state.status === "error" && state.message && !Object.keys(errors).length && (
        <Alert tone="critical">{state.message}</Alert>
      )}
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Field label="Subject" error={errors.subjectId}>
        {(p) => (
          <Select
            {...p}
            name="subjectId"
            value={subjectId}
            onChange={(e) => {
              setSubjectId(e.target.value);
              if (!lesson)
                setTeacherId(subjects.find((s) => s.id === e.target.value)?.suggestedTeacher ?? "");
            }}
          >
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Teacher"
        description="A teacher cannot be in two classes at the same time."
        error={errors.membershipId}
      >
        {(p) => (
          <Select {...p} name="membershipId" value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">No teacher yet</option>
            {teachers.map((t) => (
              <option key={t.membershipId} value={t.membershipId}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-5">
        {lesson ? (
          <Button type="submit" name="intent" value="clear" variant="ghost" disabled={pending}>
            Clear this lesson
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" name="intent" value="save" pending={pending}>
            Save lesson
          </Button>
        </div>
      </div>
    </form>
  );
}
