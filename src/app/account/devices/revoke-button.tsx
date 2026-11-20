"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/toast";
import type { FormState } from "@/web/forms";

/** Signs one device out of the API (its token stops working at once). */
export function RevokeDeviceButton({
  action,
  name,
}: {
  action: (prev: FormState) => Promise<FormState>;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction}>
      <Button
        type="submit"
        variant="danger-outline"
        size="sm"
        pending={pending}
        aria-label={`Sign out ${name}`}
      >
        Sign out
      </Button>
      <FormError state={state} />
    </form>
  );
}
