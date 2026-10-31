"use client";

import { startTransition, useActionState, type FormEvent } from "react";
import type { FormState } from "@/web/forms";

/**
 * Binds a form to a server action without React's automatic post-submit form reset, so every field —
 * including selects and checkboxes — keeps what the person entered when validation fails.
 * Spread `onSubmit` onto the <form> instead of passing `action`.
 */
export function useFormAction<T = undefined>(
  action: (prev: FormState<T>, formData: FormData) => Promise<FormState<T>>,
  initial: FormState<T> = { status: "idle" },
) {
  const [state, dispatch, pending] = useActionState(action, initial);
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }
  return { state, pending, onSubmit };
}
