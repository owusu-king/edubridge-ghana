"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { useFormAction } from "@/components/ui/use-form-action";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

/**
 * One comment per student for a subject. Each carries what the page showed, so a comment someone else
 * changed meanwhile is not overwritten. After a save the page shows the stored comments again.
 */
export function CommentsForm({
  action,
  version,
  students,
  max,
}: {
  action: Action;
  /** Changes when the stored comments change, so the boxes start from them again. */
  version: string;
  students: { id: string; name: string; admissionNumber: string; comment: string; locked: boolean }[];
  max: number;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  return (
    <form key={version} onSubmit={onSubmit} className="space-y-4" noValidate>
      {state.status !== "idle" && state.message && <FormMessage state={state} />}
      <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
        {students.map((s) => (
          <CommentRow key={s.id} student={s} max={max} />
        ))}
      </ul>
      <div className="sticky bottom-0 -mx-4 flex justify-end border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
        <Button type="submit" pending={pending}>
          Save comments
        </Button>
      </div>
    </form>
  );
}

function CommentRow({
  student,
  max,
}: {
  student: { id: string; name: string; admissionNumber: string; comment: string; locked: boolean };
  max: number;
}) {
  const [value, setValue] = useState(student.comment);
  const id = `comment-${student.id}`;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id}>
          <span className="font-medium text-ink">{student.name}</span>{" "}
          <span className="text-sm text-ink-3">{student.admissionNumber}</span>
        </label>
        {student.locked ? (
          <Badge tone="neutral">Report card published</Badge>
        ) : (
          <span className={value.length > max ? "text-sm text-critical" : "text-sm text-ink-3"}>
            {value.length}/{max}
          </span>
        )}
      </div>
      <input type="hidden" name={`o:${student.id}`} value={student.comment} />
      <Textarea
        id={id}
        name={`c:${student.id}`}
        rows={2}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={student.locked}
        placeholder="A sentence or two on progress and next steps"
      />
    </li>
  );
}
