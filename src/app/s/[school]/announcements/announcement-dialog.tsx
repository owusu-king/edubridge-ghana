"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import { announcementSms } from "@/lib/fee-messages";
import { formatMoney } from "@/lib/money";
import { smsSegments } from "@/lib/sms";

export interface AudienceChoice {
  value: string;
  label: string;
  families: number;
  /** Families with notifications on: they get a free push instead of an SMS. */
  withPush: number;
}

/** AI drafting of the title and message from a few points (R5-5, DRF-02), where the school has it. */
export interface AnnouncementDrafting {
  available: boolean;
  message: string | null;
  draft: (
    points: string,
    audience: string,
  ) => Promise<{ ok: true; draftId: string; title: string; body: string } | { ok: false; message: string }>;
}

/** Writing an announcement, choosing who it is for, and (optionally) sending it by SMS. */
export function NewAnnouncementDialog({
  currency,
  schoolName,
  smsLink,
  action,
  audiences,
  smsPricePesewas,
  smsPaused,
  drafting = null,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  /** For working out how many SMS the announcement takes (the SMS carries the name, title and this link). */
  schoolName: string;
  smsLink: string;
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  audiences: AudienceChoice[];
  smsPricePesewas: number | null;
  /** True while SMS are paused for an overdue EduBridge invoice. */
  smsPaused: boolean;
  drafting?: AnnouncementDrafting | null;
}) {
  return (
    <FormDialog
      trigger="New announcement"
      triggerVariant="primary"
      title="New announcement"
      description="Families see it in the parent view. Announcements cannot be edited once posted."
      submitLabel="Post announcement"
      size="lg"
      action={action}
    >
      {(state) => (
        <Fields
          currency={currency}
          schoolName={schoolName}
          smsLink={smsLink}
          state={state}
          audiences={audiences}
          price={smsPricePesewas}
          paused={smsPaused}
          drafting={drafting}
        />
      )}
    </FormDialog>
  );
}

function Fields({
  currency,
  schoolName,
  smsLink,
  state,
  audiences,
  price,
  paused,
  drafting,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  schoolName: string;
  smsLink: string;
  state: FormState;
  audiences: AudienceChoice[];
  price: number | null;
  paused: boolean;
  drafting: AnnouncementDrafting | null;
}) {
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const [audience, setAudience] = useState(v?.audience ?? audiences[0]?.value ?? "school:");
  const [title, setTitle] = useState(v?.title ?? "");
  const [body, setBody] = useState(v?.body ?? "");
  const [draftId, setDraftId] = useState(v?.draftId ?? "");
  const [points, setPoints] = useState("");
  const [draftPending, startDrafting] = useTransition();
  const [draftError, setDraftError] = useState<string | null>(null);
  const [when, setWhen] = useState(v?.when === "later" ? "later" : "now");
  const chosen = audiences.find((a) => a.value === audience);
  const families = chosen?.families ?? 0;
  const withPush = chosen?.withPush ?? 0;
  const bySms = families - withPush;
  // Each family's SMS is the same text, so it takes the same number of SMS for everyone.
  const perFamily = smsSegments(announcementSms({ schoolName, title, link: smsLink }));
  const cost = price === null ? null : formatMoney(price * bySms * perFamily, currency);
  return (
    <div className="space-y-5">
      {drafting && (
        <details className="rounded-lg border border-line bg-subtle/50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            Draft it from a few points
          </summary>
          {drafting.available ? (
            <div className="mt-3 space-y-2">
              <Field
                label="What it should say"
                description="A few words or lines. They are sent as written to EduBridge's AI provider; the draft fills the title and message below for you to edit."
              >
                {(p) => (
                  <Textarea
                    {...p}
                    name="draftPoints"
                    rows={3}
                    maxLength={1000}
                    value={points}
                    onChange={(e) => setPoints(e.target.value)}
                  />
                )}
              </Field>
              {draftError && <p className="text-sm text-critical">{draftError}</p>}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                pending={draftPending}
                onClick={() =>
                  startDrafting(async () => {
                    setDraftError(null);
                    const r = await drafting.draft(points, chosen?.label ?? "Every family");
                    if (!r.ok) return setDraftError(r.message);
                    setTitle(r.title);
                    setBody(r.body);
                    setDraftId(r.draftId);
                  })
                }
              >
                Draft
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-3">Drafting is not available: {drafting.message}</p>
          )}
        </details>
      )}
      <input type="hidden" name="draftId" value={draftId} />
      <Field label="Title" error={errors.title}>
        {(p) => (
          <Input
            {...p}
            name="title"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        )}
      </Field>
      <Field label="Message" error={errors.body}>
        {(p) => (
          <Textarea
            {...p}
            name="body"
            rows={6}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
        )}
      </Field>
      <Field label="For" error={errors.audience}>
        {(p) => (
          <Select {...p} name="audience" value={audience} onChange={(e) => setAudience(e.target.value)}>
            {audiences.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label} ({a.families} {a.families === 1 ? "family" : "families"})
              </option>
            ))}
          </Select>
        )}
      </Field>
      {withPush > 0 && (
        <p className="text-sm text-ink-2">
          {withPush} {withPush === 1 ? "family has" : "families have"} notifications on and will be told on
          their phones, at no cost.
        </p>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">When</legend>
        <div className="flex flex-wrap gap-4 text-base text-ink">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="when"
              value="now"
              checked={when === "now"}
              onChange={() => setWhen("now")}
              className="size-4 accent-accent"
            />
            Post now
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="when"
              value="later"
              checked={when === "later"}
              onChange={() => setWhen("later")}
              className="size-4 accent-accent"
            />
            Schedule it
          </label>
        </div>
        {when === "later" && (
          <Field
            label="Post on"
            description="School time. Nothing is sent or charged until then."
            error={errors.sendAt}
          >
            {(p) => <Input {...p} type="datetime-local" name="sendAt" defaultValue={v?.sendAt} required />}
          </Field>
        )}
      </fieldset>
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="sms"
          disabled={paused || bySms === 0}
          defaultChecked={v?.sms === "on"}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          Also send by SMS
          <span className="block text-sm text-ink-3">
            {paused
              ? "SMS are paused while an EduBridge invoice is overdue."
              : bySms === 0
                ? "Every family here has notifications on, so no SMS is needed."
                : `${perFamily === 1 ? "One SMS" : `${perFamily} SMS (a long title takes more than one)`} to each of ${bySms} ${bySms === 1 ? "family" : "families"}, with the title and a link to read it${
                    cost !== null ? `: about ${cost}` : ""
                  }.`}
          </span>
        </span>
      </label>
    </div>
  );
}
