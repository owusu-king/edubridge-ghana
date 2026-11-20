"use client";

import { ArrowRight } from "lucide-react";
import { useActionState } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { FormError } from "@/components/ui/toast";
import type { FormState } from "@/web/forms";

/** "Try the demo school": opens a two-hour, view-only visit (server/demo/visit.ts). */
export function DemoButton({
  action,
  variant = "secondary",
  className = "h-11 px-5",
  label = "Try the demo school",
}: {
  action: (prev: FormState) => Promise<FormState>;
  variant?: ButtonVariant;
  /** Sized like the "Book a visit" button beside it. */
  className?: string;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="contents">
      <FormError state={state} />
      <Button type="submit" variant={variant} pending={pending} className={className}>
        {label}
        <ArrowRight aria-hidden="true" />
      </Button>
    </form>
  );
}
