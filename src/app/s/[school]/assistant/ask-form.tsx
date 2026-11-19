"use client";

import type { Route } from "next";
import Link from "next/link";
import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import type { AssistantAnswer } from "@/server/assistant/service";
import type { FormState } from "@/web/forms";

const EXAMPLES = [
  "Which students have declining results?",
  "Which classes have the highest absenteeism this term?",
  "How much have we collected this term?",
  "Which students owe the most?",
  "Compare Basic 5 across the last three terms.",
  "Which teachers have not finished entering marks?",
];

/** Asking the assistant; the answer comes with the pages its figures came from. */
export function AskForm({
  action,
  schoolPath,
}: {
  action: (prev: FormState<AssistantAnswer>, formData: FormData) => Promise<FormState<AssistantAnswer>>;
  /** The school's address, e.g. "/s/kpone-ridge", for the source links. */
  schoolPath: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    status: "idle",
  } as FormState<AssistantAnswer>);
  const answer = state.status === "success" ? state.data : undefined;
  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-4">
        <Field label="Your question" error={state.fieldErrors?.question}>
          {(p) => (
            <Textarea
              {...p}
              name="question"
              rows={3}
              maxLength={500}
              defaultValue={state.values?.question}
              required
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" pending={pending}>
            Ask
          </Button>
          <p className="text-sm text-ink-3">For example: {EXAMPLES.slice(0, 3).join(" · ")}</p>
        </div>
      </form>
      <div aria-live="polite">
        {state.status === "error" && state.message && !state.fieldErrors?.question && (
          <Alert tone="critical">{state.message}</Alert>
        )}
        {answer && (
          <section aria-label="Answer" className="space-y-3 border-l-2 border-accent pl-4">
            <p className="text-base whitespace-pre-line text-ink">{answer.answer}</p>
            {answer.uncheckedFigures.length > 0 && (
              <Alert tone="info">
                Could not be checked against the records: {answer.uncheckedFigures.join(", ")}. The assistant
                may have worked these out itself; check them on the pages below before relying on them.
              </Alert>
            )}
            {answer.sources.length > 0 && (
              <p className="text-sm text-ink-3">
                From:{" "}
                {answer.sources.map((s, i) => (
                  <span key={s.label}>
                    {i > 0 && " · "}
                    <Link
                      href={(s.path ? `${schoolPath}/${s.path}` : schoolPath) as Route}
                      className="text-accent hover:underline"
                    >
                      {s.label}
                    </Link>
                  </span>
                ))}
                . Check the figures there.
              </p>
            )}
          </section>
        )}
      </div>
      <details className="text-sm text-ink-2">
        <summary className="cursor-pointer text-accent">More example questions</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {EXAMPLES.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
