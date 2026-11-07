"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import type { VerifyState } from "./actions";

export function VerifyForm({
  action,
}: {
  action: (prev: VerifyState, formData: FormData) => Promise<VerifyState>;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as VerifyState);
  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5">
        <Field label="Record file (.json)">
          {(p) => <Input {...p} name="file" type="file" accept="application/json,.json" />}
        </Field>
        <Field label="Or paste the file's contents">{(p) => <Textarea {...p} name="text" rows={4} />}</Field>
        <Button type="submit" pending={pending}>
          Check record
        </Button>
      </form>
      <div aria-live="polite">
        {state.status === "valid" && (
          <Alert tone="positive">
            <strong>Genuine.</strong> Issued by {state.issuer} for {state.student}
            {state.issuedAt
              ? ` on ${new Date(state.issuedAt).toLocaleDateString("en-GB", { dateStyle: "long" })}`
              : ""}
            , and not changed since.
            {state.development ? " (Signed with a development key: for testing only.)" : ""}
          </Alert>
        )}
        {state.status === "revoked" && (
          <Alert tone="critical">
            <strong>Revoked.</strong> {state.issuer} withdrew this record
            {state.message ? `: ${state.message}` : "."}
          </Alert>
        )}
        {state.status === "unsigned" && (
          <Alert tone="info">
            <strong>Not signed.</strong> This file says it is from {state.issuer} for {state.student}, but it
            carries no EduBridge signature, so it cannot be checked.
          </Alert>
        )}
        {state.status === "invalid" && (
          <Alert tone="critical">
            <strong>Not genuine.</strong> {state.message}
          </Alert>
        )}
      </div>
    </div>
  );
}
