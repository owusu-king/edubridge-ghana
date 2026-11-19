"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import type { FormState } from "@/web/forms";
import { SuccessToast } from "@/components/ui/toast";

const buttonClass =
  "inline-flex h-11 min-w-24 items-center justify-center rounded-lg px-4 text-base font-medium disabled:opacity-60";

/** Yes or no for one child, with an optional note (large targets, one tap each). */
export function ConsentAnswer({
  action,
  child,
  current,
  note,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  child: string;
  /** The answer that counts now, if any. */
  current: "yes" | "no" | null;
  note: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-3">
      {state.status === "error" && <Alert tone="critical">{state.message}</Alert>}
      <SuccessToast state={state} />
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-ink">Note for the school (optional)</span>
        <input
          name="note"
          maxLength={300}
          defaultValue={state.values?.note ?? note ?? ""}
          placeholder="For example an allergy, or who will collect"
          className="block h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          name="answer"
          value="yes"
          disabled={pending}
          aria-label={`Yes for ${child}`}
          className={`${buttonClass} bg-accent text-white hover:bg-accent/90`}
        >
          {current === "no" ? "Change to yes" : "Yes"}
        </button>
        <button
          type="submit"
          name="answer"
          value="no"
          disabled={pending}
          aria-label={`No for ${child}`}
          className={`${buttonClass} border border-line-strong bg-surface text-ink hover:bg-subtle`}
        >
          {current === "yes" ? "Change to no" : "No"}
        </button>
      </div>
    </form>
  );
}
