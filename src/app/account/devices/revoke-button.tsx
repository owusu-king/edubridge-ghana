"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
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
      <Button type="submit" variant="secondary" size="sm" pending={pending} aria-label={`Sign out ${name}`}>
        Sign out
      </Button>
      {state.status === "error" && <p className="mt-1 text-sm text-critical">{state.message}</p>}
    </form>
  );
}
