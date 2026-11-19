"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  AI_LIMIT_RANGES,
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  AI_TASK_LABELS,
  AI_TASKS,
  type AiLimits,
  type AiProviderId,
  type AiTask,
} from "@/lib/ai-providers";
import type { FormState } from "@/web/forms";
import { FormMessage } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

function Message({ state }: { state: FormState }) {
  if (state.status === "idle" || !state.message) return null;
  return <FormMessage state={state} />;
}

export function AiSettingsForm({
  action,
  config,
}: {
  action: Action;
  config: {
    enabled: boolean;
    provider: AiProviderId;
    model: string;
    baseUrl: string | null;
    identifiableApproved: boolean;
    tasks: Record<AiTask, boolean>;
  };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [provider, setProvider] = useState<AiProviderId>(config.provider);
  const info = AI_PROVIDERS[provider];
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="max-w-xl space-y-5">
      <Message state={state} />
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={config.enabled}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          AI switched on for the platform
          <span className="block text-sm text-ink-3">
            The global switch. Off: every AI feature says it is not switched on, and nothing else changes.
          </span>
        </span>
      </label>
      {errors.enabled && <p className="text-sm text-critical">{errors.enabled}</p>}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">Features</legend>
        {AI_TASKS.map((task) => (
          <label key={task} className="flex items-center gap-3 text-base text-ink">
            <input
              type="checkbox"
              name={`task.${task}`}
              defaultChecked={config.tasks[task]}
              className="size-4 accent-accent"
            />
            {AI_TASK_LABELS[task]}
          </label>
        ))}
        <p className="text-sm text-ink-3">
          Each school still needs the feature in its plan and its Proprietor&apos;s consent.
        </p>
      </fieldset>
      <Field label="Provider" description={info.note} error={errors.provider}>
        {(p) => (
          <Select
            {...p}
            name="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as AiProviderId)}
          >
            {AI_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {AI_PROVIDERS[id].label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {provider !== "none" && (
        <Field label="Model" description="A model of this provider that can use tools." error={errors.model}>
          {(p) => (
            <>
              <Input
                {...p}
                name="model"
                list="ai-models"
                defaultValue={provider === config.provider ? config.model : (info.models[0] ?? "")}
                key={provider}
                spellCheck={false}
              />
              <datalist id="ai-models">
                {info.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </>
          )}
        </Field>
      )}
      {info.baseUrlEditable && (
        <Field
          label="Address"
          description="The provider's OpenAI-compatible API address."
          error={errors.baseUrl}
        >
          {(p) => (
            <Input
              {...p}
              name="baseUrl"
              key={provider}
              defaultValue={(provider === config.provider ? config.baseUrl : null) ?? info.baseUrl ?? ""}
              placeholder="https://"
              spellCheck={false}
            />
          )}
        </Field>
      )}
      {info.tier === "paid" ? (
        <label className="flex items-start gap-3 text-base text-ink">
          <input
            type="checkbox"
            name="identifiableApproved"
            defaultChecked={provider === config.provider && config.identifiableApproved}
            key={provider}
            className="mt-1 size-4 accent-accent"
          />
          <span>
            Approved for identifiable data
            <span className="block text-sm text-ink-3">
              Only after the data-protection review of this provider&apos;s terms, retention and data location
              (D-R5-7). Then each school&apos;s own choice about names applies. Changing provider withdraws
              it.
            </span>
          </span>
        </label>
      ) : provider !== "none" ? (
        <p className="text-sm text-ink-2">
          De-identified only: names, admission numbers, contact details and the school&apos;s name are never
          sent to this provider, whatever a school chooses.
        </p>
      ) : null}
      {errors.identifiableApproved && <p className="text-sm text-critical">{errors.identifiableApproved}</p>}
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}

const LIMIT_FIELDS: { key: keyof AiLimits; label: string; note: string }[] = [
  {
    key: "platformMonthlyTokens",
    label: "Platform, tokens a month",
    note: "Every school together. 0 stops all AI.",
  },
  {
    key: "schoolMonthlyTokens",
    label: "Each school, tokens a month",
    note: "Unless the school has its own allowance.",
  },
  { key: "userPerMinute", label: "Each person, requests a minute", note: "Throttles rapid repeats." },
  { key: "userPerHour", label: "Each person, requests an hour", note: "A request is one question." },
  { key: "userDailyTokens", label: "Each person, tokens a day", note: "In the school's time zone." },
  { key: "maxOutputTokens", label: "Output tokens per call", note: "Caps each answer's length." },
];

export function AiLimitsForm({ action, limits }: { action: Action; limits: AiLimits }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <Message state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        {LIMIT_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} description={f.note} error={state.fieldErrors?.[f.key]}>
            {(p) => (
              <Input
                {...p}
                type="number"
                name={f.key}
                min={AI_LIMIT_RANGES[f.key].min}
                max={AI_LIMIT_RANGES[f.key].max}
                defaultValue={state.values?.[f.key] ?? limits[f.key]}
              />
            )}
          </Field>
        ))}
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Save limits
      </Button>
    </form>
  );
}

export function ApiKeyForm({
  action,
  hasKey,
  provider,
}: {
  action: Action;
  hasKey: boolean;
  provider: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="max-w-xl space-y-4" autoComplete="off">
      <Message state={state} />
      <Field
        label={hasKey ? `Replace the ${provider} API key` : `${provider} API key`}
        error={state.fieldErrors?.apiKey}
      >
        {(p) => <Input {...p} name="apiKey" type="password" autoComplete="off" spellCheck={false} required />}
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        Save key
      </Button>
    </form>
  );
}

export function RemoveKeyDialog({
  action,
  provider,
}: {
  action: (prev: FormState) => Promise<FormState>;
  provider: string;
}) {
  return (
    <FormDialog
      trigger="Remove key"
      triggerSize="sm"
      title={`Remove the ${provider} API key?`}
      description="If this is the provider in use, AI is switched off for every school until a key is saved again."
      submitLabel="Remove key"
      danger
      action={action}
    >
      {() => <p className="text-base text-ink-2">Questions already asked stay in each school&apos;s log.</p>}
    </FormDialog>
  );
}

export function RotateKeyDialog({
  action,
  first,
}: {
  action: (prev: FormState) => Promise<FormState>;
  first: boolean;
}) {
  return (
    <FormDialog
      trigger={first ? "Create the signing key" : "Rotate the signing key"}
      triggerVariant={first ? "primary" : "secondary"}
      title={first ? "Create the signing key?" : "Rotate the signing key?"}
      description={
        first
          ? "A new Ed25519 key is generated on the server and stored encrypted. Learner records are signed with it from now on."
          : "A new key signs records from now on. The current key is retired: it signs nothing more, but every record it signed still verifies."
      }
      submitLabel={first ? "Create key" : "Rotate key"}
      action={action}
    >
      {() => (
        <p className="text-base text-ink-2">The private key never leaves the server and is never shown.</p>
      )}
    </FormDialog>
  );
}

/** A school's own AI allowance; empty fields keep the platform default (R5-4, AIG-03). */
export function SchoolAiLimitsForm({
  action,
  values,
  defaults,
}: {
  action: Action;
  values: { monthlyTokens: number | null; userPerHour: number | null; userDailyTokens: number | null };
  defaults: { monthlyTokens: number; userPerHour: number; userDailyTokens: number };
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const fields = [
    { key: "monthlyTokens", label: "Tokens a month", range: AI_LIMIT_RANGES.schoolMonthlyTokens },
    { key: "userPerHour", label: "Each person, requests an hour", range: AI_LIMIT_RANGES.userPerHour },
    { key: "userDailyTokens", label: "Each person, tokens a day", range: AI_LIMIT_RANGES.userDailyTokens },
  ] as const;
  return (
    <form action={formAction} className="max-w-2xl space-y-4">
      <Message state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        {fields.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            description={`Platform default: ${defaults[f.key].toLocaleString("en-GH")}`}
            optional
            error={state.fieldErrors?.[f.key]}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                name={f.key}
                min={f.range.min}
                max={f.range.max}
                defaultValue={state.values?.[f.key] ?? values[f.key] ?? ""}
              />
            )}
          </Field>
        ))}
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Save allowance
      </Button>
    </form>
  );
}
