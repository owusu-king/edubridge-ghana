/**
 * School events and consent forms (EVT-01, CNS-01): shared by the server and screens. Framework-free and
 * browser-safe. Event dates and times are the school's own (local), stored without a time zone.
 */

/** How families are reminded before an event: not at all, by push only, or by push and SMS to the rest. */
export const EVENT_REMINDERS = ["none", "push", "sms"] as const;
export type EventReminder = (typeof EVENT_REMINDERS)[number];

export const EVENT_REMINDER_LABELS: Record<EventReminder, string> = {
  none: "No reminder",
  push: "Notification to families who have them on (free)",
  sms: "Notification, and SMS to the other families",
};

/** Reminders go this many days before (1 = the day before). */
export const REMINDER_DAYS = [1, 2, 3, 7] as const;

/** Reminders are sent from this hour, school time, so no one gets an SMS at night. */
export const EVENT_REMINDER_HOUR = 9;

export const CONSENT_ANSWERS = ["yes", "no"] as const;
export type ConsentAnswer = (typeof CONSENT_ANSWERS)[number];

export const CONSENT_ANSWER_LABELS: Record<ConsentAnswer, string> = { yes: "Yes", no: "No" };

/** A reminder about a consent form goes to the same families at most once in this many hours. */
export const CONSENT_REMINDER_HOURS = 24;

export const EVENT_LIMITS = { title: 100, details: 2000, location: 120 } as const;
export const CONSENT_LIMITS = { title: 100, body: 4000, note: 300 } as const;

export interface EventWhen {
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
}

const LOCALE = "en-GH";
const day = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(LOCALE, { ...opts, timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

/**
 * When an event is, in words: "Sat 15 Nov 2026, 10:00 to 12:00", or "Mon 3 to Fri 7 Mar 2027" for several
 * days. Short enough for an SMS.
 */
export function formatEventWhen(e: EventWhen): string {
  const full = { weekday: "short", day: "numeric", month: "short", year: "numeric" } as const;
  if (e.startsOn === e.endsOn) {
    const times = e.startTime ? `, ${e.startTime}${e.endTime ? ` to ${e.endTime}` : ""}` : "";
    return `${day(e.startsOn, full)}${times}`;
  }
  const sameYear = e.startsOn.slice(0, 4) === e.endsOn.slice(0, 4);
  const sameMonth = sameYear && e.startsOn.slice(5, 7) === e.endsOn.slice(5, 7);
  const first = day(
    e.startsOn,
    sameMonth
      ? { weekday: "short", day: "numeric" }
      : sameYear
        ? { weekday: "short", day: "numeric", month: "short" }
        : full,
  );
  const start = e.startTime ? ` ${e.startTime}` : "";
  return `${first}${start} to ${day(e.endsOn, full)}${e.endTime ? ` ${e.endTime}` : ""}`;
}

/** The day reminders go out: `days` before the start. */
export function reminderDate(startsOn: string, days: number): string {
  const d = new Date(`${startsOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** "2026-11" for grouping events by month, and its heading ("November 2026"). */
export function monthOf(iso: string): { key: string; label: string } {
  return { key: iso.slice(0, 7), label: day(iso, { month: "long", year: "numeric" }) };
}

/** Answers are accepted until the end of the deadline day, school time. */
export function consentOpen(deadline: string, today: string, cancelled: boolean): boolean {
  return !cancelled && today <= deadline;
}
