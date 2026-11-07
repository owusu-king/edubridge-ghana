"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import type { FormState } from "@/web/forms";

const buttonClass =
  "inline-flex h-11 items-center justify-center rounded-lg px-4 text-base font-medium disabled:opacity-60";

/** Allow or refuse a school's request for a child's records (one tap each, large targets). */
export function ConsentButtons({
  allow,
  refuse,
  child,
}: {
  allow: (prev: FormState) => Promise<FormState>;
  refuse: (prev: FormState) => Promise<FormState>;
  child: string;
}) {
  const [allowState, allowAction, allowing] = useActionState(allow, { status: "idle" } as FormState);
  const [refuseState, refuseAction, refusing] = useActionState(refuse, { status: "idle" } as FormState);
  const state = allowState.status !== "idle" ? allowState : refuseState;
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  return (
    <div className="space-y-2">
      {state.status === "error" && <Alert tone="critical">{state.message}</Alert>}
      <div className="flex flex-wrap gap-2">
        <form action={allowAction}>
          <button
            type="submit"
            disabled={allowing || refusing}
            className={`${buttonClass} bg-accent text-white hover:bg-accent/90`}
            aria-label={`Allow the records of ${child} to be sent`}
          >
            Allow
          </button>
        </form>
        <form action={refuseAction}>
          <button
            type="submit"
            disabled={allowing || refusing}
            className={`${buttonClass} border border-line-strong bg-surface text-ink hover:bg-subtle`}
            aria-label={`Refuse to send the records of ${child}`}
          >
            Refuse
          </button>
        </form>
      </div>
    </div>
  );
}

/** Moving a child to another school on EduBridge, from the child's page. */
export function MoveSchoolForm({
  action,
  schools,
  child,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  schools: { id: string; name: string }[];
  child: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  if (state.status === "success") return <Alert tone="positive">{state.message}</Alert>;
  return (
    <form action={formAction} className="space-y-3">
      {state.status === "error" && <Alert tone="critical">{state.message}</Alert>}
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-ink">New school</span>
        <select
          name="toSchoolId"
          required
          defaultValue=""
          className="block h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink"
        >
          <option value="" disabled>
            Choose the school
          </option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-ink-3">
        By sending this you agree that {child}&apos;s records (classes, report cards, attendance and
        guardians) are sent to the new school once this school approves.
      </p>
      <button
        type="submit"
        disabled={pending}
        className={`${buttonClass} border border-line-strong bg-surface text-ink hover:bg-subtle`}
      >
        Ask to move {child}
      </button>
    </form>
  );
}
