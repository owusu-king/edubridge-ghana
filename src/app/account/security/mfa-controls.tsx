"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormError } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import type { FormState } from "@/web/forms";
import {
  beginMfaAction,
  confirmMfaAction,
  disableMfaAction,
  regenerateCodesAction,
  type EnrollmentData,
} from "../actions";

const idle = { status: "idle" } as const;

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const download = () => {
    const blob = new Blob([`EduBridge recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "edubridge-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-4">
      <Alert tone="info">
        Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be
        shown again.
      </Alert>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-line bg-canvas px-5 py-4 font-mono text-base sm:grid-cols-5"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={download}>
          Download codes
        </Button>
        {onDone && <Button onClick={onDone}>I have saved them</Button>}
      </div>
    </div>
  );
}

export function EnableMfa() {
  const router = useRouter();
  const [setup, startSetup, starting] = useActionState<FormState<EnrollmentData>, FormData>(
    beginMfaAction,
    idle,
  );
  const [confirm, confirmAction, confirming] = useActionState<FormState<string[]>, FormData>(
    confirmMfaAction,
    idle,
  );
  const [finished, setFinished] = useState(false);

  if (confirm.status === "success" && confirm.data && !finished) {
    return (
      <RecoveryCodes
        codes={confirm.data}
        onDone={() => {
          setFinished(true);
          router.refresh();
        }}
      />
    );
  }
  if (finished) return <Alert tone="positive">Two-step verification is on.</Alert>;

  if (setup.status !== "success" || !setup.data) {
    return (
      <form action={startSetup} className="space-y-4">
        <FormError state={setup} />
        <Button type="submit" pending={starting}>
          Set up two-step verification
        </Button>
      </form>
    );
  }
  const { secret, qrDataUri } = setup.data;
  return (
    <div className="space-y-6">
      <ol className="list-decimal space-y-2 pl-5 text-base text-ink-2">
        <li>Open an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.</li>
        <li>Scan this QR code, or enter the setup key.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* The QR code on the left; beside it the setup key at the top and the code field level with its foot. */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-stretch">
        {/* eslint-disable-next-line @next/next/no-img-element -- generated SVG data URI */}
        <img
          src={qrDataUri}
          alt="QR code for your authenticator app"
          width={176}
          height={176}
          className="shrink-0 self-start rounded-md border border-line bg-[#fff] p-3"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-6 sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm text-ink-3">Setup key</p>
            <p className="font-mono text-base break-all text-ink" data-testid="mfa-secret">
              {secret.match(/.{1,4}/g)?.join(" ")}
            </p>
          </div>
          <form
            action={confirmAction}
            className="flex max-w-sm flex-col gap-3 sm:flex-row sm:items-start"
            noValidate
          >
            <Field
              label="Code from your app"
              error={confirm.fieldErrors?.code ?? (confirm.status === "error" ? confirm.message : undefined)}
              className="flex-1"
            >
              {(p) => (
                <Input
                  {...p}
                  name="code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="font-mono tracking-widest"
                />
              )}
            </Field>
            <Button type="submit" pending={confirming} className="sm:mt-6.5">
              Turn on
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}

export function ManageMfa({ remaining }: { remaining: number }) {
  const [dialog, setDialog] = useState<"codes" | "disable" | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-base text-ink-2">
        {remaining} of 10 recovery codes left.{remaining <= 3 && " Create new codes soon."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setDialog("codes")}>
          New recovery codes
        </Button>
        <Button variant="danger-outline" onClick={() => setDialog("disable")}>
          Turn off
        </Button>
      </div>
      {dialog === "codes" && (
        <Dialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title="New recovery codes"
          description="Your current codes stop working."
        >
          <RegenerateForm onDone={() => setDialog(null)} />
        </Dialog>
      )}
      {dialog === "disable" && (
        <Dialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          title="Turn off two-step verification?"
          description="Your account will be protected by your password only."
        >
          <DisableForm onDone={() => setDialog(null)} />
        </Dialog>
      )}
    </div>
  );
}

function RegenerateForm({ onDone }: { onDone: () => void }) {
  const [state, action, pending] = useActionState<FormState<string[]>, FormData>(regenerateCodesAction, idle);
  if (state.status === "success" && state.data) return <RecoveryCodes codes={state.data} onDone={onDone} />;
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label="Code from your app" error={state.fieldErrors?.code}>
        {(p) => (
          <Input
            {...p}
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Create new codes
        </Button>
      </div>
    </form>
  );
}

function DisableForm({ onDone }: { onDone: () => void }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await disableMfaAction(prev, formData);
    if (result.status === "success") onDone();
    return result;
  }, idle);
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormError state={state} />
      <Field label="Password" error={state.fieldErrors?.password}>
        {(p) => (
          <Input {...p} name="password" type="password" required autoComplete="current-password" autoFocus />
        )}
      </Field>
      <Field label="Code from your app, or a recovery code" error={state.fieldErrors?.code}>
        {(p) => <Input {...p} name="code" required autoComplete="one-time-code" maxLength={16} />}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" pending={pending}>
          Turn off
        </Button>
      </div>
    </form>
  );
}
