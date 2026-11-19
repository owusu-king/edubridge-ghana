"use client";

import { useState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import type { FormState } from "@/web/forms";
import {
  CONSENT_LIMITS,
  EVENT_LIMITS,
  EVENT_REMINDER_LABELS,
  EVENT_REMINDERS,
  formatEventWhen,
  REMINDER_DAYS,
} from "@/lib/events";
import { consentRequestSms } from "@/lib/fee-messages";
import { formatMoney } from "@/lib/money";
import { smsSegments } from "@/lib/sms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface AudienceChoice {
  value: string;
  label: string;
  families: number;
  /** Families with notifications on: told on their phones at no cost. */
  withPush: number;
}

export interface EventValues {
  title: string;
  details: string | null;
  location: string | null;
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
  audience: string;
  reminder: string;
  reminderDaysBefore: number;
}

function EventFields({
  state,
  values,
  audiences,
  smsPaused,
}: {
  state: FormState;
  values?: EventValues;
  audiences: AudienceChoice[];
  smsPaused: boolean;
}) {
  const errors = state.fieldErrors ?? {};
  const v = (k: keyof EventValues, fallback = "") => String(state.values?.[k] ?? values?.[k] ?? fallback);
  const [reminder, setReminder] = useState(v("reminder", "none"));
  return (
    <div className="space-y-5">
      <Field label="Event" error={errors.title}>
        {(p) => (
          <Input {...p} name="title" maxLength={EVENT_LIMITS.title} defaultValue={v("title")} required />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Day" error={errors.startsOn}>
          {(p) => <Input {...p} type="date" name="startsOn" defaultValue={v("startsOn")} required />}
        </Field>
        <Field label="Last day (if several)" error={errors.endsOn}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="endsOn"
              defaultValue={
                values && values.endsOn !== values.startsOn ? values.endsOn : (state.values?.endsOn ?? "")
              }
            />
          )}
        </Field>
        <Field label="Starts at" optional error={errors.startTime}>
          {(p) => <Input {...p} type="time" name="startTime" defaultValue={v("startTime")} />}
        </Field>
        <Field label="Ends at" optional error={errors.endTime}>
          {(p) => <Input {...p} type="time" name="endTime" defaultValue={v("endTime")} />}
        </Field>
      </div>
      <Field label="Place" optional error={errors.location}>
        {(p) => (
          <Input {...p} name="location" maxLength={EVENT_LIMITS.location} defaultValue={v("location")} />
        )}
      </Field>
      <Field label="Details" optional error={errors.details}>
        {(p) => (
          <Textarea
            {...p}
            name="details"
            rows={4}
            maxLength={EVENT_LIMITS.details}
            defaultValue={v("details")}
          />
        )}
      </Field>
      <Field label="For" error={errors.audience}>
        {(p) => (
          <Select {...p} name="audience" defaultValue={v("audience", audiences[0]?.value ?? "school:")}>
            {audiences.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field
          label="Remind families"
          description={
            reminder === "sms"
              ? smsPaused
                ? "SMS are paused while an EduBridge invoice is overdue; only notifications will go."
                : "Each SMS is charged like any other. If the plan's SMS run out, only notifications go."
              : undefined
          }
          error={errors.reminder}
        >
          {(p) => (
            <Select {...p} name="reminder" value={reminder} onChange={(e) => setReminder(e.target.value)}>
              {EVENT_REMINDERS.map((r) => (
                <option key={r} value={r}>
                  {EVENT_REMINDER_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {reminder !== "none" && (
          <Field label="When" error={errors.reminderDaysBefore}>
            {(p) => (
              <Select {...p} name="reminderDaysBefore" defaultValue={v("reminderDaysBefore", "1")}>
                {REMINDER_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "The day before" : `${d} days before`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
    </div>
  );
}

export function NewEventDialog({
  action,
  audiences,
  smsPaused,
}: {
  action: Action;
  audiences: AudienceChoice[];
  smsPaused: boolean;
}) {
  return (
    <FormDialog
      trigger="New event"
      triggerVariant="primary"
      title="New event"
      description="Families see it in the parent view, for the children it is for."
      submitLabel="Add event"
      size="lg"
      action={action}
    >
      {(state) => <EventFields state={state} audiences={audiences} smsPaused={smsPaused} />}
    </FormDialog>
  );
}

export function EditEventDialog({
  action,
  audiences,
  values,
  smsPaused,
}: {
  action: Action;
  audiences: AudienceChoice[];
  values: EventValues;
  smsPaused: boolean;
}) {
  return (
    <FormDialog
      trigger="Edit"
      triggerSize="sm"
      triggerLabel={`Edit ${values.title}`}
      title="Edit event"
      description="A new day or reminder means the reminder goes again on its new day."
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => <EventFields state={state} values={values} audiences={audiences} smsPaused={smsPaused} />}
    </FormDialog>
  );
}

export function CancelEventDialog({
  action,
  title,
  forms,
}: {
  action: Action;
  title: string;
  forms: number;
}) {
  return (
    <FormDialog
      trigger="Cancel"
      triggerSize="sm"
      triggerVariant="ghost"
      triggerLabel={`Cancel ${title}`}
      title={`Cancel ${title}?`}
      description={
        forms
          ? "Families see that it is cancelled. Its consent forms close too and take no more answers."
          : "Families see that it is cancelled. This cannot be undone; add it again if it is back on."
      }
      submitLabel="Cancel the event"
      danger
      action={action}
    />
  );
}

export interface EventChoice {
  id: string;
  label: string;
  /** The event's audience, chosen for the form when the event is. */
  audience: string;
}

export function NewConsentFormDialog({
  action,
  audiences,
  events,
  schoolName,
  smsLink,
  currency,
  smsPricePesewas,
  smsPaused,
  eventId,
}: {
  action: Action;
  audiences: AudienceChoice[];
  events: EventChoice[];
  schoolName: string;
  smsLink: string;
  currency: string;
  smsPricePesewas: number | null;
  smsPaused: boolean;
  /** Arrived from an event's "Ask for consent": open, attached to it. */
  eventId?: string;
}) {
  return (
    <FormDialog
      trigger="New consent form"
      triggerVariant="primary"
      defaultOpen={Boolean(eventId)}
      title="New consent form"
      description="Families answer yes or no for each child in the parent view. The wording cannot be changed once it is sent."
      submitLabel="Send the form"
      size="lg"
      action={action}
    >
      {(state) => (
        <ConsentFields
          state={state}
          audiences={audiences}
          events={events}
          schoolName={schoolName}
          smsLink={smsLink}
          currency={currency}
          price={smsPricePesewas}
          paused={smsPaused}
          eventId={eventId}
        />
      )}
    </FormDialog>
  );
}

function ConsentFields({
  state,
  audiences,
  events,
  schoolName,
  smsLink,
  currency,
  price,
  paused,
  eventId,
}: {
  state: FormState;
  audiences: AudienceChoice[];
  events: EventChoice[];
  schoolName: string;
  smsLink: string;
  currency: string;
  price: number | null;
  paused: boolean;
  eventId?: string;
}) {
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  const initialEvent = events.find((e) => e.id === (v?.eventId ?? eventId));
  const [event, setEvent] = useState(initialEvent?.id ?? "");
  const [audience, setAudience] = useState(
    v?.audience ?? initialEvent?.audience ?? audiences[0]?.value ?? "school:",
  );
  const [title, setTitle] = useState(v?.title ?? "");
  const [deadline, setDeadline] = useState(v?.deadline ?? "");
  const chosen = audiences.find((a) => a.value === audience);
  const bySms = (chosen?.families ?? 0) - (chosen?.withPush ?? 0);
  const perFamily = smsSegments(
    consentRequestSms({
      schoolName,
      title,
      deadline: deadline
        ? formatEventWhen({ startsOn: deadline, endsOn: deadline, startTime: null, endTime: null })
        : "Fri 20 Nov 2026",
      link: smsLink,
    }),
  );
  const cost = price === null ? null : formatMoney(price * bySms * perFamily, currency);
  return (
    <div className="space-y-5">
      <Field label="Title" error={errors.title}>
        {(p) => (
          <Input
            {...p}
            name="title"
            maxLength={CONSENT_LIMITS.title}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        )}
      </Field>
      <Field
        label="What families are agreeing to"
        description="Your school's own wording: what happens, where, any cost, and who to contact."
        error={errors.body}
      >
        {(p) => (
          <Textarea
            {...p}
            name="body"
            rows={7}
            maxLength={CONSENT_LIMITS.body}
            defaultValue={v?.body}
            required
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Last day for answers" error={errors.deadline}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="deadline"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="For the event" optional error={errors.eventId}>
          {(p) => (
            <Select
              {...p}
              name="eventId"
              value={event}
              onChange={(e) => {
                setEvent(e.target.value);
                const picked = events.find((x) => x.id === e.target.value);
                if (picked) setAudience(picked.audience);
              }}
            >
              <option value="">No event</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
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
      {(chosen?.withPush ?? 0) > 0 && (
        <p className="text-sm text-ink-2">
          {chosen!.withPush} {chosen!.withPush === 1 ? "family has" : "families have"} notifications on and
          will be told on their phones, at no cost.
        </p>
      )}
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="sms"
          disabled={paused || bySms === 0}
          defaultChecked={v?.sms === "on"}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          Also tell the other families by SMS
          <span className="block text-sm text-ink-3">
            {paused
              ? "SMS are paused while an EduBridge invoice is overdue."
              : bySms === 0
                ? "Every family here has notifications on, so no SMS is needed."
                : `${perFamily === 1 ? "One SMS" : `${perFamily} SMS`} to each of ${bySms} ${bySms === 1 ? "family" : "families"}, with the title, the deadline and a link${
                    cost !== null ? `: about ${cost}` : ""
                  }.`}
          </span>
        </span>
      </label>
    </div>
  );
}

export function DeadlineDialog({ action, deadline }: { action: Action; deadline: string }) {
  return (
    <FormDialog
      trigger="Change deadline"
      triggerSize="sm"
      title="Change the deadline"
      description="Answers are taken until the end of this day. The wording of the form stays as it is."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <Field label="Last day for answers" error={state.fieldErrors?.deadline}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="deadline"
              defaultValue={state.values?.deadline ?? deadline}
              required
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function RemindDialog({
  action,
  waiting,
  smsPaused,
}: {
  action: Action;
  waiting: number;
  smsPaused: boolean;
}) {
  return (
    <FormDialog
      trigger="Remind families"
      triggerSize="sm"
      title="Remind families who have not answered"
      description={`The families of ${waiting} ${waiting === 1 ? "child" : "children"}. Those with notifications on are told on their phones at no cost. Once a day at most.`}
      submitLabel="Send reminder"
      action={action}
    >
      {(state) => (
        <label className="flex items-start gap-3 text-base text-ink">
          <input
            type="checkbox"
            name="sms"
            disabled={smsPaused}
            defaultChecked={state.values?.sms === "on"}
            className="mt-1 size-4 accent-accent"
          />
          <span>
            Also by SMS to the others
            <span className="block text-sm text-ink-3">
              {smsPaused
                ? "SMS are paused while an EduBridge invoice is overdue."
                : "One SMS each, charged like any other."}
            </span>
          </span>
        </label>
      )}
    </FormDialog>
  );
}

export function PaperAnswerDialog({
  action,
  child,
  guardians,
}: {
  action: Action;
  child: string;
  guardians: { id: string; name: string }[];
}) {
  return (
    <FormDialog
      trigger="Record paper slip"
      triggerSize="sm"
      triggerVariant="ghost"
      triggerLabel={`Record a paper answer for ${child}`}
      title={`Paper answer for ${child}`}
      description="For a signed slip brought to school. It is recorded under your name, and the latest answer counts."
      submitLabel="Record answer"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="Signed by" error={state.fieldErrors?.guardianId}>
            {(p) => (
              <Select {...p} name="guardianId" defaultValue={state.values?.guardianId ?? guardians[0]?.id}>
                {guardians.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Answer" error={state.fieldErrors?.answer}>
            {(p) => (
              <Select {...p} name="answer" defaultValue={state.values?.answer ?? "yes"}>
                <option value="yes">Yes, they agree</option>
                <option value="no">No</option>
              </Select>
            )}
          </Field>
          <Field label="Note from the slip" optional error={state.fieldErrors?.note}>
            {(p) => (
              <Input {...p} name="note" maxLength={CONSENT_LIMITS.note} defaultValue={state.values?.note} />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function CancelFormDialog({ action, title }: { action: Action; title: string }) {
  return (
    <FormDialog
      trigger="Cancel form"
      triggerSize="sm"
      triggerVariant="ghost"
      title={`Cancel ${title}?`}
      description="Families can no longer answer it. The answers given so far are kept."
      submitLabel="Cancel the form"
      danger
      action={action}
    />
  );
}
