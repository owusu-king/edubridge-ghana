"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { contrastRatio, isAccessibleAccent } from "@/lib/branding";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <FormMessage state={state} />;
}

/** The school's accent colour, with a live readability check (WCAG AA). */
export function BrandColorForm({ action, color }: { action: Action; color: string | null }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [value, setValue] = useState(color ?? "#24467a");
  const ok = isAccessibleAccent(value);
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <Message state={state} />
      <div className="flex flex-wrap items-end gap-4">
        <label className="space-y-1.5 text-sm font-medium text-ink">
          <span className="block">Accent colour</span>
          <input
            type="color"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-10 w-16 cursor-pointer rounded-md border border-line-strong bg-surface"
            aria-label="Pick the accent colour"
          />
        </label>
        <Field label="Hex code" error={state.fieldErrors?.brandColor}>
          {(p) => (
            <Input
              {...p}
              name="brandColor"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={7}
              className="w-32 font-mono"
            />
          )}
        </Field>
        <span
          className="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium text-[#fff]"
          style={{ background: /^#[0-9a-f]{6}$/i.test(value) ? value : "#24467a" }}
        >
          Example button
        </span>
      </div>
      <p className={ok ? "text-sm text-ink-3" : "text-sm text-critical"}>
        {/^#[0-9a-f]{6}$/i.test(value)
          ? `Contrast with white ${contrastRatio(value, "#ffffff")}:1 ${ok ? "(readable)" : "(too light: needs at least 4.5:1)"}`
          : "Enter a colour like #24467a."}
      </p>
      <div className="flex gap-3">
        <Button type="submit" variant="secondary" pending={pending} disabled={!ok}>
          Save colour
        </Button>
        <Button type="submit" variant="ghost" name="brandColor" value="" onClick={() => setValue("#24467a")}>
          Use EduBridge blue
        </Button>
      </div>
    </form>
  );
}

export function AdmissionFormatForm({
  action,
  prefix,
  digits,
}: {
  action: Action;
  prefix: string;
  digits: number;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [p, setP] = useState(prefix);
  const [d, setD] = useState(String(digits));
  const n = Math.min(8, Math.max(3, Number(d) || 4));
  return (
    <form action={formAction} className="max-w-xl space-y-4">
      <Message state={state} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Prefix" optional error={state.fieldErrors?.admissionPrefix}>
          {(props) => (
            <Input
              {...props}
              name="admissionPrefix"
              value={p}
              onChange={(e) => setP(e.target.value)}
              maxLength={10}
              placeholder="e.g. KR/"
            />
          )}
        </Field>
        <Field label="Digits" error={state.fieldErrors?.admissionDigits}>
          {(props) => (
            <Input
              {...props}
              name="admissionDigits"
              type="number"
              min={3}
              max={8}
              value={d}
              onChange={(e) => setD(e.target.value)}
            />
          )}
        </Field>
      </div>
      <p className="text-sm text-ink-3">
        The next numbers look like{" "}
        <span className="font-mono">
          {p}
          {"1".padStart(n, "0")}
        </span>
        . Numbers already given do not change.
      </p>
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}
